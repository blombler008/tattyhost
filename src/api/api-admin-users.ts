import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { execute, executeTransaction, query, type SqlParameter } from '@tattyhost/SQLutils';
import { isSmtpConfigured, sendPasswordResetEmail } from '../email/password-reset-mailer.ts';
import { logEvent } from '../logging/app-logger.ts';
import { auditStatement, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { createAdminMinecraftRouter } from './api-account-minecraft.ts';
import { getPasswordResetUrl, isValidEmail } from './api-validators.ts';

const VALID_ROLES = ['user', 'supporter', 'moderator', 'admin'] as const;

async function getAdminOverviewAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    try {
        const [users, activeUsers, sessions, failedLogins, downloads] = await Promise.all([
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM users'),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE'),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > CURRENT_TIMESTAMP'),
            query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM login_attempts
                                               WHERE success = FALSE AND attempted_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY`),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM downloads WHERE is_active = TRUE')
        ]);
        sendSuccess(res, {
            overview: {
                users: Number(users[0]?.count || 0),
                activeUsers: Number(activeUsers[0]?.count || 0),
                activeSessions: Number(sessions[0]?.count || 0),
                failedLogins24h: Number(failedLogins[0]?.count || 0),
                activeDownloads: Number(downloads[0]?.count || 0)
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.overview_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminUsersAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';

    try {
        const users = await query<{
            uuid: string;
            username: string;
            email: string;
            is_active: boolean | number;
            has_cloud_access: boolean | number | string;
            has_file_access: boolean | number | string;
            has_whitelist: boolean | number | string;
            role: string | null;
            created_at: Date;
        }>(`
            SELECT u.uuid, u.username, u.email, u.is_active, u.has_cloud_access, u.has_file_access, u.created_at,
                   (SELECT r.name FROM user_roles ur
                    JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_uuid = u.uuid
                    ORDER BY r.id LIMIT 1) AS role,
                    EXISTS (SELECT 1 FROM service_whitelist_requests w
                           WHERE w.requested_by = u.uuid AND w.status = 'approved') AS has_whitelist
            FROM users u
            WHERE (? = '' OR u.username LIKE CONCAT('%', ?, '%') OR u.email LIKE CONCAT('%', ?, '%'))
            ORDER BY u.created_at DESC
            LIMIT 100
        `, [search, search, search]);
        sendSuccess(res, {
            users: users.map((user) => ({
                ...user,
                is_active: Boolean(user.is_active),
                has_cloud_access: user.has_cloud_access === true ||
                    user.has_cloud_access === 1 ||
                    user.has_cloud_access === '1',
                has_file_access: user.has_file_access === true ||
                    user.has_file_access === 1 ||
                    user.has_file_access === '1',
                has_whitelist: Number(user.has_whitelist) === 1,
                role: user.role || 'user'
            }))
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.users_load_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserRoleAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { role } = req.body || {};
    if (typeof role !== 'string' || !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
        sendFailure(res, 400, 'Ungültige Benutzerrolle');
        return;
    }
    if (userId === admin.userId && role !== 'admin') {
        sendFailure(res, 400, 'Die eigene Administratorrolle kann hier nicht entfernt werden');
        return;
    }

    try {
        const roleRows = await query<{ id: number }>('SELECT id FROM roles WHERE name = ? LIMIT 1', [role]);
        if (!roleRows[0]) {
            sendFailure(res, 404, 'Rolle nicht gefunden');
            return;
        }
        await executeTransaction([
            { sql: 'DELETE FROM user_roles WHERE user_uuid = ?', params: [userId] },
            {
                sql: 'INSERT INTO user_roles (user_uuid, role_id) VALUES (?, ?)',
                params: [userId, roleRows[0].id]
            },
            auditStatement(res, admin.userId, 'admin.user.role_changed', { role }, 'user', userId)
        ]);
        logAuditCommitted(res, admin.userId, 'admin.user.role_changed', 'user', userId, { role });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_role_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserStatusAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
        sendFailure(res, 400, 'Ungültiger Kontostatus');
        return;
    }
    if (userId === admin.userId && !isActive) {
        sendFailure(res, 400, 'Das eigene Konto kann hier nicht gesperrt werden');
        return;
    }

    try {
        const statements: Array<{ sql: string; params: SqlParameter[] }> = [
            { sql: 'UPDATE users SET is_active = ? WHERE uuid = ?', params: [isActive, userId] }
        ];
        if (!isActive) {
            statements.push({ sql: 'DELETE FROM sessions WHERE user_uuid = ?', params: [userId] });
            statements.push({ sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?', params: [userId] });
        }
        statements.push(auditStatement(
            res,
            admin.userId,
            isActive ? 'admin.user.activated' : 'admin.user.deactivated',
            { isActive },
            'user',
            userId
        ));
        await executeTransaction(statements);
        logAuditCommitted(
            res,
            admin.userId,
            isActive ? 'admin.user.activated' : 'admin.user.deactivated',
            'user',
            userId,
            { isActive }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_status_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserCloudAccessAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Cloud-Berechtigung');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'UPDATE users SET has_cloud_access = ? WHERE uuid = ?', params: [enabled, userId] },
            auditStatement(
                res,
                admin.userId,
                enabled ? 'admin.user.cloud_access_granted' : 'admin.user.cloud_access_revoked',
                { enabled },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            enabled ? 'admin.user.cloud_access_granted' : 'admin.user.cloud_access_revoked',
            'user',
            userId,
            { enabled }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_cloud_access_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserFileAccessAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Dateiberechtigung');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'UPDATE users SET has_file_access = ? WHERE uuid = ?', params: [enabled, userId] },
            auditStatement(
                res,
                admin.userId,
                enabled ? 'admin.user.file_access_granted' : 'admin.user.file_access_revoked',
                { enabled },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            enabled ? 'admin.user.file_access_granted' : 'admin.user.file_access_revoked',
            'user',
            userId,
            { enabled }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_file_access_update_failed', error);
        sendServerFailure(res);
    }
}

async function deleteUserAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    if (userId === admin.userId) {
        sendFailure(res, 400, 'Das eigene Konto kann hier nicht gelöscht werden');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'DELETE FROM users WHERE uuid = ?', params: [userId] },
            auditStatement(res, admin.userId, 'admin.user.deleted', {}, 'user', userId)
        ]);
        logAuditCommitted(res, admin.userId, 'admin.user.deleted', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_delete_failed', error);
        sendServerFailure(res);
    }
}

async function requestAdminPasswordResetAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    if (!isSmtpConfigured()) {
        sendFailure(res, 503, 'SMTP-Mailversand ist nicht konfiguriert');
        return;
    }

    const requestedEmail = req.body?.recipientEmail;
    if (requestedEmail !== undefined && typeof requestedEmail !== 'string') {
        sendFailure(res, 400, 'Ungültige Wunsch-E-Mail-Adresse');
        return;
    }
    const customEmail = typeof requestedEmail === 'string' ? requestedEmail.trim() : '';
    if (customEmail && !isValidEmail(customEmail)) {
        sendFailure(res, 400, 'Ungültige Wunsch-E-Mail-Adresse');
        return;
    }

    const userId = req.params.uuid;
    try {
        const users = await query<{ username: string; email: string }>(
            'SELECT username, email FROM users WHERE uuid = ? LIMIT 1',
            [userId]
        );
        const user = users[0];
        if (!user) {
            sendFailure(res, 404, 'Benutzerkonto nicht gefunden');
            return;
        }

        const token = randomBytes(32).toString('base64url');
        const resetUrl = getPasswordResetUrl(token);
        if (!resetUrl) {
            sendFailure(res, 503, 'APP_BASE_URL fehlt oder ist ungültig; der Reset-Link kann nicht erstellt werden');
            return;
        }

        const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
        const recipientType = customEmail ? 'custom' : 'account';
        const recipient = customEmail || user.email;
        await executeTransaction([
            { sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?', params: [userId] },
            {
                sql: `INSERT INTO password_reset_tokens
                        (token_hash, user_uuid, created_by, expires_at)
                      VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 1 HOUR))`,
                params: [tokenHash, userId, admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.password_reset.requested',
                { recipientType },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.password_reset.requested',
            'user',
            userId,
            { recipientType }
        );

        try {
            await sendPasswordResetEmail(recipient, user.username, resetUrl);
        } catch (error) {
            logApiFailure(res, 'api.admin.password_reset_email_failed', error);
            try {
                await execute('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
            } catch (cleanupError) {
                logApiFailure(res, 'api.admin.password_reset_token_cleanup_failed', cleanupError);
            }
            sendFailure(res, 502, 'Reset-Mail konnte nicht versendet werden; bitte SMTP-Verbindung prüfen');
            return;
        }

        logEvent('info', 'email.password_reset.sent', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
            userId,
            recipientType
        });
        sendSuccess(res, { recipientType });
    } catch (error) {
        logApiFailure(res, 'api.admin.password_reset_request_failed', error);
        sendServerFailure(res);
    }
}

export function createAdminUsersRouter(): Router {
    const router = Router();
    const usersRouter = Router();
    router.get('/overview', getAdminOverviewAPIRoute);
    usersRouter.get('/', getAdminUsersAPIRoute);
    usersRouter.put('/:uuid/role', updateUserRoleAPIRoute);
    usersRouter.patch('/:uuid/status', updateUserStatusAPIRoute);
    usersRouter.patch('/:uuid/cloud-access', updateUserCloudAccessAPIRoute);
    usersRouter.patch('/:uuid/file-access', updateUserFileAccessAPIRoute);
    usersRouter.delete('/:uuid', deleteUserAPIRoute);
    usersRouter.post('/:uuid/password-reset', requestAdminPasswordResetAPIRoute);
    usersRouter.use('/:uuid/minecraft', createAdminMinecraftRouter());
    router.use('/users', usersRouter);
    return router;
}
