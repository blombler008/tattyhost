import { Router, type Request, type Response } from 'express';
import { hashPassword, verifyPassword } from '@tattyhost/CryptoUtils';
import { executeTransaction, query } from '@tattyhost/SQLutils';
import { auditStatement, isDuplicateEntry, logApiFailure, logAuditCommitted, requireUser, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { isValidEmail, isValidTimezone } from './api-validators.ts';
import { recordClientIp } from '../auth/client-ip.ts';

async function getAccountAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        const rows = await query<{
            username: string;
            email: string;
            has_cloud_access: boolean | number | string;
            has_file_access: boolean | number | string;
        }>(
            'SELECT username, email, has_cloud_access, has_file_access FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!rows[0]) {
            sendFailure(res, 404, 'Benutzerkonto nicht gefunden');
            return;
        }
        const account = rows[0];
        sendSuccess(res, {
            account: {
                username: account.username,
                email: account.email,
                hasCloudAccess: account.has_cloud_access === true ||
                    account.has_cloud_access === 1 ||
                    account.has_cloud_access === '1',
                hasFileAccess: account.has_file_access === true ||
                    account.has_file_access === 1 ||
                    account.has_file_access === '1'
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.account.load_failed', error);
        sendServerFailure(res);
    }
}

async function updateAccountEmailAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { currentPassword, email } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (typeof currentPassword !== 'string' || !currentPassword || !isValidEmail(cleanEmail)) {
        sendFailure(res, 400, 'Bitte gib dein aktuelles Passwort und eine gültige E-Mail-Adresse ein');
        return;
    }

    try {
        const users = await query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!users[0] || !verifyPassword(currentPassword, users[0].password_hash)) {
            sendFailure(res, 401, 'Das aktuelle Passwort ist falsch');
            return;
        }
        await executeTransaction([
            { sql: 'UPDATE users SET email = ? WHERE uuid = ?', params: [cleanEmail, session.userId] },
            auditStatement(res, session.userId, 'account.email.changed', {}, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.email.changed', 'user', session.userId);
        sendSuccess(res, { email: cleanEmail });
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Diese E-Mail-Adresse wird bereits verwendet');
            return;
        }
        logApiFailure(res, 'api.account.email_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateAccountPasswordAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword ||
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        sendFailure(res, 400, 'Aktuelles Passwort und ein neues Passwort mit 8 bis 128 Zeichen sind erforderlich');
        return;
    }

    try {
        const users = await query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!users[0] || !verifyPassword(currentPassword, users[0].password_hash)) {
            sendFailure(res, 401, 'Das aktuelle Passwort ist falsch');
            return;
        }

        await executeTransaction([
            {
                sql: 'UPDATE users SET password_hash = ? WHERE uuid = ?',
                params: [hashPassword(newPassword), session.userId]
            },
            {
                sql: 'DELETE FROM sessions WHERE user_uuid = ? AND id <> ?',
                params: [session.userId, session.sessionId]
            },
            {
                sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?',
                params: [session.userId]
            },
            auditStatement(res, session.userId, 'account.password.changed', {
                otherSessionsRevoked: true,
                pendingPasswordResetsRevoked: true
            }, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.password.changed', 'user', session.userId, {
            otherSessionsRevoked: true,
            pendingPasswordResetsRevoked: true
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.account.password_update_failed', error);
        sendServerFailure(res);
    }
}

async function getUserSettingsAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        let rows = await query<{
            language: string;
            timezone: string;
            dark_mode: boolean | number | string;
            personalised_server_list: boolean | number | string;
        }>(
            'SELECT language, timezone, dark_mode, personalised_server_list FROM user_settings WHERE user_uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!rows.length) {
            await executeTransaction([
                { sql: 'INSERT IGNORE INTO user_settings (user_uuid) VALUES (?)', params: [session.userId] },
                auditStatement(res, session.userId, 'account.settings.initialized', {}, 'user', session.userId)
            ]);
            logAuditCommitted(res, session.userId, 'account.settings.initialized', 'user', session.userId);
            rows = await query(
                'SELECT language, timezone, dark_mode, personalised_server_list FROM user_settings WHERE user_uuid = ? LIMIT 1',
                [session.userId]
            );
        }

        const settings = rows[0];
        if (!settings) throw new Error('User settings row was not created');
        sendSuccess(res, {
            settings: {
                language: settings.language,
                timezone: settings.timezone,
                darkMode: settings.dark_mode === true || settings.dark_mode === 1 || settings.dark_mode === '1',
                personalisedServerList: settings.personalised_server_list === true ||
                    settings.personalised_server_list === 1 || settings.personalised_server_list === '1'
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.settings.load_failed', error);
        sendFailure(res, 500, 'Einstellungen konnten nicht geladen werden');
    }
}

async function updateUserSettingsAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { language, timezone, darkMode, personalisedServerList } = req.body || {};
    if (typeof language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) {
        sendFailure(res, 400, 'Ungültige Sprache');
        return;
    }
    if (typeof timezone !== 'string' || timezone.length > 64 || !isValidTimezone(timezone)) {
        sendFailure(res, 400, 'Ungültige Zeitzone');
        return;
    }
    if (typeof darkMode !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Dark-Mode-Einstellung');
        return;
    }
    if (personalisedServerList !== undefined && typeof personalisedServerList !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Einstellung für die personalisierte Serverliste');
        return;
    }

    try {
        const includesPersonalisation = personalisedServerList !== undefined;
        const fields = ['language', 'timezone', 'darkMode'];
        if (includesPersonalisation) fields.push('personalisedServerList');
        await executeTransaction([
            {
                sql: `INSERT INTO user_settings (user_uuid, language, timezone, dark_mode${includesPersonalisation ? ', personalised_server_list' : ''})
                      VALUES (?, ?, ?, ?${includesPersonalisation ? ', ?' : ''})
                      ON DUPLICATE KEY UPDATE
                        language = VALUES(language),
                        timezone = VALUES(timezone),
                        dark_mode = VALUES(dark_mode)${includesPersonalisation ? ', personalised_server_list = VALUES(personalised_server_list)' : ''}`,
                params: includesPersonalisation
                    ? [session.userId, language, timezone, darkMode, personalisedServerList]
                    : [session.userId, language, timezone, darkMode]
            },
            ...(personalisedServerList === false
                ? [{ sql: 'DELETE FROM user_client_ips WHERE user_uuid = ?', params: [session.userId] }]
                : []),
            auditStatement(res, session.userId, 'account.settings.updated', {
                fields
            }, 'user', session.userId)
        ]);
        if (personalisedServerList === true) await recordClientIp(session.userId, req.ip);
        logAuditCommitted(res, session.userId, 'account.settings.updated', 'user', session.userId, {
            fields
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.settings.save_failed', error);
        sendFailure(res, 500, 'Einstellungen konnten nicht gespeichert werden');
    }
}

export function createAccountRouter(): Router {
    const router = Router();
    router.get('/settings', getUserSettingsAPIRoute);
    router.put('/settings', updateUserSettingsAPIRoute);
    router.get('/account', getAccountAPIRoute);
    router.put('/account/email', updateAccountEmailAPIRoute);
    router.put('/account/password', updateAccountPasswordAPIRoute);
    return router;
}
