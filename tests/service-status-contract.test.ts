import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    applyHeartbeatTimeout,
    applyServiceHeartbeat,
    HEARTBEAT_EXPIRED_DETAILS,
    hashServiceStatusApiKey,
    isHeartbeatExpired,
    isValidServiceConfiguration,
    MAX_MINECRAFT_VERSION_LENGTH,
    MAX_SERVICE_PLAYERS,
    parseServiceStatusReport,
    resolveServiceApiKeyRecord,
    ServiceRateLimiter,
    SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS
} from '../src/api/service-status-contract.ts';
import { parseServiceApiBearer } from '../src/api/whitelist-contract.ts';

const serviceApiKey = Buffer.alloc(48, 23).toString('base64');
const serviceTokenHash = createHash('sha256').update(serviceApiKey).digest('hex');
const receivedAt = new Date('2026-11-24T20:00:00.000Z');

test('only Minecraft services can enable THNLink or Minecraft whitelists', () => {
    assert.equal(isValidServiceConfiguration('generic', false, false), true);
    assert.equal(isValidServiceConfiguration('minecraft', true, true), true);
    assert.equal(isValidServiceConfiguration('minecraft', false, true), true);
    assert.equal(isValidServiceConfiguration('generic', true, false), false);
    assert.equal(isValidServiceConfiguration('generic', false, true), false);
    assert.equal(isValidServiceConfiguration('other', false, false), false);
    assert.equal(isValidServiceConfiguration('minecraft', 'true', false), false);
});

test('service rate limiting is independent per key and resets after the window', () => {
    const limiter = new ServiceRateLimiter(2, 60_000);
    assert.equal(limiter.allow(1, 0), true);
    assert.equal(limiter.allow(1, 1), true);
    assert.equal(limiter.allow(1, 2), false);
    assert.equal(limiter.allow(2, 2), true);
    assert.equal(limiter.allow(1, 60_000), true);
});

test('a valid service key resolves to its single service and invalid credentials are rejected', () => {
    const bearer = parseServiceApiBearer(`Bearer ${serviceApiKey}`);
    assert.equal(bearer, serviceApiKey);
    assert.equal(hashServiceStatusApiKey(serviceApiKey), serviceTokenHash);
    assert.deepEqual(
        resolveServiceApiKeyRecord(serviceApiKey, { serviceId: 17, actorId: 'admin-id', tokenHash: serviceTokenHash }),
        { serviceId: 17, actorId: 'admin-id' }
    );
    assert.equal(
        resolveServiceApiKeyRecord(`${serviceApiKey.slice(0, -1)}A`, { serviceId: 17, actorId: null, tokenHash: serviceTokenHash }),
        null
    );
    assert.equal(resolveServiceApiKeyRecord(serviceApiKey, undefined), null);
    assert.equal(parseServiceApiBearer('Bearer invalid'), null);
});

test('only online, offline, and maintenance reports are valid, with bounded string details', () => {
    for (const status of ['online', 'offline', 'maintenance']) {
        assert.deepEqual(parseServiceStatusReport({ status }), { status });
    }

    assert.deepEqual(
        parseServiceStatusReport({ status: 'online', details: `  ${'x'.repeat(251)}  ` }),
        { status: 'online', details: 'x'.repeat(251) }
    );
    for (const report of [
        null,
        [],
        { status: 'starting' },
        { status: '' },
        { status: 1 },
        { status: 'online', details: 'x'.repeat(256) },
        { status: 'offline', details: 12 },
        { status: 'maintenance', details: null }
    ]) {
        assert.equal(parseServiceStatusReport(report), null);
    }
});

test('optional player counts and Minecraft version are validated while legacy reports remain accepted', () => {
    assert.deepEqual(parseServiceStatusReport({ status: 'online' }), { status: 'online' });
    assert.deepEqual(parseServiceStatusReport({
        status: 'online',
        players: { online: 3, max: 20 },
        minecraftVersion: '  26.1  '
    }), {
        status: 'online',
        players: { online: 3, max: 20 },
        minecraftVersion: '26.1'
    });
    assert.deepEqual(parseServiceStatusReport({
        status: 'online',
        players: { online: MAX_SERVICE_PLAYERS, max: MAX_SERVICE_PLAYERS },
        minecraftVersion: 'v'.repeat(MAX_MINECRAFT_VERSION_LENGTH)
    }), {
        status: 'online',
        players: { online: MAX_SERVICE_PLAYERS, max: MAX_SERVICE_PLAYERS },
        minecraftVersion: 'v'.repeat(MAX_MINECRAFT_VERSION_LENGTH)
    });

    for (const report of [
        { status: 'online', players: { online: -1, max: 20 } },
        { status: 'online', players: { online: 1.5, max: 20 } },
        { status: 'online', players: { online: '3', max: 20 } },
        { status: 'online', players: { online: 3 } },
        { status: 'online', players: { online: 3, max: MAX_SERVICE_PLAYERS + 1 } },
        { status: 'online', players: [] },
        { status: 'online', minecraftVersion: '' },
        { status: 'online', minecraftVersion: ' '.repeat(2) },
        { status: 'online', minecraftVersion: 'v'.repeat(MAX_MINECRAFT_VERSION_LENGTH + 1) },
        { status: 'online', minecraftVersion: `${' '.repeat(MAX_MINECRAFT_VERSION_LENGTH)}v` },
        { status: 'online', minecraftVersion: 26.1 }
    ]) {
        assert.equal(parseServiceStatusReport(report), null);
    }
});

test('heartbeat saves validated details and server receive time; client timestamps are ignored', () => {
    const report = parseServiceStatusReport({
        status: 'online',
        details: '  Ready  ',
        timestamp: '1999-01-01T00:00:00.000Z'
    });
    assert.ok(report);
    const updated = applyServiceHeartbeat(
        { status: 'offline', details: HEARTBEAT_EXPIRED_DETAILS },
        report,
        false,
        receivedAt
    );

    assert.deepEqual(updated, {
        status: 'online',
        details: 'Ready',
        playersOnline: null,
        playersMax: null,
        minecraftVersion: null,
        receivedAt,
        statusChanged: true,
        detailsChanged: true,
        playersChanged: false,
        minecraftVersionChanged: false
    });
});

test('heartbeat saves optional metrics and preserves them for older online reports', () => {
    const reportWithMetrics = parseServiceStatusReport({
        status: 'online',
        players: { online: 3, max: 20 },
        minecraftVersion: '26.1'
    });
    assert.ok(reportWithMetrics);
    const first = applyServiceHeartbeat(
        { status: 'maintenance', details: 'Starting', playersOnline: null, playersMax: null, minecraftVersion: null },
        reportWithMetrics,
        false,
        receivedAt
    );
    assert.equal(first.playersOnline, 3);
    assert.equal(first.playersMax, 20);
    assert.equal(first.minecraftVersion, '26.1');
    assert.equal(first.playersChanged, true);
    assert.equal(first.minecraftVersionChanged, true);

    const legacyReport = parseServiceStatusReport({ status: 'online', details: 'Ready' });
    assert.ok(legacyReport);
    const legacyUpdate = applyServiceHeartbeat(first, legacyReport, false, receivedAt);
    assert.equal(legacyUpdate.playersOnline, 3);
    assert.equal(legacyUpdate.playersMax, 20);
    assert.equal(legacyUpdate.minecraftVersion, '26.1');
    assert.equal(legacyUpdate.playersChanged, false);
    assert.equal(legacyUpdate.minecraftVersionChanged, false);
});

test('non-online reports clear metrics so old values are not displayed as current', () => {
    const offlineReport = parseServiceStatusReport({ status: 'offline' });
    assert.ok(offlineReport);
    const offline = applyServiceHeartbeat(
        { status: 'online', details: 'Ready', playersOnline: 3, playersMax: 20, minecraftVersion: '26.1' },
        offlineReport,
        false,
        receivedAt
    );

    assert.equal(offline.playersOnline, null);
    assert.equal(offline.playersMax, null);
    assert.equal(offline.minecraftVersion, null);
    assert.equal(offline.playersChanged, true);
    assert.equal(offline.minecraftVersionChanged, true);
});

test('a heartbeat after timeout restores the reported state and clears the automatic timeout detail', () => {
    const report = parseServiceStatusReport({ status: 'online' });
    assert.ok(report);
    const updated = applyServiceHeartbeat(
        { status: 'offline', details: HEARTBEAT_EXPIRED_DETAILS },
        report,
        false,
        receivedAt
    );

    assert.equal(updated.status, 'online');
    assert.equal(updated.details, '');
    assert.equal(updated.statusChanged, true);
    assert.equal(updated.detailsChanged, true);
    assert.equal(updated.receivedAt, receivedAt);

    const legacy = applyServiceHeartbeat(
        { status: 'offline', details: 'Keine Statusmeldung seit über 60 Sekunden' },
        report,
        false,
        receivedAt
    );
    assert.equal(legacy.details, '');
});

test('a heartbeat cannot override an administrator status but still records its receipt', () => {
    const report = parseServiceStatusReport({ status: 'online', details: 'Plugin status' });
    assert.ok(report);
    const updated = applyServiceHeartbeat(
        {
            status: 'maintenance',
            details: 'Admin maintenance',
            playersOnline: 3,
            playersMax: 20,
            minecraftVersion: '26.1'
        },
        report,
        true,
        receivedAt
    );

    assert.equal(updated.status, 'maintenance');
    assert.equal(updated.details, 'Admin maintenance');
    assert.equal(updated.playersOnline, 3);
    assert.equal(updated.playersMax, 20);
    assert.equal(updated.minecraftVersion, '26.1');
    assert.equal(updated.receivedAt, receivedAt);
    assert.equal(updated.statusChanged, false);
    assert.equal(updated.detailsChanged, false);
});

test('heartbeat timeout is strictly after 90 seconds and disabled for manual overrides', () => {
    const lastReportedAt = new Date(receivedAt.getTime());
    const exactlyTimeout = new Date(receivedAt.getTime() + SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS * 1000);
    const expired = new Date(exactlyTimeout.getTime() + 1);

    assert.equal(isHeartbeatExpired(lastReportedAt, false, exactlyTimeout), false);
    assert.equal(isHeartbeatExpired(lastReportedAt, false, expired), true);
    assert.equal(isHeartbeatExpired(lastReportedAt, true, expired), false);
    assert.equal(isHeartbeatExpired(null, false, expired), false);
    assert.deepEqual(applyHeartbeatTimeout(lastReportedAt, false, expired), {
        status: 'offline',
        details: HEARTBEAT_EXPIRED_DETAILS,
        playersOnline: null,
        playersMax: null,
        minecraftVersion: null,
        lastReportedAt
    });

    assert.equal(applyHeartbeatTimeout(null, false, expired), null);
    assert.equal(applyHeartbeatTimeout(lastReportedAt, true, expired), null);
});

test('heartbeat validates and retains the reported plugin API port', () => {
    assert.deepEqual(parseServiceStatusReport({ status: 'online', api: { port: 43127, host: 'localhost' } }), {
        status: 'online', api: { port: 43127, host: 'localhost' }
    });
    for (const api of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '43127' }, { port: 1, host: '' }]) {
        assert.equal(parseServiceStatusReport({ status: 'online', api }), null);
    }
});
