import { Router, type Request, type Response } from 'express';
import { deleteToken, verifyPassword } from '@tattyhost/CryptoUtils';
import { execute, executeTransaction, query } from '@tattyhost/SQLutils';
import { auditStatement, logApiFailure, logAuditCommitted, requireAdmin, requireUser, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import {
    canonicalizeMinecraftUuid,
    InvalidMinecraftNameError,
    MinecraftProfileNotFoundError,
    MinecraftProfileServiceError,
    resolveMinecraftProfile,
    resolveMinecraftProfileByUuid
} from './whitelist-contract.ts';

const MAX_MINECRAFT_ACCOUNTS = 10;

export async function saveUserMinecraftAccount(userId: string, playerUuid: string, playerName: string) {
    await execute(
        `INSERT INTO user_minecraft_accounts (user_uuid, player_uuid, player_name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE player_name = VALUES(player_name)`,
        [userId, playerUuid, playerName]
    );
}

async function getMinecraftAccountsAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        const accounts = await query<{ player_uuid: string; player_name: string; created_at: Date }>(
            `SELECT player_uuid, player_name, created_at
             FROM user_minecraft_accounts WHERE user_uuid = ? ORDER BY created_at`,
            [session.userId]
        );
        sendSuccess(res, { accounts });
    } catch (error) {
        logApiFailure(res, 'api.account.minecraft_load_failed', error);
        sendServerFailure(res);
    }
}

async function addMinecraftAccountAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const playerName = typeof req.body?.playerName === 'string' ? req.body.playerName.trim() : '';
    if (!playerName) {
        sendFailure(res, 400, 'Minecraft-Name ist erforderlich');
        return;
    }

    try {
        const existing = await query<{ total: number | string }>(
            'SELECT COUNT(*) AS total FROM user_minecraft_accounts WHERE user_uuid = ?',
            [session.userId]
        );
        if (Number(existing[0]?.total) >= MAX_MINECRAFT_ACCOUNTS) {
            sendFailure(res, 400, `Es sind höchstens ${MAX_MINECRAFT_ACCOUNTS} Minecraft-Konten möglich`);
            return;
        }

        const profile = await resolveMinecraftProfile(playerName);
        await saveUserMinecraftAccount(session.userId, profile.uuid, profile.name);
        sendSuccess(res, { account: { player_uuid: profile.uuid, player_name: profile.name } });
    } catch (error) {
        if (error instanceof InvalidMinecraftNameError) {
            sendFailure(res, 400, error.message);
            return;
        }
        if (error instanceof MinecraftProfileNotFoundError) {
            sendFailure(res, 404, error.message);
            return;
        }
        if (error instanceof MinecraftProfileServiceError) {
            sendFailure(res, 502, error.message);
            return;
        }
        logApiFailure(res, 'api.account.minecraft_add_failed', error);
        sendServerFailure(res);
    }
}

async function removeMinecraftAccountAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    let playerUuid: string;
    try {
        playerUuid = canonicalizeMinecraftUuid(String(req.params.uuid));
    } catch {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }

    try {
        await execute(
            'DELETE FROM user_minecraft_accounts WHERE user_uuid = ? AND player_uuid = ?',
            [session.userId, playerUuid]
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.account.minecraft_remove_failed', error);
        sendServerFailure(res);
    }
}

async function getOwnWhitelistAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        const requests = await query<{
            id: number;
            service_name: string;
            player_name: string;
            status: string;
            created_at: Date;
        }>(
            `SELECT r.id, s.name AS service_name, r.player_name, r.status, r.created_at
             FROM service_whitelist_requests r
             JOIN service_status s ON s.id = r.service_id
             WHERE r.requested_by = ?
             ORDER BY r.created_at DESC`,
            [session.userId]
        );
        sendSuccess(res, { requests });
    } catch (error) {
        logApiFailure(res, 'api.account.whitelist_load_failed', error);
        sendServerFailure(res);
    }
}

async function deleteOwnAccountAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const password = req.body?.password;
    if (typeof password !== 'string' || !password) {
        sendFailure(res, 400, 'Bitte gib zur Bestätigung dein Passwort ein');
        return;
    }
    if (session.role === 'admin') {
        sendFailure(res, 403, 'Administrator-Konten können nicht selbst gelöscht werden');
        return;
    }

    try {
        const users = await query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!users[0] || !verifyPassword(password, users[0].password_hash)) {
            sendFailure(res, 401, 'Das Passwort ist falsch');
            return;
        }

        await executeTransaction([
            { sql: 'DELETE FROM users WHERE uuid = ?', params: [session.userId] },
            auditStatement(res, session.userId, 'account.deleted', {}, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.deleted', 'user', session.userId);
        deleteToken(req.cookies?.token);
        res.clearCookie('token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.account.delete_failed', error);
        sendServerFailure(res);
    }
}

function isGameProfileError(res: Response, error: unknown): boolean {
    if (error instanceof InvalidMinecraftNameError) {
        sendFailure(res, 400, error.message);
        return true;
    }
    if (error instanceof MinecraftProfileNotFoundError) {
        sendFailure(res, 404, error.message);
        return true;
    }
    if (error instanceof MinecraftProfileServiceError) {
        sendFailure(res, 502, error.message);
        return true;
    }
    return false;
}

async function listAdminMinecraftAccountsAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    try {
        const accounts = await query<{ player_uuid: string; player_name: string; created_at: Date }>(
            `SELECT player_uuid, player_name, created_at
             FROM user_minecraft_accounts WHERE user_uuid = ? ORDER BY created_at`,
            [String(req.params.uuid)]
        );
        sendSuccess(res, { accounts });
    } catch (error) {
        logApiFailure(res, 'api.admin.minecraft_load_failed', error);
        sendServerFailure(res);
    }
}

async function addAdminMinecraftAccountAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const playerName = typeof req.body?.playerName === 'string' ? req.body.playerName.trim() : '';
    if (!playerName) {
        sendFailure(res, 400, 'Minecraft-Name ist erforderlich');
        return;
    }

    try {
        const users = await query<{ uuid: string }>('SELECT uuid FROM users WHERE uuid = ? LIMIT 1', [String(req.params.uuid)]);
        if (!users[0]) {
            sendFailure(res, 404, 'Benutzer nicht gefunden');
            return;
        }
        const profile = await resolveMinecraftProfile(playerName);
        await saveUserMinecraftAccount(users[0].uuid, profile.uuid, profile.name);
        sendSuccess(res, { account: { player_uuid: profile.uuid, player_name: profile.name } });
    } catch (error) {
        if (isGameProfileError(res, error)) return;
        logApiFailure(res, 'api.admin.minecraft_add_failed', error);
        sendServerFailure(res);
    }
}

async function refreshAdminMinecraftAccountAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    let playerUuid: string;
    try {
        playerUuid = canonicalizeMinecraftUuid(String(req.params.playerUuid));
    } catch {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }

    try {
        const userId = String(req.params.uuid);
        const existing = await query<{ player_uuid: string }>(
            'SELECT player_uuid FROM user_minecraft_accounts WHERE user_uuid = ? AND player_uuid = ? LIMIT 1',
            [userId, playerUuid]
        );
        if (!existing[0]) {
            sendFailure(res, 404, 'Minecraft-Konto nicht gefunden');
            return;
        }

        const profile = await resolveMinecraftProfileByUuid(playerUuid);
        await executeTransaction([
            { sql: 'UPDATE user_minecraft_accounts SET player_name = ? WHERE user_uuid = ? AND player_uuid = ?', params: [profile.name, userId, playerUuid] },
            { sql: 'UPDATE service_whitelist_requests SET player_name = ? WHERE requested_by = ? AND player_uuid = ?', params: [profile.name, userId, playerUuid] },
            {
                sql: `UPDATE service_status s
                      JOIN service_whitelist_players p ON p.service_id = s.id
                      SET s.whitelist_revision = s.whitelist_revision + 1
                      WHERE p.player_uuid = ? AND BINARY p.player_name <> ?`,
                params: [playerUuid, profile.name]
            },
            { sql: 'UPDATE service_whitelist_players SET player_name = ? WHERE player_uuid = ?', params: [profile.name, playerUuid] },
            auditStatement(res, admin.userId, 'admin.minecraft.name_refreshed', { playerUuid, playerName: profile.name }, 'user', userId)
        ]);
        sendSuccess(res, { account: { player_uuid: playerUuid, player_name: profile.name } });
    } catch (error) {
        if (isGameProfileError(res, error)) return;
        logApiFailure(res, 'api.admin.minecraft_refresh_failed', error);
        sendServerFailure(res);
    }
}

async function removeAdminMinecraftAccountAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    let playerUuid: string;
    try {
        playerUuid = canonicalizeMinecraftUuid(String(req.params.playerUuid));
    } catch {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }

    try {
        const userId = String(req.params.uuid);
        await executeTransaction([
            { sql: 'DELETE FROM user_minecraft_accounts WHERE user_uuid = ? AND player_uuid = ?', params: [userId, playerUuid] },
            auditStatement(res, admin.userId, 'admin.minecraft.removed', { playerUuid }, 'user', userId)
        ]);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.minecraft_remove_failed', error);
        sendServerFailure(res);
    }
}

export function createAdminMinecraftRouter(): Router {
    const router = Router({ mergeParams: true });
    router.get('/', listAdminMinecraftAccountsAPIRoute);
    router.post('/', addAdminMinecraftAccountAPIRoute);
    router.put('/:playerUuid', refreshAdminMinecraftAccountAPIRoute);
    router.delete('/:playerUuid', removeAdminMinecraftAccountAPIRoute);
    return router;
}

export function createAccountMinecraftRouter(): Router {
    const router = Router();
    router.get('/account/whitelist', getOwnWhitelistAPIRoute);
    router.get('/account/minecraft', getMinecraftAccountsAPIRoute);
    router.post('/account/minecraft', addMinecraftAccountAPIRoute);
    router.delete('/account/minecraft/:uuid', removeMinecraftAccountAPIRoute);
    router.delete('/account', deleteOwnAccountAPIRoute);
    return router;
}
