import { Router, type Request, type Response } from 'express';
import type { UpsertResult } from 'mariadb';
import { query, type SqlParameter, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { authenticateServiceApiKey } from './api-services.ts';
import { saveUserMinecraftAccount } from './api-account-minecraft.ts';
import { auditStatement, logApiFailure, logAuditCommitted, requireAdmin, requireUser, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import {
    createWhitelistHttpResult,
    createWhitelistSnapshot,
    isValidWhitelistPlayerName,
    MAX_WHITELIST_PLAYERS,
    canonicalizeMinecraftUuid,
    InvalidMinecraftNameError,
    MinecraftProfileNotFoundError,
    MinecraftProfileServiceError,
    nextWhitelistRevision,
    resolveMinecraftProfile,
    resolveMinecraftProfileByUuid
} from './whitelist-contract.ts';

type WhitelistRequestRow = {
    id: number;
    service_id: number;
    player_uuid: string;
    player_name: string;
    reason: string;
    service_name?: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'revoked';
    requested_by: string | null;
    requested_by_name?: string | null;
    reviewed_by_name?: string | null;
    created_at: Date;
    updated_at: Date;
};

const MAX_WHITELIST_REASON_LENGTH = 500;

function getPositiveInteger(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function reportProfileError(res: Response, error: unknown): boolean {
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

async function repairInvalidWhitelistNames(serviceId: number) {
    const players = await query<{ player_uuid: string; player_name: string }>(
        'SELECT player_uuid, player_name FROM service_whitelist_players WHERE service_id = ?',
        [serviceId]
    );
    const invalid = players.filter((player) => !isValidWhitelistPlayerName(player.player_name));
    if (!invalid.length) return;

    const resolved = await Promise.all(invalid.map(async (player) => ({
        player,
        profile: await resolveMinecraftProfileByUuid(player.player_uuid)
    })));
    await withDatabaseTransaction(
        ['SELECT', ...resolved.map(() => 'UPDATE'), 'UPDATE'],
        async (connection) => {
            const services = await connection.query<Array<{ id: number }>>(
                'SELECT id FROM service_status WHERE id = ? FOR UPDATE', [serviceId]
            );
            if (!services[0]) return;
            let changed = false;
            for (const { player, profile } of resolved) {
                const result = await connection.query<UpsertResult>(
                    `UPDATE service_whitelist_players SET player_name = ?
                     WHERE service_id = ? AND player_uuid = ? AND BINARY player_name = BINARY ?`,
                    [profile.name, serviceId, player.player_uuid, player.player_name]
                );
                changed ||= result.affectedRows > 0;
            }
            if (changed) {
                await connection.query(
                    'UPDATE service_status SET whitelist_revision = whitelist_revision + 1 WHERE id = ?',
                    [serviceId]
                );
            }
        }
    );
}

async function getWhitelistAPIRoute(req: Request, res: Response) {
    const serviceAuth = await authenticateServiceApiKey(req, res);
    if (!serviceAuth) return;

    try {
        try {
            await repairInvalidWhitelistNames(serviceAuth.serviceId);
        } catch (error) {
            logApiFailure(res, 'api.whitelist.name_repair_failed', error);
            res.status(503).json({ error: 'Minecraft-Namen der Whitelist konnten nicht aufgelöst werden' });
            return;
        }

        const rows = await query<{ revision: number | string; player_uuid: string | null; player_name: string | null }>(
            `SELECT s.whitelist_revision AS revision, p.player_uuid, p.player_name
             FROM service_status s
             LEFT JOIN service_whitelist_players p ON p.service_id = s.id
             WHERE s.id = ?
             ORDER BY p.player_uuid`,
            [serviceAuth.serviceId]
        );
        if (!rows.length) {
            res.status(404).json({ error: 'Service nicht gefunden' });
            return;
        }

        const snapshot = createWhitelistSnapshot(
            rows[0].revision,
            rows.flatMap((row) => row.player_uuid !== null && row.player_name !== null
                ? [{ uuid: row.player_uuid, name: row.player_name }]
                : [])
        );
        const result = createWhitelistHttpResult(
            serviceAuth.serviceId,
            snapshot,
            req.get('if-none-match')
        );
        res.set({
            'Cache-Control': 'private, no-cache',
            ETag: result.etag
        });
        if (result.status === 304) {
            res.status(304).end();
            return;
        }
        res.status(200).json(result.body);
    } catch (error) {
        logApiFailure(res, 'api.whitelist.load_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
    }
}

async function createWhitelistRequestAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const serviceId = getPositiveInteger(req.body?.serviceId);
    const playerName = typeof req.body?.playerName === 'string' ? req.body.playerName.trim() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!serviceId || !playerName) {
        sendFailure(res, 400, 'Service-ID und Minecraft-Name sind erforderlich');
        return;
    }
    if (!reason || reason.length > MAX_WHITELIST_REASON_LENGTH) {
        sendFailure(res, 400, `Bitte gib eine kurze Begründung an (max. ${MAX_WHITELIST_REASON_LENGTH} Zeichen)`);
        return;
    }

    let profile: Awaited<ReturnType<typeof resolveMinecraftProfile>>;
    try {
        profile = await resolveMinecraftProfile(playerName);
    } catch (error) {
        if (reportProfileError(res, error)) return;
        logApiFailure(res, 'api.whitelist.profile_lookup_failed', error);
        sendServerFailure(res);
        return;
    }

    try {
        const result = await withDatabaseTransaction(
            ['SELECT', 'SELECT', 'WRITE', 'INSERT'],
            async (connection) => {
                const services = await connection.query<Array<{ id: number; whitelist_required: unknown }>>(
                    'SELECT id, whitelist_required FROM service_status WHERE id = ? FOR UPDATE',
                    [serviceId]
                );
                if (!services[0]) return 'service_missing' as const;
                if (!Number(services[0].whitelist_required)) return 'not_required' as const;

                const requests = await connection.query<Array<{
                    id: number;
                    status: WhitelistRequestRow['status'];
                    requested_by: string | null;
                }>>(
                    `SELECT id, status, requested_by
                     FROM service_whitelist_requests
                     WHERE service_id = ? AND player_uuid = ?
                     FOR UPDATE`,
                    [serviceId, profile.uuid]
                );
                const existing = requests[0];
                if (existing && (existing.status === 'pending' || existing.status === 'approved' ||
                    existing.requested_by !== session.userId)) {
                    return 'duplicate' as const;
                }

                if (existing) {
                    await connection.query(
                        `UPDATE service_whitelist_requests
                         SET player_name = ?, reason = ?, status = 'pending', requested_by = ?, reviewed_by = NULL
                         WHERE id = ?`,
                        [profile.name, reason, session.userId, existing.id]
                    );
                } else {
                    await connection.query(
                        `INSERT INTO service_whitelist_requests
                            (service_id, player_uuid, player_name, reason, status, requested_by)
                         VALUES (?, ?, ?, ?, 'pending', ?)`,
                        [serviceId, profile.uuid, profile.name, reason, session.userId]
                    );
                }

                const audit = auditStatement(
                    res,
                    session.userId,
                    'whitelist.request.created',
                    { playerName: profile.name, playerUuid: profile.uuid },
                    'service',
                    String(serviceId)
                );
                await connection.query(audit.sql, audit.params);
                return 'created' as const;
            }
        );

        if (result === 'service_missing') {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }
        if (result === 'not_required') {
            sendFailure(res, 400, 'Für diesen Server ist keine Whitelist erforderlich');
            return;
        }
        if (result === 'duplicate') {
            sendFailure(res, 409, 'Für dieses Minecraft-Profil existiert bereits ein Antrag oder eine Freigabe');
            return;
        }

        logAuditCommitted(res, session.userId, 'whitelist.request.created', 'service', String(serviceId), {
            playerName: profile.name,
            playerUuid: profile.uuid
        });
        await saveUserMinecraftAccount(session.userId, profile.uuid, profile.name).catch((error: unknown) => {
            logApiFailure(res, 'api.whitelist.minecraft_account_save_failed', error);
        });
        sendSuccess(res, { status: 'pending', playerName: profile.name });
    } catch (error) {
        logApiFailure(res, 'api.whitelist.request_create_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminWhitelistRequestsAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    const serviceId = req.query.serviceId === undefined ? null : getPositiveInteger(req.query.serviceId);
    const userId = req.query.userId;
    if ((req.query.serviceId !== undefined && !serviceId) ||
        (userId !== undefined && (typeof userId !== 'string' || userId.length > 36))) {
        sendFailure(res, 400, 'Ungültiger Filter');
        return;
    }
    const status = req.query.status;
    if (status !== undefined &&
        (typeof status !== 'string' || !['pending', 'approved', 'rejected', 'revoked'].includes(status))) {
        sendFailure(res, 400, 'Ungültiger Antragsstatus');
        return;
    }

    try {
        const conditions: string[] = [];
        const params: SqlParameter[] = [];
        if (serviceId) {
            conditions.push('r.service_id = ?');
            params.push(serviceId);
        }
        if (typeof userId === 'string') {
            conditions.push('r.requested_by = ?');
            params.push(userId);
        }
        if (typeof status === 'string') {
            conditions.push('r.status = ?');
            params.push(status);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const requests = await query<WhitelistRequestRow>(
            `SELECT r.id, r.service_id, s.name AS service_name, r.player_uuid, r.player_name, r.reason,
                    r.status, r.requested_by,
                    requested.username AS requested_by_name, reviewed.username AS reviewed_by_name,
                    r.created_at, r.updated_at
             FROM service_whitelist_requests r
             JOIN service_status s ON s.id = r.service_id
             LEFT JOIN users requested ON requested.uuid = r.requested_by
             LEFT JOIN users reviewed ON reviewed.uuid = r.reviewed_by
             ${whereClause}
             ORDER BY FIELD(r.status, 'pending', 'approved', 'rejected', 'revoked'), r.created_at DESC`,
            params
        );
        sendSuccess(res, { requests });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_requests_load_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminWhitelistHistoryAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    const userId = req.query.userId;
    if (typeof userId !== 'string' || !userId || userId.length > 36) {
        sendFailure(res, 400, 'Ungültiger Filter');
        return;
    }

    try {
        const rows = await query<{ id: number; details: string | null; logged_at: Date }>(
            `SELECT id, details, logged_at FROM audit_logs
             WHERE user_uuid = ? AND action = 'whitelist.self_removed'
             ORDER BY logged_at DESC LIMIT 50`,
            [userId]
        );
        const history = rows.map((row) => {
            let details: Record<string, unknown> = {};
            try {
                details = JSON.parse(row.details || '{}') as Record<string, unknown>;
            } catch {
                // Defekte Details werden als leere Notiz angezeigt.
            }
            return {
                id: row.id,
                service_name: typeof details.serviceName === 'string' ? details.serviceName : null,
                player_name: typeof details.playerName === 'string' ? details.playerName : null,
                previous_status: typeof details.previousStatus === 'string' ? details.previousStatus : null,
                logged_at: row.logged_at
            };
        });
        sendSuccess(res, { history });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_history_load_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminWhitelistPlayersAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    const serviceId = getPositiveInteger(req.query.serviceId);
    if (!serviceId) {
        sendFailure(res, 400, 'Eine gültige Service-ID ist erforderlich');
        return;
    }

    try {
        const players = await query<{ player_uuid: string; player_name: string; approved_at: Date }>(
            `SELECT player_uuid, player_name, approved_at
             FROM service_whitelist_players
             WHERE service_id = ?
             ORDER BY player_name, player_uuid`,
            [serviceId]
        );
        sendSuccess(res, { players });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_players_load_failed', error);
        sendServerFailure(res);
    }
}

async function reviewWhitelistRequestAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const requestId = getPositiveInteger(req.params.id);
    const action = req.body?.status;
    if (!requestId || (action !== 'approved' && action !== 'rejected')) {
        sendFailure(res, 400, 'Ungültige Anfrage oder Entscheidung');
        return;
    }

    const initialRows = await query<{
        service_id: number;
        player_uuid: string;
        player_name: string;
        status: WhitelistRequestRow['status'];
    }>(
        'SELECT service_id, player_uuid, player_name, status FROM service_whitelist_requests WHERE id = ? LIMIT 1',
        [requestId]
    ).catch((error: unknown) => {
        logApiFailure(res, 'api.admin.whitelist_request_load_failed', error);
        return null;
    });
    if (initialRows === null) {
        sendServerFailure(res);
        return;
    }
    if (!initialRows[0]) {
        sendFailure(res, 404, 'Whitelist-Antrag nicht gefunden');
        return;
    }
    const initial = initialRows[0];

    let currentProfile: Awaited<ReturnType<typeof resolveMinecraftProfile>> | undefined;
    if (action === 'approved') {
        try {
            currentProfile = await resolveMinecraftProfileByUuid(initial.player_uuid);
        } catch (error) {
            if (reportProfileError(res, error)) return;
            logApiFailure(res, 'api.admin.whitelist_profile_lookup_failed', error);
            sendServerFailure(res);
            return;
        }
    }

    try {
        const outcome = await withDatabaseTransaction(
            action === 'approved'
                ? ['SELECT', 'SELECT', 'SELECT', 'INSERT', 'UPDATE', 'UPDATE', 'INSERT']
                : ['SELECT', 'SELECT', 'UPDATE', 'INSERT'],
            async (connection) => {
                const services = await connection.query<Array<{ id: number; whitelist_revision: number | string }>>(
                    'SELECT id, whitelist_revision FROM service_status WHERE id = ? FOR UPDATE',
                    [initial.service_id]
                );
                if (!services[0]) return { result: 'service_missing' as const, revision: 0 };

                const requests = await connection.query<Array<{
                    id: number;
                    player_uuid: string;
                    player_name: string;
                    status: WhitelistRequestRow['status'];
                }>>(
                    `SELECT id, player_uuid, player_name, status
                     FROM service_whitelist_requests
                     WHERE id = ? AND service_id = ?
                     FOR UPDATE`,
                    [requestId, initial.service_id]
                );
                const request = requests[0];
                if (!request || request.status === action || request.player_uuid !== initial.player_uuid ||
                    (action === 'rejected' && request.status !== 'pending')) {
                    return { result: 'not_pending' as const, revision: 0 };
                }

                let revision = Number(services[0].whitelist_revision);
                if (action === 'approved' && currentProfile) {
                    const existingPlayers = await connection.query<Array<{ player_uuid: string; player_name: string }>>(
                        'SELECT player_uuid, player_name FROM service_whitelist_players WHERE service_id = ? AND player_uuid = ? FOR UPDATE',
                        [initial.service_id, request.player_uuid]
                    );
                    const membershipChanged = !existingPlayers[0];
                    const nameChanged = !!existingPlayers[0] && existingPlayers[0].player_name !== currentProfile.name;
                    if (membershipChanged) {
                        const counts = await connection.query<Array<{ total: number | string }>>(
                            'SELECT COUNT(*) AS total FROM service_whitelist_players WHERE service_id = ? FOR UPDATE',
                            [initial.service_id]
                        );
                        if (Number(counts[0].total) >= MAX_WHITELIST_PLAYERS) {
                            return { result: 'full' as const, revision: 0 };
                        }
                        await connection.query(
                            `INSERT INTO service_whitelist_players
                                (service_id, player_uuid, player_name, approved_by)
                             VALUES (?, ?, ?, ?)`,
                            [initial.service_id, request.player_uuid, currentProfile.name, admin.userId]
                        );
                    } else {
                        await connection.query(
                            'UPDATE service_whitelist_players SET player_name = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE service_id = ? AND player_uuid = ?',
                            [currentProfile.name, admin.userId, initial.service_id, request.player_uuid]
                        );
                    }
                    if (membershipChanged || nameChanged) {
                        revision = nextWhitelistRevision(revision, true);
                        await connection.query(
                            'UPDATE service_status SET whitelist_revision = ? WHERE id = ?',
                            [revision, initial.service_id]
                        );
                    }
                }

                await connection.query(
                    'UPDATE service_whitelist_requests SET status = ?, reviewed_by = ? WHERE id = ?',
                    [action, admin.userId, requestId]
                );
                const audit = auditStatement(
                    res,
                    admin.userId,
                    `whitelist.request.${action}`,
                    { playerName: currentProfile?.name || request.player_name, playerUuid: request.player_uuid },
                    'service',
                    String(initial.service_id)
                );
                await connection.query(audit.sql, audit.params);
                return { result: 'updated' as const, revision };
            }
        );

        if (outcome.result === 'service_missing') {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }
        if (outcome.result === 'not_pending') {
            sendFailure(res, 409, 'Dieser Antrag wurde bereits bearbeitet');
            return;
        }
        if (outcome.result === 'full') {
            sendFailure(res, 409, 'Die Whitelist ist voll');
            return;
        }

        const auditAction = `whitelist.request.${action}`;
        logAuditCommitted(res, admin.userId, auditAction, 'service', String(initial.service_id), {
            playerUuid: initial.player_uuid
        });
        sendSuccess(res, { status: action, revision: outcome.revision });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_request_review_failed', error);
        sendServerFailure(res);
    }
}

async function grantWhitelistAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const serviceId = getPositiveInteger(req.body?.serviceId);
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const playerName = typeof req.body?.playerName === 'string' ? req.body.playerName.trim() : '';
    if (!serviceId || !userId || userId.length > 36 || !playerName) {
        sendFailure(res, 400, 'Service, Benutzer und Minecraft-Name sind erforderlich');
        return;
    }

    let profile: Awaited<ReturnType<typeof resolveMinecraftProfile>>;
    try {
        profile = await resolveMinecraftProfile(playerName);
    } catch (error) {
        if (reportProfileError(res, error)) return;
        logApiFailure(res, 'api.admin.whitelist_grant_profile_failed', error);
        sendServerFailure(res);
        return;
    }

    try {
        const outcome = await withDatabaseTransaction(
            ['SELECT', 'SELECT', 'SELECT', 'SELECT', 'WRITE', 'INSERT', 'UPDATE', 'INSERT'],
            async (connection) => {
                const users = await connection.query<Array<{ uuid: string }>>(
                    'SELECT uuid FROM users WHERE uuid = ? LIMIT 1',
                    [userId]
                );
                if (!users[0]) return { result: 'user_missing' as const, revision: 0 };
                const admins = await connection.query<Array<{ username: string }>>(
                    'SELECT username FROM users WHERE uuid = ? LIMIT 1',
                    [admin.userId]
                );
                const services = await connection.query<Array<{ whitelist_revision: number | string }>>(
                    'SELECT whitelist_revision FROM service_status WHERE id = ? FOR UPDATE',
                    [serviceId]
                );
                if (!services[0]) return { result: 'service_missing' as const, revision: 0 };

                const requests = await connection.query<Array<{ id: number; status: string; requested_by: string | null }>>(
                    `SELECT id, status, requested_by FROM service_whitelist_requests
                     WHERE service_id = ? AND player_uuid = ? FOR UPDATE`,
                    [serviceId, profile.uuid]
                );
                const existing = requests[0];
                if (existing && (existing.status === 'approved' || (existing.requested_by && existing.requested_by !== userId))) {
                    return { result: 'duplicate' as const, revision: 0 };
                }

                const players = await connection.query<Array<{ player_uuid: string; player_name: string }>>(
                    'SELECT player_uuid, player_name FROM service_whitelist_players WHERE service_id = ? AND player_uuid = ? FOR UPDATE',
                    [serviceId, profile.uuid]
                );
                if (!players[0]) {
                    const counts = await connection.query<Array<{ total: number | string }>>(
                        'SELECT COUNT(*) AS total FROM service_whitelist_players WHERE service_id = ? FOR UPDATE', [serviceId]
                    );
                    if (Number(counts[0].total) >= MAX_WHITELIST_PLAYERS) {
                        return { result: 'full' as const, revision: 0 };
                    }
                }

                const reason = `Admin edit: ${admins[0]?.username ?? admin.userId}`.slice(0, MAX_WHITELIST_REASON_LENGTH);
                if (existing) {
                    await connection.query(
                        `UPDATE service_whitelist_requests
                         SET player_name = ?, reason = ?, status = 'approved', requested_by = ?, reviewed_by = ?
                         WHERE id = ?`,
                        [profile.name, reason, userId, admin.userId, existing.id]
                    );
                } else {
                    await connection.query(
                        `INSERT INTO service_whitelist_requests
                            (service_id, player_uuid, player_name, reason, status, requested_by, reviewed_by)
                         VALUES (?, ?, ?, ?, 'approved', ?, ?)`,
                        [serviceId, profile.uuid, profile.name, reason, userId, admin.userId]
                    );
                }

                let revision = Number(services[0].whitelist_revision);
                if (!players[0]) {
                    await connection.query(
                        `INSERT INTO service_whitelist_players (service_id, player_uuid, player_name, approved_by)
                         VALUES (?, ?, ?, ?)`,
                        [serviceId, profile.uuid, profile.name, admin.userId]
                    );
                }
                if (!players[0] || players[0].player_name !== profile.name) {
                    if (players[0]) {
                        await connection.query(
                            'UPDATE service_whitelist_players SET player_name = ? WHERE service_id = ? AND player_uuid = ?',
                            [profile.name, serviceId, profile.uuid]
                        );
                    }
                    revision = nextWhitelistRevision(revision, true);
                    await connection.query('UPDATE service_status SET whitelist_revision = ? WHERE id = ?', [revision, serviceId]);
                }

                const audit = auditStatement(
                    res,
                    admin.userId,
                    'whitelist.admin.granted',
                    { playerName: profile.name, playerUuid: profile.uuid, userId },
                    'service',
                    String(serviceId)
                );
                await connection.query(audit.sql, audit.params);
                return { result: 'granted' as const, revision };
            }
        );

        if (outcome.result === 'user_missing' || outcome.result === 'service_missing') {
            sendFailure(res, 404, outcome.result === 'user_missing' ? 'Benutzer nicht gefunden' : 'Service nicht gefunden');
            return;
        }
        if (outcome.result === 'duplicate') {
            sendFailure(res, 409, 'Für dieses Minecraft-Profil existiert bereits eine Freigabe oder ein Antrag eines anderen Benutzers');
            return;
        }
        if (outcome.result === 'full') {
            sendFailure(res, 409, 'Die Whitelist ist voll');
            return;
        }

        logAuditCommitted(res, admin.userId, 'whitelist.admin.granted', 'service', String(serviceId), {
            playerUuid: profile.uuid,
            userId
        });
        await saveUserMinecraftAccount(userId, profile.uuid, profile.name).catch((error: unknown) => {
            logApiFailure(res, 'api.admin.whitelist_grant_account_save_failed', error);
        });
        sendSuccess(res, { revision: outcome.revision });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_grant_failed', error);
        sendServerFailure(res);
    }
}

async function revokeWhitelistPlayerAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const serviceId = getPositiveInteger(req.params.serviceId);
    const playerUuid = typeof req.params.uuid === 'string' ? req.params.uuid : '';
    if (!serviceId) {
        sendFailure(res, 400, 'Ungültige Service-ID');
        return;
    }
    let canonicalUuid: string;
    try {
        canonicalUuid = canonicalizeMinecraftUuid(playerUuid);
    } catch {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }

    try {
        const outcome = await withDatabaseTransaction(
            ['SELECT', 'DELETE', 'UPDATE', 'UPDATE', 'INSERT'],
            async (connection) => {
                const services = await connection.query<Array<{ whitelist_revision: number | string }>>(
                    'SELECT whitelist_revision FROM service_status WHERE id = ? FOR UPDATE',
                    [serviceId]
                );
                if (!services[0]) return { result: 'service_missing' as const, revision: 0 };

                const removed = await connection.query<UpsertResult>(
                    'DELETE FROM service_whitelist_players WHERE service_id = ? AND player_uuid = ?',
                    [serviceId, canonicalUuid]
                );
                if (removed.affectedRows === 0) return { result: 'player_missing' as const, revision: Number(services[0].whitelist_revision) };

                const revision = nextWhitelistRevision(Number(services[0].whitelist_revision), true);
                await connection.query('UPDATE service_status SET whitelist_revision = ? WHERE id = ?', [revision, serviceId]);
                await connection.query(
                    `UPDATE service_whitelist_requests
                     SET status = 'revoked', reviewed_by = ?
                     WHERE service_id = ? AND player_uuid = ?`,
                    [admin.userId, serviceId, canonicalUuid]
                );
                const audit = auditStatement(
                    res,
                    admin.userId,
                    'whitelist.player.revoked',
                    { playerUuid: canonicalUuid },
                    'service',
                    String(serviceId)
                );
                await connection.query(audit.sql, audit.params);
                return { result: 'removed' as const, revision };
            }
        );

        if (outcome.result === 'service_missing' || outcome.result === 'player_missing') {
            sendFailure(res, 404, outcome.result === 'service_missing' ? 'Service nicht gefunden' : 'Spieler nicht auf der Whitelist');
            return;
        }
        logAuditCommitted(res, admin.userId, 'whitelist.player.revoked', 'service', String(serviceId), {
            playerUuid: canonicalUuid
        });
        sendSuccess(res, { revision: outcome.revision });
    } catch (error) {
        logApiFailure(res, 'api.admin.whitelist_player_revoke_failed', error);
        sendServerFailure(res);
    }
}

async function removeOwnWhitelistEntryAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const requestId = getPositiveInteger(req.params.id);
    if (!requestId) {
        sendFailure(res, 400, 'Ungültige Antrags-ID');
        return;
    }

    try {
        const outcome = await withDatabaseTransaction(
            ['SELECT', 'SELECT', 'DELETE', 'UPDATE', 'DELETE', 'INSERT'],
            async (connection) => {
                const requests = await connection.query<Array<{ service_id: number; player_uuid: string; player_name: string; service_name: string; status: string }>>(
                    `SELECT r.service_id, r.player_uuid, r.player_name, s.name AS service_name, r.status
                     FROM service_whitelist_requests r
                     JOIN service_status s ON s.id = r.service_id
                     WHERE r.id = ? AND r.requested_by = ? FOR UPDATE`,
                    [requestId, session.userId]
                );
                const request = requests[0];
                if (!request) return 'missing' as const;

                if (request.status === 'approved') {
                    const services = await connection.query<Array<{ whitelist_revision: number | string }>>(
                        'SELECT whitelist_revision FROM service_status WHERE id = ? FOR UPDATE',
                        [request.service_id]
                    );
                    const removed = await connection.query<UpsertResult>(
                        'DELETE FROM service_whitelist_players WHERE service_id = ? AND player_uuid = ?',
                        [request.service_id, request.player_uuid]
                    );
                    if (services[0] && removed.affectedRows > 0) {
                        await connection.query(
                            'UPDATE service_status SET whitelist_revision = ? WHERE id = ?',
                            [nextWhitelistRevision(Number(services[0].whitelist_revision), true), request.service_id]
                        );
                    }
                }
                await connection.query('DELETE FROM service_whitelist_requests WHERE id = ?', [requestId]);
                const audit = auditStatement(
                    res,
                    session.userId,
                    'whitelist.self_removed',
                    {
                        playerUuid: request.player_uuid,
                        playerName: request.player_name,
                        serviceName: request.service_name,
                        previousStatus: request.status
                    },
                    'service',
                    String(request.service_id)
                );
                await connection.query(audit.sql, audit.params);
                return 'removed' as const;
            }
        );

        if (outcome === 'missing') {
            sendFailure(res, 404, 'Whitelist-Eintrag nicht gefunden');
            return;
        }
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.account.whitelist_remove_failed', error);
        sendServerFailure(res);
    }
}

export function createWhitelistRouter(): Router {
    const router = Router();
    router.delete('/account/whitelist/:id', removeOwnWhitelistEntryAPIRoute);
    router.get('/services/whitelist', getWhitelistAPIRoute);
    router.post('/services/whitelist/requests', createWhitelistRequestAPIRoute);
    return router;
}

export function createAdminWhitelistRouter(): Router {
    const router = Router();
    router.get('/requests', getAdminWhitelistRequestsAPIRoute);
    router.get('/players', getAdminWhitelistPlayersAPIRoute);
    router.get('/history', getAdminWhitelistHistoryAPIRoute);
    router.patch('/requests/:id', reviewWhitelistRequestAPIRoute);
    router.post('/grant', grantWhitelistAPIRoute);
    router.delete('/players/:serviceId/:uuid', revokeWhitelistPlayerAPIRoute);
    return router;
}
