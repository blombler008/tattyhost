import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mock, test } from 'node:test';
import express from 'express';

test('login attempts and sessions retain their existing IP records', async () => {
    const commands: Array<{ sql: string; params?: unknown[] }> = [];
    let tokenIp: string | undefined;
    mock.module('../lib/CryptoUtils/CryptoUtils.ts', {
        namedExports: {
            generateSecureToken: (session: { ip: string }) => { tokenIp = session.ip; return 'token'; },
            rotateKeys: () => undefined,
            deleteToken: () => undefined,
            hashPassword: () => '',
            verifyPassword: (password: string) => password === 'correct'
        }
    });
    mock.module('../lib/SQLUtils/SQLUtils.ts', {
        namedExports: {
            query: async () => [{ uuid: 'user-id', password_hash: 'hash', role: 'user', is_active: 1 }],
            execute: async (sql: string, params: unknown[]) => { commands.push({ sql, params }); },
            executeTransaction: async (statements: Array<{ sql: string; params?: unknown[] }>) => { commands.push(...statements); },
            withDatabaseTransaction: async () => undefined,
            insertOperationalLogRecord: async () => undefined
        }
    });
    mock.module('../src/auth/client-ip.ts', { namedExports: { recordClientIp: async () => undefined } });
    const { createAuthRouter } = await import('../src/api/api-auth.ts');
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use('/api', createAuthRouter());
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const login = (password: string) => fetch(`http://127.0.0.1:${address.port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
        body: JSON.stringify({ username: 'test', password })
    });
    try {
        assert.equal((await login('wrong')).status, 401);
        assert.match(commands[0].sql, /login_attempts \(user_uuid, ip_address, success\)/);
        assert.equal(commands[0].params?.[1], '203.0.113.7');
        assert.equal((await login('correct')).status, 200);
        assert.match(commands[1].sql, /sessions \(id, user_uuid, ip_address/);
        assert.equal(commands[1].params?.[2], '203.0.113.7');
        assert.match(commands[2].sql, /login_attempts \(user_uuid, ip_address, success\)/);
        assert.equal(commands[2].params?.[1], '203.0.113.7');
        assert.equal(tokenIp, '203.0.113.7');
    } finally {
        server.close();
        await once(server, 'close');
        mock.reset();
    }
});
