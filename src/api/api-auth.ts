import { Router, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import {
    generateSecureToken,
    rotateKeys,
    type SessionData,
    deleteToken,
    hashPassword,
    verifyPassword
} from '@tattyhost/CryptoUtils';
import { execute, executeTransaction, query, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';
import { logOperationalEvent } from '../logging/operational-log.ts';
import { auditStatement, getUserSession, isDuplicateEntry, logApiFailure, logAuditCommitted, requireUser, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { isValidEmail } from './api-validators.ts';

const SESSION_MAX_AGE = 48 * 60 * 60 * 1000;

const sessionKeyRotationTimer = setInterval(() => {
    logEvent('info', 'security.session_key_rotation.started');
    try {
        rotateKeys();
        logOperationalEvent({ event: 'security.session_key_rotation.completed' });
    } catch (error) {
        logEvent('error', 'security.session_key_rotation.failed', { error });
        logOperationalEvent({
            event: 'security.session_key_rotation.failed',
            level: 'error',
            details: { error }
        });
    }
}, 24 * 60 * 60 * 1000);
sessionKeyRotationTimer.unref();

function secureDataAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;
    sendSuccess(res, { role: session.role });
}

async function loginAPIRoute(req: Request, res: Response) {
    try {
        if (getUserSession(res)) {
            sendFailure(res, 409, 'Bereits angemeldet');
            return;
        }

        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' ||
            !username.trim() || !password) {
            sendFailure(res, 400, 'Benutzername/E-Mail und Passwort sind erforderlich');
            return;
        }

        const ip = req.ip || '';
        const identifier = username.trim();
        const users = await query<{
            uuid: string;
            password_hash: string;
            role: string | null;
            is_active: boolean | number;
        }>(`
            SELECT u.uuid, u.password_hash, u.is_active,
                   (SELECT r.name FROM user_roles ur
                    JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_uuid = u.uuid
                    ORDER BY r.id LIMIT 1) AS role
            FROM users u
            WHERE u.username = ? OR u.email = ?
            LIMIT 1
        `, [identifier, identifier]);

        const user = users[0];
        if (!user || !verifyPassword(password, user.password_hash) || !user.is_active) {
            await execute(
                'INSERT INTO login_attempts (user_uuid, ip_address, success) VALUES (?, ?, FALSE)',
                [user?.uuid ?? null, ip]
            );
            sendFailure(res, 401, 'Benutzername oder Passwort ist falsch');
            return;
        }

        const sessionId = randomUUID();
        const timestamp = Date.now();
        const sessionData: SessionData = {
            userId: user.uuid,
            role: user.role || 'user',
            fingerprint: req.headers['user-agent'] || '',
            ip,
            timestamp,
            sessionId
        };

        await executeTransaction([
            {
                sql: `INSERT INTO sessions (id, user_uuid, ip_address, user_agent, expires_at)
                      VALUES (?, ?, ?, ?, ?)`,
                params: [sessionId, user.uuid, ip, sessionData.fingerprint, new Date(timestamp + SESSION_MAX_AGE)]
            },
            {
                sql: 'INSERT INTO login_attempts (user_uuid, ip_address, success) VALUES (?, ?, TRUE)',
                params: [user.uuid, ip]
            },
            auditStatement(res, user.uuid, 'auth.login.succeeded', {}, 'session')
        ]);
        logAuditCommitted(res, user.uuid, 'auth.login.succeeded', 'session', null);

        res.cookie('token', generateSecureToken(sessionData), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: SESSION_MAX_AGE
        });
        logEvent('debug', 'auth.login.cookie_issued', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
            secureAttributeEnabled: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAgeMs: SESSION_MAX_AGE
        });
        sendSuccess(res, { role: sessionData.role });
    } catch (error) {
        logApiFailure(res, 'api.login.failed', error);
        sendServerFailure(res);
    }
}

async function registerAPIRoute(req: Request, res: Response) {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || typeof email !== 'string' ||
        typeof password !== 'string') {
        sendFailure(res, 400, 'Benutzername, E-Mail und Passwort sind erforderlich');
        return;
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (cleanUsername.length < 3 || cleanUsername.length > 64) {
        sendFailure(res, 400, 'Der Benutzername muss 3 bis 64 Zeichen lang sein');
        return;
    }
    if (!isValidEmail(cleanEmail)) {
        sendFailure(res, 400, 'Bitte gib eine gültige E-Mail-Adresse ein');
        return;
    }
    if (password.length < 8 || password.length > 128) {
        sendFailure(res, 400, 'Das Passwort muss 8 bis 128 Zeichen lang sein');
        return;
    }

    const existing = await query(
        'SELECT uuid FROM users WHERE username = ? OR email = ? LIMIT 1',
        [cleanUsername, cleanEmail]
    );
    if (existing.length) {
        sendFailure(res, 409, 'Benutzername oder E-Mail ist bereits registriert');
        return;
    }

    const userId = randomUUID();
    try {
        await executeTransaction([
            {
                sql: 'INSERT INTO users (uuid, username, email, password_hash) VALUES (?, ?, ?, ?)',
                params: [userId, cleanUsername, cleanEmail, hashPassword(password)]
            },
            {
                sql: `INSERT INTO user_roles (user_uuid, role_id)
                      SELECT ?, id FROM roles WHERE name = 'user' LIMIT 1`,
                params: [userId]
            },
            {
                sql: 'INSERT INTO user_settings (user_uuid) VALUES (?)',
                params: [userId]
            },
            auditStatement(res, userId, 'account.registered', {}, 'user', userId)
        ]);
        logAuditCommitted(res, userId, 'account.registered', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Benutzername oder E-Mail ist bereits registriert');
            return;
        }
        logApiFailure(res, 'api.registration.failed', error);
        sendServerFailure(res);
    }
}

async function logoutAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        await executeTransaction([
            { sql: 'DELETE FROM sessions WHERE id = ?', params: [session.sessionId] },
            auditStatement(res, session.userId, 'auth.logout.completed', {}, 'session')
        ]);
        logAuditCommitted(res, session.userId, 'auth.logout.completed', 'session', null);
        deleteToken(req.cookies?.token);
        res.clearCookie('token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.logout.failed', error);
        sendServerFailure(res);
    }
}

async function resetPasswordAPIRoute(req: Request, res: Response) {
    const { token, newPassword } = req.body || {};
    if (typeof token !== 'string' || token.length !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        Buffer.from(token, 'base64url').toString('base64url') !== token ||
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        sendFailure(res, 400, 'Ungültiger Reset-Link oder ungültiges Passwort');
        return;
    }

    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    try {
        const userId = await withDatabaseTransaction(
            ['SELECT', 'UPDATE', 'DELETE', 'DELETE', 'INSERT'],
            async (connection) => {
                const resetRows = await connection.query<Array<{ user_uuid: string }>>(
                    `SELECT user_uuid
                     FROM password_reset_tokens
                     WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
                     FOR UPDATE`,
                    [tokenHash]
                );
                const reset = resetRows[0];
                if (!reset) return null;

                await connection.query(
                    'UPDATE users SET password_hash = ? WHERE uuid = ?',
                    [hashPassword(newPassword), reset.user_uuid]
                );
                await connection.query('DELETE FROM sessions WHERE user_uuid = ?', [reset.user_uuid]);
                await connection.query('DELETE FROM password_reset_tokens WHERE user_uuid = ?', [reset.user_uuid]);
                const audit = auditStatement(
                    res,
                    reset.user_uuid,
                    'auth.password_reset.completed',
                    {},
                    'user',
                    reset.user_uuid
                );
                await connection.query(audit.sql, audit.params);
                return reset.user_uuid;
            }
        );

        if (!userId) {
            sendFailure(res, 400, 'Der Reset-Link ist ungültig oder abgelaufen');
            return;
        }
        logAuditCommitted(res, userId, 'auth.password_reset.completed', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.password_reset.failed', error);
        sendServerFailure(res);
    }
}

export function createAuthRouter(): Router {
    const router = Router();
    router.get('/secure-data', secureDataAPIRoute);
    router.post('/login', loginAPIRoute);
    router.post('/register', registerAPIRoute);
    router.post('/logout', logoutAPIRoute);
    router.post('/password-reset', resetPasswordAPIRoute);
    return router;
}
