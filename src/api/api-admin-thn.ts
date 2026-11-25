import { Router, type Request, type Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { executeTransaction, query } from '@tattyhost/SQLutils';
import { auditStatement, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { isCanonicalPlayerUuid } from './thn-player-contract.ts';
import { isLoopbackHost, isPlayerBackupId, isWorldBackupId, isWorldName, PluginApiError, ThnPluginClient } from './thn-plugin-client.ts';

async function requireConfiguredThnService(idValue: string): Promise<void> {
    const id = Number(idValue);
    if (!Number.isSafeInteger(id) || id < 1) throw new PluginApiError(400, 'Ungültige Service-ID');
    const rows = await query<{ id: number }>(
        "SELECT id FROM service_status WHERE id = ? AND service_type = 'minecraft' AND thnlink_enabled = TRUE", [id]
    );
    if (!rows[0]) throw new PluginApiError(404, 'THNLink ist für diesen Service nicht aktiviert');
}

async function getClient(req: Request): Promise<ThnPluginClient> {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new PluginApiError(400, 'Ungültige Service-ID');
    const rows = await query<{ plugin_api_port: number | null; plugin_api_host_override: string | null; last_reported_at: Date | null }>(
        "SELECT plugin_api_port, plugin_api_host_override, last_reported_at FROM service_status WHERE id = ? AND service_type = 'minecraft' AND thnlink_enabled = TRUE", [id]
    );
    if (!rows[0]) throw new PluginApiError(404, 'THNLink ist für diesen Service nicht aktiviert');
    const lastHeartbeat = rows[0].last_reported_at && new Date(rows[0].last_reported_at).getTime();
    if (!lastHeartbeat || !Number.isFinite(lastHeartbeat) || Date.now() - lastHeartbeat > 90_000) {
        throw new PluginApiError(503, 'Server offline oder wird neu gestartet');
    }
    return new ThnPluginClient(rows[0].plugin_api_host_override || '127.0.0.1', Number(rows[0].plugin_api_port));
}

function pluginFailure(res: Response, error: unknown) {
    if (error instanceof PluginApiError) {
        sendFailure(res, error.status, error.message);
        return;
    }
    logApiFailure(res, 'api.admin.thn.failed', error);
    sendServerFailure(res);
}

async function audit(res: Response, userId: string, action: string, serviceId: string, target: string) {
    const details = { serviceId, target };
    await executeTransaction([auditStatement(res, userId, action, details, 'service', serviceId)]);
    logAuditCommitted(res, userId, action, 'service', serviceId, details);
}

type JsonAction = (client: ThnPluginClient, req: Request) => Promise<object>;

function jsonRoute(action: JsonAction, auditAction?: string) {
    return async (req: Request, res: Response) => {
        const admin = requireAdmin(res);
        if (!admin) return;
        const uuid = req.params.uuid;
        const world = req.params.world;
        const backupId = req.params.backupId;
        if ((uuid !== undefined && !isCanonicalPlayerUuid(uuid)) ||
            (world !== undefined && !isWorldName(world)) ||
            (backupId !== undefined && !isPlayerBackupId(backupId, true))) {
            sendFailure(res, 400, 'Ungültige Anfrage');
            return;
        }
        try {
            const target = [uuid || world || 'all', backupId].filter(Boolean).join(':');
            if (auditAction) await audit(res, admin.userId, `${auditAction}.requested`, String(req.params.id), target);
            const client = await getClient(req);
            const data = await action(client, req);
            if (auditAction) {
                try {
                    await audit(res, admin.userId, `${auditAction}.completed`, String(req.params.id), target);
                } catch (error) {
                    logApiFailure(res, 'api.admin.thn.audit_completion_failed', error);
                    sendFailure(res, 500, 'Aktion wurde ausgeführt, aber das Audit-Protokoll konnte nicht abgeschlossen werden');
                    return;
                }
            }
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json({ success: true, ...data });
        } catch (error) {
            pluginFailure(res, error);
        }
    };
}

function downloadRoute(kind: 'player' | 'world') {
    return async (req: Request, res: Response) => {
        const admin = requireAdmin(res);
        if (!admin) return;
        const { uuid, world, backupId } = req.params;
        if ((kind === 'player' && (!isCanonicalPlayerUuid(uuid) || !isPlayerBackupId(backupId))) ||
            (kind === 'world' && (!isWorldName(world) || !isWorldBackupId(backupId)))) {
            sendFailure(res, 400, 'Ungültige Backup-Angaben');
            return;
        }
        try {
            const action = `admin.thn.${kind}_backup.download`;
            const target = `${kind === 'player' ? uuid : world}:${backupId}`;
            await audit(res, admin.userId, `${action}.requested`, String(req.params.id), target);
            const client = await getClient(req);
            const source = kind === 'player' ? await client.downloadPlayer(uuid, backupId) : await client.downloadWorld(world, backupId);
            const length = source.headers['content-length'];
            if ((kind === 'world' && length === undefined) ||
                (length !== undefined && !/^[0-9]{1,20}$/.test(length))) {
                source.destroy();
                throw new PluginApiError(502, 'Ungültige Backup-Größe');
            }
            res.status(200).set({
                'Content-Type': kind === 'player' ? 'application/json' : 'application/zip',
                'Content-Disposition': `attachment; filename="${kind === 'player' ? uuid : world}-${backupId}.${kind === 'player' ? 'json' : 'zip'}"`,
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            if (length !== undefined) res.setHeader('Content-Length', length);
            res.once('close', () => { if (!source.complete) source.destroy(); });
            await pipeline(source, res);
            await audit(res, admin.userId, `${action}.completed`, String(req.params.id), target);
        } catch (error) {
            if (res.headersSent || res.destroyed) {
                logApiFailure(res, 'api.admin.thn.download_failed', error);
                res.destroy();
                return;
            }
            pluginFailure(res, error);
        }
    };
}

async function setHostOverride(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const id = Number(req.params.id);
    const host = req.body?.host;
    if (!Number.isSafeInteger(id) || id < 1 ||
        !(host === null || (typeof host === 'string' && isLoopbackHost(host)))) {
        sendFailure(res, 400, 'Nur Loopback-IP-Adressen sind erlaubt');
        return;
    }
    try {
        const rows = await query<{ id: number }>("SELECT id FROM service_status WHERE id = ? AND service_type = 'minecraft' AND thnlink_enabled = TRUE", [id]);
        if (!rows.length) {
            sendFailure(res, 404, 'THNLink ist für diesen Service nicht aktiviert');
            return;
        }
        await executeTransaction([
            { sql: 'UPDATE service_status SET plugin_api_host_override = ? WHERE id = ?', params: [host, id] },
            auditStatement(res, admin.userId, 'admin.thn.host_override.updated', {}, 'service', String(id))
        ]);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.thn.host_override_failed', error);
        sendServerFailure(res);
    }
}

async function getStoredStats(req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    if (!isCanonicalPlayerUuid(req.params.uuid)) {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }
    try {
        await requireConfiguredThnService(req.params.id);
        const rows = await query<{ stats_json: string }>(
            'SELECT stats_json FROM minecraft_player_stats WHERE player_uuid = ?', [req.params.uuid]
        );
        if (!rows[0]) {
            sendFailure(res, 404, 'Spielerstatistik nicht gefunden');
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { player: JSON.parse(rows[0].stats_json) });
    } catch (error) {
        pluginFailure(res, error);
    }
}

async function getAudit(req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        sendFailure(res, 400, 'Ungültige Service-ID');
        return;
    }
    try {
        await requireConfiguredThnService(req.params.id);
        const entries = await query<{ id: number; action: string; details: string | null; logged_at: Date; username: string | null }>(
            `SELECT a.id, a.action, a.details, a.logged_at, u.username
             FROM audit_logs a LEFT JOIN users u ON u.uuid = a.user_uuid
             WHERE a.target_type = 'service' AND a.target_id = ?
               AND (a.action LIKE 'admin.thn.%' OR a.action LIKE 'whitelist.%')
             ORDER BY a.id DESC LIMIT 100`, [String(id)]
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { entries });
    } catch (error) {
        pluginFailure(res, error);
    }
}

export function createAdminThnRouter(): Router {
    const router = Router();
    router.put('/:id/host-override', setHostOverride);
    router.get('/:id/status', jsonRoute((client) => client.status()));
    router.get('/:id/audit', getAudit);
    router.get('/:id/players', jsonRoute((client) => client.players()));
    router.get('/:id/players/:uuid/stats', jsonRoute((client, req) => client.playerStats(req.params.uuid)));
    router.get('/:id/players/:uuid/stored-stats', getStoredStats);
    router.get('/:id/players/:uuid/backups', jsonRoute((client, req) => client.playerBackups(req.params.uuid), 'admin.thn.player_backup.list'));
    router.post('/:id/players/:uuid/backups', jsonRoute((client, req) => client.createPlayerBackup(req.params.uuid), 'admin.thn.player_backup.create'));
    router.get('/:id/players/:uuid/backups/:backupId', downloadRoute('player'));
    router.post('/:id/players/:uuid/backups/:backupId/restore', jsonRoute((client, req) => client.restorePlayerBackup(req.params.uuid, req.params.backupId), 'admin.thn.player_backup.restore'));
    router.get('/:id/worlds/backups', jsonRoute((client) => client.worldBackups(), 'admin.thn.world_backup.list'));
    router.post('/:id/worlds/:world/backups', jsonRoute((client, req) => client.createWorldBackup(req.params.world), 'admin.thn.world_backup.create'));
    router.get('/:id/worlds/:world/backups/:backupId', downloadRoute('world'));
    return router;
}
