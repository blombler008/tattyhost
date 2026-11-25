import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { closeDatabasePool } from '@tattyhost/SQLutils';
import { createAdminThnRouter } from '../src/api/api-admin-thn.ts';
import { createAdminServicesRouter } from '../src/api/api-services.ts';
import { createOwnStatsHandler, createThnPlayersRouter } from '../src/api/api-thn-players.ts';
import { isCanonicalPlayerUuid, isLinkCode, ownPlayerStats, parsePlayerBatch, parsePlayerStats } from '../src/api/thn-player-contract.ts';
import { isLoopbackHost, isPlayerBackupId, isWorldBackupId, isWorldName, PluginApiError, ThnPluginClient } from '../src/api/thn-plugin-client.ts';

const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const now = 1_764_000_000_000;
const stats = {
    uuid, name: 'Player', lastSeen: now, online: true, playtimeTicks: 1_200,
    deaths: 1, mobKills: 2, playerKills: 3, level: 4, health: 20, foodLevel: 20,
    gameMode: 'SURVIVAL', world: 'world', x: 1, y: 64, z: 2
};
test.after(async () => { await closeDatabasePool(); });

async function listen(server: http.Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
}

test('player batches can independently validate entries and hide coordinates from owners', () => {
    assert.deepEqual(parsePlayerStats(stats, now), stats);
    assert.deepEqual(parsePlayerBatch([stats, { ...stats, name: 'invalid name' }], now), { players: [stats], rejected: 1 });
    for (const bad of [
        { ...stats, uuid: uuid.toUpperCase() },
        { ...stats, name: 'bad name' },
        { ...stats, lastSeen: now + 120_001 },
        { ...stats, playtimeTicks: -1 },
        { ...stats, foodLevel: 21 },
        { ...stats, x: Infinity },
        { ...stats, online: 'true' }
    ]) assert.equal(parsePlayerStats(bad, now), null);
    const parsed = parsePlayerStats(stats, now);
    assert.ok(parsed);
    const own = ownPlayerStats(parsed, now + 90_001);
    assert.equal(own.online, false);
    assert.equal('x' in own, false);
    assert.equal('y' in own, false);
    assert.equal('z' in own, false);
    assert.equal(ownPlayerStats(parsed, now + 90_000).online, true);
});

test('own stats route only returns data when the session owns the verified UUID', async () => {
    const app = express();
    app.use((req, res, next) => {
        res.locals.ssrAuth = { session: { userId: req.get('x-test-user'), role: 'user' } };
        next();
    });
    app.get('/own/:uuid', createOwnStatsHandler(async (requestedUuid, userId) =>
        requestedUuid === uuid && userId === 'owner' ? JSON.stringify(stats) : null));
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        const other = await fetch(`http://127.0.0.1:${port}/own/${uuid}`, { headers: { 'x-test-user': 'other' } });
        assert.equal(other.status, 404);
        const owner = await fetch(`http://127.0.0.1:${port}/own/${uuid}`, { headers: { 'x-test-user': 'owner' } });
        assert.equal(owner.status, 200);
        const body = await owner.json() as { player: Record<string, unknown> };
        assert.equal(body.player.uuid, uuid);
        assert.equal('x' in body.player, false);
    } finally {
        server.close();
        await once(server, 'close');
    }
});

test('link codes, UUIDs, backup IDs, worlds and loopback hosts are strictly validated', () => {
    assert.equal(isCanonicalPlayerUuid(uuid), true);
    assert.equal(isCanonicalPlayerUuid(uuid.replace(/-/g, '')), false);
    assert.equal(isLinkCode('001234'), true);
    assert.equal(isLinkCode('12345'), false);
    assert.equal(isPlayerBackupId('1764076800000_web'), true);
    assert.equal(isPlayerBackupId('latest', true), true);
    assert.equal(isPlayerBackupId('../latest', true), false);
    assert.equal(isWorldBackupId('1764076800000'), true);
    assert.equal(isWorldBackupId('1764076800000.zip'), false);
    assert.equal(isWorldName('world_nether'), true);
    assert.equal(isWorldName('..'), false);
    assert.equal(isWorldName('a/b'), false);
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('localhost'), false);
    assert.equal(isLoopbackHost('192.168.1.1'), false);
});

test('local client sends JSON without service credentials and streams backups', async () => {
    const server = http.createServer((req, res) => {
        assert.equal(req.headers.authorization, undefined);
        if (req.method === 'POST') {
            assert.equal(req.headers['content-type'], 'application/json');
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: '1764076800000_web' }));
        } else if (req.url?.includes('/backups/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"data":');
            res.end('"ok"}');
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'offline' }));
        }
    });
    const port = await listen(server);
    try {
        const client = new ThnPluginClient('127.0.0.1', port);
        assert.deepEqual(await client.createPlayerBackup(uuid), { id: '1764076800000_web' });
        const stream = await client.downloadPlayer(uuid, '1764076800000_web');
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString(), '{"data":"ok"}');
        await assert.rejects(() => client.playerStats(uuid), (error: unknown) =>
            error instanceof PluginApiError && error.status === 404);
    } finally {
        server.close();
        await once(server, 'close');
    }
});

test('backup download and restore reject non-admins before accessing the plugin', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
        res.locals.ssrAuth = { session: { userId: 'user-id', role: 'user' } };
        next();
    });
    app.use('/api/admin/thn', createAdminThnRouter());
    app.use('/api/admin/services', createAdminServicesRouter());
    app.use('/api', createThnPlayersRouter());
    const server = http.createServer(app);
    const port = await listen(server);
    try {
        for (const [path, method] of [
            ['/api/admin/services', 'POST'],
            ['/api/admin/services/1/api-key', 'POST'],
            [`/api/admin/thn/1/players/${uuid}/backups/1764076800000_web`, 'GET'],
            [`/api/admin/thn/1/players/${uuid}/backups/latest/restore`, 'POST'],
            ['/api/admin/thn/1/worlds/world/backups/1764076800000', 'GET']
        ]) {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
            assert.equal(response.status, 403);
        }
        const own = await fetch(`http://127.0.0.1:${port}/api/account/minecraft/not-a-uuid/stats`);
        assert.equal(own.status, 400);
        const missingKey = await fetch(`http://127.0.0.1:${port}/api/services/players/stats?uuid=${uuid}`);
        assert.equal(missingKey.status, 401);
    } finally {
        server.close();
        await once(server, 'close');
    }
});
