import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import mariadb from 'mariadb';
import { closeDatabasePool } from '@tattyhost/SQLutils';
import { hashClientIp, isPublicClientIp, normalizeClientIp, pruneClientIps, recordClientIp } from '../src/auth/client-ip.ts';
import { createPlayerLookupHandler, loadLookupRows, type LookupRow } from '../src/api/api-thn-players.ts';
import { createServiceApiPreAuthRouter } from '../src/api/api-services.ts';

process.env.IP_LOOKUP_HMAC_SECRET = 'ab'.repeat(32);
test.after(async () => { await closeDatabasePool(); });

const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const lastSeen = Date.now() - 180_000;
const stats = {
    uuid, name: 'OldName', lastSeen, online: false, playtimeTicks: 1,
    deaths: 0, mobKills: 0, playerKills: 0, level: 0, health: 20,
    foodLevel: 20, gameMode: 'SURVIVAL', world: 'world', x: 0, y: 64, z: 0
};
const row: LookupRow = { player_name: 'VerifiedName', last_seen: lastSeen, stats_json: JSON.stringify(stats) };

const authenticate = async (req: Request, res: Response) => {
    if (req.get('authorization') !== 'Bearer valid') {
        res.status(401).json({ error: 'invalid' });
        return null;
    }
    return { serviceId: 1, actorId: null };
};

async function serve(load: (hash: string) => Promise<LookupRow[]>) {
    const app = express();
    app.use(createServiceApiPreAuthRouter(authenticate));
    app.use('/api/services/players/lookup', express.json({ limit: '1kb' }));
    app.put('/api/services/players/lookup', createPlayerLookupHandler(load, authenticate));
    app.use((error: { status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
        void _next;
        res.status(error.status || 500).json({ error: 'invalid request' });
    });
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
        request: (body: string, authorized = true) => fetch(`http://127.0.0.1:${address.port}/api/services/players/lookup`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer valid' } : {}) },
            body
        }),
        close: async () => { server.close(); await once(server, 'close'); }
    };
}

test('IP literals are strict, normalized, and non-public addresses are ignored', () => {
    for (const invalid of ['', ' 203.0.113.7', '203.0.113.7:25565', 'example.com', '01.2.3.4', 'fe80::1%eth0', '[::1]', null]) {
        assert.equal(normalizeClientIp(invalid), null);
    }
    assert.equal(normalizeClientIp('2001:DB8:0:0::1'), '2001:db8::1');
    assert.equal(normalizeClientIp('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeClientIp('::FFFF:CB00:7107'), '203.0.113.7');
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', '::', '::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '::7f00:1']) {
        const normalized = normalizeClientIp(ip);
        assert.ok(normalized);
        assert.equal(isPublicClientIp(normalized), false, ip);
    }
    assert.equal(isPublicClientIp('203.0.113.7'), true);
    assert.equal(isPublicClientIp('2001:db8::1'), true);
    assert.equal(hashClientIp(normalizeClientIp('::ffff:203.0.113.7')!), hashClientIp('203.0.113.7'));
});

test('only a trusted loopback proxy can supply the client IP', () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    const getIp = Object.getOwnPropertyDescriptor(express.request, 'ip')?.get;
    assert.ok(getIp);
    const request = (remote: string, forwarded: string) => ({
        app, socket: { remoteAddress: remote }, headers: { 'x-forwarded-for': forwarded }
    });
    assert.equal(getIp.call(request('203.0.113.9', '203.0.113.7')), '203.0.113.9');
    assert.equal(getIp.call(request('127.0.0.1', '198.51.100.1, 203.0.113.7')), '203.0.113.7');
});

test('lookup authenticates, limits input, and only returns the verified name and lastSeen', async () => {
    let rows = [row];
    let requestedHash = '';
    const server = await serve(async (hash) => { requestedHash = hash; return rows; });
    const body = JSON.stringify({ ip: '203.0.113.7' });
    try {
        assert.equal((await server.request(body, false)).status, 401);
        assert.equal((await server.request('{', false)).status, 401);
        assert.equal((await server.request(JSON.stringify({ ip: 'bad' }))).status, 400);
        assert.equal((await server.request(JSON.stringify({ ip: '203.0.113.7', extra: 1 }))).status, 400);
        assert.equal((await server.request(JSON.stringify({ ip: 'a'.repeat(1100) }))).status, 413);
        const privateIp = await server.request(JSON.stringify({ ip: '::ffff:127.0.0.1' }));
        assert.equal(privateIp.status, 404);
        assert.deepEqual(await privateIp.json(), { error: 'not found' });
        const response = await server.request(body);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(requestedHash, hashClientIp('203.0.113.7'));
        assert.deepEqual(await response.json(), { name: 'VerifiedName', lastSeen });
        rows = [];
        const unknown = await server.request(body);
        assert.equal(unknown.status, 404);
        assert.deepEqual(await unknown.json(), { error: 'not found' });
        rows = [row, row];
        const ambiguous = await server.request(body);
        assert.equal(ambiguous.status, 404);
        assert.deepEqual(await ambiguous.json(), { error: 'not found' });
        rows = [{ ...row, last_seen: null, stats_json: null }];
        assert.equal((await server.request(body)).status, 404);
        const fresh = Date.now() - 1000;
        rows = [{ ...row, last_seen: fresh, stats_json: JSON.stringify({ ...stats, lastSeen: fresh, online: true }) }];
        const before = Date.now();
        const online = await (await server.request(body)).json() as { name: string; lastSeen: number };
        assert.equal(online.name, 'VerifiedName');
        assert.ok(online.lastSeen >= before && online.lastSeen <= Date.now());
        rows = [{ ...row, stats_json: JSON.stringify({ ...stats, online: true }) }];
        assert.deepEqual(await (await server.request(body)).json(), { name: 'VerifiedName', lastSeen });
    } finally { await server.close(); }
});

test('lookup SQL filters expiration, verification, opt-out and shared IPs', {
    skip: process.env.IP_LOOKUP_TEST_DATABASE !== '1' ? 'set IP_LOOKUP_TEST_DATABASE=1 to run with temporary MariaDB tables' : false
}, async (t) => {
    const connection = await mariadb.createConnection({
        host: process.env.SQL_ADDR || process.env['sql-addr'],
        port: Number(process.env.SQL_PORT || process.env['sql-port']),
        user: process.env.WEB_USER || process.env['web-user'],
        password: process.env.WEB_KEY || process.env['web-key'],
        database: process.env.SQL_DATABASE || process.env['web-database']
    });
    try {
        for (const ddl of [
            'CREATE TEMPORARY TABLE users (uuid CHAR(36) PRIMARY KEY, is_active BOOLEAN)',
            'CREATE TEMPORARY TABLE user_settings (user_uuid CHAR(36) PRIMARY KEY, personalised_server_list BOOLEAN NOT NULL DEFAULT FALSE)',
            'CREATE TEMPORARY TABLE user_client_ips (user_uuid CHAR(36), ip_hash CHAR(64), seen_at DATETIME(3), PRIMARY KEY(user_uuid, ip_hash), INDEX(ip_hash, seen_at))',
            'CREATE TEMPORARY TABLE verified_minecraft_links (user_uuid CHAR(36), player_uuid CHAR(36))',
            'CREATE TEMPORARY TABLE user_minecraft_accounts (user_uuid CHAR(36), player_uuid CHAR(36), player_name VARCHAR(16))',
            'CREATE TEMPORARY TABLE minecraft_player_stats (player_uuid CHAR(36), last_seen BIGINT, stats_json TEXT)'
        ]) await connection.query(ddl);
        await connection.query('ALTER TABLE user_settings ALTER COLUMN personalised_server_list SET DEFAULT FALSE');
        const cases = [
            ['one', '203.0.113.1', 1, true, 0],
            ['shared1', '203.0.113.2', 1, true, 0],
            ['shared2', '203.0.113.2', 1, true, 0],
            ['expired', '203.0.113.3', 1, true, 25],
            ['unverified', '203.0.113.4', 1, false, 0],
            ['optedout', '203.0.113.5', 0, true, 0]
        ] as const;
        for (const [user, ip, enabled, verified, hours] of cases) {
            const player = `${user}-player`;
            await connection.query('INSERT INTO users VALUES (?, TRUE)', [user]);
            await connection.query('INSERT INTO user_settings VALUES (?, ?)', [user, enabled]);
            await connection.query('INSERT INTO user_client_ips VALUES (?, ?, DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR))', [user, hashClientIp(ip), hours]);
            await connection.query('INSERT INTO user_minecraft_accounts VALUES (?, ?, ?)', [user, player, 'VerifiedName']);
            if (verified) await connection.query('INSERT INTO verified_minecraft_links VALUES (?, ?)', [user, player]);
            await connection.query('INSERT INTO minecraft_player_stats VALUES (?, ?, ?)', [player, lastSeen, JSON.stringify(stats)]);
        }
        const command = async (sql: string, params?: (string | number | boolean | Date | null)[]) => {
            await connection.query(sql, params);
        };
        await connection.query('INSERT INTO users VALUES (?, TRUE), (?, TRUE)', ['missing-setting', 'defaulted']);
        await connection.query('INSERT INTO user_settings (user_uuid) VALUES (?)', ['defaulted']);
        await connection.query('INSERT INTO user_client_ips VALUES (?, ?, CURRENT_TIMESTAMP(3))', ['missing-setting', hashClientIp('203.0.113.11')]);
        await connection.query('INSERT INTO user_minecraft_accounts VALUES (?, ?, ?)', ['missing-setting', 'missing-player', 'VerifiedName']);
        await connection.query('INSERT INTO verified_minecraft_links VALUES (?, ?)', ['missing-setting', 'missing-player']);
        await connection.query('INSERT INTO minecraft_player_stats VALUES (?, ?, ?)', ['missing-player', lastSeen, JSON.stringify(stats)]);
        await recordClientIp('missing-setting', '203.0.113.12', command);
        await recordClientIp('defaulted', '203.0.113.12', command);
        const notRecorded = await connection.query<Array<{ count: bigint }>>(
            'SELECT COUNT(*) AS count FROM user_client_ips WHERE ip_hash = ?', [hashClientIp('203.0.113.12')]
        );
        assert.equal(notRecorded[0].count, 0n);
        await recordClientIp('one', '::ffff:203.0.113.10', command);
        await recordClientIp('one', '203.0.113.10', command);
        await recordClientIp('one', '127.0.0.1', command);
        await recordClientIp('optedout', '203.0.113.10', command);
        const stored = await connection.query<Array<{ user_uuid: string; ip_hash: string }>>(
            'SELECT user_uuid, ip_hash FROM user_client_ips WHERE ip_hash = ?', [hashClientIp('203.0.113.10')]
        );
        assert.deepEqual(stored.map(({ user_uuid, ip_hash }) => ({ user_uuid, ip_hash })), [
            { user_uuid: 'one', ip_hash: hashClientIp('203.0.113.10') }
        ]);
        await connection.query('UPDATE user_client_ips SET seen_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 49 HOUR) WHERE user_uuid = ?', ['expired']);
        await pruneClientIps(command);
        assert.equal((await connection.query<Array<{ count: bigint }>>(
            'SELECT COUNT(*) AS count FROM user_client_ips WHERE user_uuid = ?', ['expired']
        ))[0].count, 0n);
        await connection.query('INSERT INTO user_client_ips VALUES (?, ?, DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 25 HOUR))', ['expired', hashClientIp('203.0.113.3')]);
        const server = await serve((hash) => loadLookupRows(hash, (sql, params) => connection.query<LookupRow[]>(sql, params)));
        try {
            const request = (ip: string) => server.request(JSON.stringify({ ip }));
            assert.deepEqual(await (await request('203.0.113.1')).json(), { name: 'VerifiedName', lastSeen });
            const durations: number[] = [];
            for (let i = 0; i < 20; i++) {
                const start = performance.now();
                const response = await request('203.0.113.1');
                assert.equal(response.status, 200);
                await response.arrayBuffer();
                durations.push(performance.now() - start);
            }
            t.diagnostic(`Local lookup with temporary MariaDB tables and stubbed auth: max ${Math.max(...durations).toFixed(1)} ms`);
            for (const ip of ['203.0.113.2', '203.0.113.3', '203.0.113.4', '203.0.113.5', '203.0.113.6', '203.0.113.11']) {
                const response = await request(ip);
                assert.equal(response.status, 404, ip);
                assert.deepEqual(await response.json(), { error: 'not found' });
            }
            await connection.query('INSERT INTO user_minecraft_accounts VALUES (?, ?, ?)', ['one', 'second-player', 'Second']);
            await connection.query('INSERT INTO verified_minecraft_links VALUES (?, ?)', ['one', 'second-player']);
            assert.equal((await request('203.0.113.1')).status, 404);
        } finally { await server.close(); }
    } finally { await connection.end(); }
});
