import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mock, test } from 'node:test';
import express from 'express';

test('settings preserve an opt-out across preference updates and validate the new field', async () => {
    let enabled = 0;
    let recordings = 0;
    const transactions: Array<Array<{ sql: string; params?: unknown[] }>> = [];
    mock.module('../src/auth/client-ip.ts', {
        namedExports: { recordClientIp: async () => { recordings++; } }
    });
    mock.module('../lib/CryptoUtils/CryptoUtils.ts', {
        namedExports: { hashPassword: () => '', verifyPassword: () => false }
    });
    mock.module('../lib/SQLUtils/SQLUtils.ts', {
        namedExports: {
            query: async () => [{ language: 'en', timezone: 'UTC', dark_mode: 1, personalised_server_list: enabled }],
            executeTransaction: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
                transactions.push(statements);
                const update = statements[0];
                if (update.sql.includes('personalised_server_list')) enabled = update.params?.[4] ? 1 : 0;
            }
        }
    });
    const { createAccountRouter } = await import('../src/api/api-account.ts');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (req.get('x-user')) res.locals.ssrAuth = { session: { userId: 'user', role: 'user' } };
        next();
    });
    app.use('/api', createAccountRouter());
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/settings`;
    const get = () => fetch(url, { headers: { 'x-user': 'user' } });
    const put = (body: object) => fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-user': 'user' },
        body: JSON.stringify(body)
    });
    const preferences = { language: 'en', timezone: 'UTC', darkMode: true };
    try {
        assert.equal((await fetch(url)).status, 401);
        assert.equal(((await (await get()).json()) as { settings: { personalisedServerList: boolean } }).settings.personalisedServerList, false);
        assert.equal((await put({ ...preferences, personalisedServerList: false })).status, 200);
        assert.match(transactions[0][1].sql, /^DELETE FROM user_client_ips WHERE user_uuid = \?$/);
        assert.deepEqual(transactions[0][1].params, ['user']);
        assert.equal(((await (await get()).json()) as { settings: { personalisedServerList: boolean } }).settings.personalisedServerList, false);
        assert.equal((await put(preferences)).status, 200);
        assert.equal(((await (await get()).json()) as { settings: { personalisedServerList: boolean } }).settings.personalisedServerList, false);
        assert.equal(transactions[1][0].sql.includes('personalised_server_list'), false);
        assert.equal((await put({ ...preferences, personalisedServerList: 'false' })).status, 400);
        assert.equal(transactions.length, 2);
        assert.equal((await put({ ...preferences, personalisedServerList: true })).status, 200);
        assert.equal(recordings, 1);
        assert.equal(transactions[2].some((statement) => statement.sql.startsWith('DELETE FROM user_client_ips')), false);
        assert.equal(((await (await get()).json()) as { settings: { personalisedServerList: boolean } }).settings.personalisedServerList, true);
    } finally {
        server.close();
        await once(server, 'close');
        mock.reset();
    }
});
