import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    canonicalizeMinecraftUuid,
    createWhitelistHttpResult,
    createWhitelistSnapshot,
    parseServiceApiBearer,
    resolveMinecraftProfile,
    nextWhitelistRevision,
    verifyServiceApiKey,
    resolveMinecraftProfileByUuid
} from '../src/api/whitelist-contract.ts';

const uuid = '01234567-89ab-cdef-0123-456789abcdef';

test('service bearer parsing and hash verification reject missing, malformed, and wrong keys', () => {
    const apiKey = Buffer.alloc(48, 17).toString('base64');
    const tokenHash = createHash('sha256').update(apiKey).digest('hex');

    assert.equal(parseServiceApiBearer(`Bearer ${apiKey}`), apiKey);
    assert.equal(verifyServiceApiKey(apiKey, tokenHash), true);
    assert.equal(verifyServiceApiKey(`${apiKey.slice(0, -1)}A`, tokenHash), false);
    assert.equal(parseServiceApiBearer(`Bearer ${apiKey}=`), null);
    assert.equal(parseServiceApiBearer(''), null);
});

test('Minecraft UUIDs are canonicalized and invalid UUIDs are rejected', () => {
    assert.equal(canonicalizeMinecraftUuid('0123456789ABCDEF0123456789ABCDEF'), uuid);
    assert.equal(canonicalizeMinecraftUuid(uuid.toUpperCase()), uuid);
    assert.throws(() => canonicalizeMinecraftUuid('not-a-uuid'), /Ungültige Minecraft-UUID/);
});

test('whitelist snapshots preserve an empty list, deduplicate UUIDs and carry validated names', () => {
    assert.deepEqual(createWhitelistSnapshot(0, []), { revision: 0, players: [] });
    assert.deepEqual(
        createWhitelistSnapshot('42', [
            { uuid, name: 'Alex_1' },
            { uuid: uuid.toUpperCase(), name: 'Alex_1' },
            { uuid: 'fedcba98765432100123456789abcdef', name: 'Z' }
        ]),
        {
            revision: 42,
            players: [
                { uuid: '01234567-89ab-cdef-0123-456789abcdef', name: 'Alex_1' },
                { uuid: 'fedcba98-7654-3210-0123-456789abcdef', name: 'Z' }
            ]
        }
    );
    assert.throws(() => createWhitelistSnapshot(-1, []), /Ungültige Whitelist-Version/);
    assert.throws(() => createWhitelistSnapshot(1, [{ uuid, name: '' }]), /Ungültiger Minecraft-Name/);
    assert.throws(() => createWhitelistSnapshot(1, [{ uuid, name: 'bad name' }]), /Ungültiger Minecraft-Name/);
    assert.throws(() => createWhitelistSnapshot(1, [{ uuid, name: 'A'.repeat(17) }]), /Ungültiger Minecraft-Name/);
    assert.throws(() => createWhitelistSnapshot(1, [{ uuid: 'nope', name: 'Alex' }]), /Ungültige Minecraft-UUID/);
    assert.throws(
        () => createWhitelistSnapshot(1, [{ uuid, name: 'Alex' }, { uuid, name: 'Other' }]),
        /Widersprüchliche Namen/
    );
});

test('ETag returns the exact snapshot for changes and an empty body for a matching validator', () => {
    const snapshot = createWhitelistSnapshot(42, [{ uuid, name: 'Alex' }]);
    const initial = createWhitelistHttpResult(7, snapshot, undefined);
    assert.deepEqual(initial, {
        status: 200,
        etag: '"service-7-revision-42"',
        body: { revision: 42, players: [{ uuid, name: 'Alex' }] }
    });

    assert.deepEqual(
        createWhitelistHttpResult(7, snapshot, 'W/"service-7-revision-42"'),
        { status: 304, etag: '"service-7-revision-42"', body: null }
    );
    assert.equal(createWhitelistHttpResult(7, snapshot, '*').status, 304);
    assert.equal(createWhitelistHttpResult(8, snapshot, initial.etag).status, 200);
});

test('revision advances exactly when approval, revocation or a name change alters the snapshot', () => {
    const before = 42;
    const afterApproval = nextWhitelistRevision(before, true);
    const afterNoOp = nextWhitelistRevision(afterApproval, false);
    const afterRevocation = nextWhitelistRevision(afterNoOp, true);
    const afterRename = nextWhitelistRevision(afterRevocation, true);

    assert.equal(afterApproval, 43);
    assert.equal(afterNoOp, 43);
    assert.equal(afterRevocation, 44);
    assert.equal(afterRename, 45);
    assert.notEqual(
        createWhitelistHttpResult(7, createWhitelistSnapshot(before, []), undefined).etag,
        createWhitelistHttpResult(7, createWhitelistSnapshot(afterApproval, [{ uuid, name: 'Alex' }]), undefined).etag
    );
    const renamed = createWhitelistHttpResult(7, createWhitelistSnapshot(afterRename, [{ uuid, name: 'Alex2' }]), '"service-7-revision-44"');
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body?.players, [{ uuid, name: 'Alex2' }]);
});

test('Minecraft profile resolution accepts the official profile UUID and rejects invalid or missing profiles', async () => {
    const resolved = await resolveMinecraftProfile('Notch', async (input) => {
        assert.equal(String(input), 'https://api.mojang.com/users/profiles/minecraft/Notch');
        return new Response(JSON.stringify({ id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    });
    assert.deepEqual(resolved, {
        uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
        name: 'Notch'
    });

    await assert.rejects(
        resolveMinecraftProfile('bad name', async () => {
            throw new Error('Should not fetch an invalid name');
        }),
        /Ungültiger Minecraft-Name/
    );
    await assert.rejects(
        resolveMinecraftProfile('UnknownPlayer', async () => new Response(null, { status: 404 })),
        /Minecraft-Profil wurde nicht gefunden/
    );
});

test('approval profile lookup preserves UUID identity after a Minecraft name change', async () => {
    const resolved = await resolveMinecraftProfileByUuid(uuid, async (input) => {
        assert.equal(
            String(input),
            'https://sessionserver.mojang.com/session/minecraft/profile/0123456789abcdef0123456789abcdef'
        );
        return new Response(JSON.stringify({ id: '0123456789abcdef0123456789abcdef', name: 'NewName' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    });

    assert.deepEqual(resolved, { uuid, name: 'NewName' });
});
