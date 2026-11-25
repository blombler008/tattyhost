import { randomInt } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { query, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';
import { authenticateServiceApiKey } from './api-services.ts';
import { logApiFailure, requireUser, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { hashLinkCode, isCanonicalPlayerUuid, isLinkCode, ownPlayerStats, parsePlayerBatch, parsePlayerStats } from './thn-player-contract.ts';

async function createLinkCode(req: Request, res: Response) {
    const user = requireUser(res);
    if (!user) return;
    const uuid = req.params.uuid;
    if (!isCanonicalPlayerUuid(uuid)) {
        sendFailure(res, 400, 'Ungültige Minecraft-UUID');
        return;
    }

    try {
        const code = await withDatabaseTransaction(['SELECT', 'SELECT', 'SELECT', 'INSERT'], async (connection) => {
            await connection.query(
                'INSERT IGNORE INTO minecraft_link_attempts (player_uuid, attempts, window_started) VALUES (?, 0, CURRENT_TIMESTAMP)',
                [uuid]
            );
            await connection.query('SELECT player_uuid FROM minecraft_link_attempts WHERE player_uuid = ? FOR UPDATE', [uuid]);
            const accounts = await connection.query<Array<{ player_uuid: string }>>(
                'SELECT player_uuid FROM user_minecraft_accounts WHERE user_uuid = ? AND player_uuid = ? FOR UPDATE',
                [user.userId, uuid]
            );
            if (!accounts[0]) return null;
            const linked = await connection.query<Array<{ user_uuid: string }>>(
                'SELECT user_uuid FROM verified_minecraft_links WHERE player_uuid = ? FOR UPDATE', [uuid]
            );
            if (linked[0] && linked[0].user_uuid !== user.userId) return 'already-linked';
            for (let attempt = 0; attempt < 10; attempt++) {
                const candidate = randomInt(1_000_000).toString().padStart(6, '0');
                const hash = hashLinkCode(uuid, candidate);
                const collision = await connection.query<Array<{ user_uuid: string }>>(
                    `SELECT user_uuid FROM minecraft_link_codes
                     WHERE player_uuid = ? AND code_hash = ? AND user_uuid <> ? AND expires_at > CURRENT_TIMESTAMP`,
                    [uuid, hash, user.userId]
                );
                if (collision.length) continue;
                await connection.query(
                    `INSERT INTO minecraft_link_codes (user_uuid, player_uuid, code_hash, expires_at)
                     VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE))
                     ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at)`,
                    [user.userId, uuid, hash]
                );
                return candidate;
            }
            throw new Error('Unable to generate a unique link code');
        });
        if (code === null) {
            sendFailure(res, 404, 'Minecraft-Konto nicht gefunden');
            return;
        }
        if (code === 'already-linked') {
            sendFailure(res, 409, 'Minecraft-Konto ist bereits verifiziert');
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { code, expiresInSeconds: 600 });
    } catch (error) {
        logApiFailure(res, 'api.minecraft.link_code_failed', error);
        sendServerFailure(res);
    }
}

async function verifyLink(req: Request, res: Response) {
    const service = await authenticateServiceApiKey(req, res);
    if (!service) return;
    if (!req.is('application/json')) {
        res.status(415).json({ error: 'Content-Type muss application/json sein' });
        return;
    }
    const { uuid, code } = req.body || {};
    if (!isCanonicalPlayerUuid(uuid) || !isLinkCode(code)) {
        res.status(400).json({ error: 'Ungültige UUID oder Code' });
        return;
    }
    try {
        const result = await withDatabaseTransaction(['WRITE', 'SELECT', 'SELECT', 'SELECT', 'INSERT', 'DELETE'], async (connection) => {
            await connection.query(
                `INSERT INTO minecraft_link_attempts (player_uuid, attempts, window_started)
                 VALUES (?, 1, CURRENT_TIMESTAMP)
                 ON DUPLICATE KEY UPDATE
                   attempts = IF(window_started < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE), 1, attempts + 1),
                   window_started = IF(window_started < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE), CURRENT_TIMESTAMP, window_started)`,
                [uuid]
            );
            const attempts = await connection.query<Array<{ attempts: number }>>(
                'SELECT attempts FROM minecraft_link_attempts WHERE player_uuid = ? FOR UPDATE', [uuid]
            );
            if (Number(attempts[0].attempts) > 5) return 'rate-limited';
            const codes = await connection.query<Array<{ user_uuid: string }>>(
                `SELECT user_uuid FROM minecraft_link_codes
                 WHERE player_uuid = ? AND code_hash = ? AND expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
                [uuid, hashLinkCode(uuid, code)]
            );
            if (codes.length !== 1) return 'invalid';
            const links = await connection.query<Array<{ user_uuid: string }>>(
                'SELECT user_uuid FROM verified_minecraft_links WHERE player_uuid = ? FOR UPDATE', [uuid]
            );
            if (links[0] && links[0].user_uuid !== codes[0].user_uuid) return 'already-linked';
            if (!links[0]) {
                await connection.query('INSERT INTO verified_minecraft_links (player_uuid, user_uuid) VALUES (?, ?)', [uuid, codes[0].user_uuid]);
            }
            await connection.query('DELETE FROM minecraft_link_codes WHERE player_uuid = ?', [uuid]);
            return 'verified';
        });
        if (result === 'rate-limited') {
            res.status(429).json({ error: 'Zu viele Versuche; bitte später erneut versuchen' });
            return;
        }
        if (result === 'invalid') {
            res.status(400).json({ error: 'Code ungültig oder abgelaufen' });
            return;
        }
        if (result === 'already-linked') {
            res.status(409).json({ error: 'Minecraft-Konto ist bereits verifiziert' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        logApiFailure(res, 'api.minecraft.link_verify_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
    }
}

async function putStats(req: Request, res: Response) {
    const service = await authenticateServiceApiKey(req, res);
    if (!service) return;
    if (!req.is('application/json')) {
        res.status(415).json({ error: 'Content-Type muss application/json sein' });
        return;
    }
    if (!Array.isArray(req.body?.players) || req.body.players.length > 10_000) {
        res.status(400).json({ error: 'Ungültige Spielerliste' });
        return;
    }
    const batch = parsePlayerBatch(req.body.players, Date.now());
    if (batch.rejected) {
        logEvent('warn', 'api.player_stats.invalid_entries', {
            serviceId: service.serviceId, count: batch.rejected
        });
    }
    try {
        if (batch.players.length) {
            await withDatabaseTransaction(['UPSERT'], async (connection) => {
                for (const player of batch.players) {
                    await connection.query(
                        `INSERT INTO minecraft_player_stats (player_uuid, service_id, last_seen, stats_json)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                           service_id = IF(VALUES(last_seen) >= last_seen, VALUES(service_id), service_id),
                           stats_json = IF(VALUES(last_seen) >= last_seen, VALUES(stats_json), stats_json),
                           last_seen = GREATEST(last_seen, VALUES(last_seen))`,
                        [player.uuid, service.serviceId, player.lastSeen, JSON.stringify(player)]
                    );
                }
            });
        }
        res.status(204).end();
    } catch (error) {
        logApiFailure(res, 'api.player_stats.save_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
    }
}

async function getServiceStats(req: Request, res: Response) {
    if (!await authenticateServiceApiKey(req, res)) return;
    const uuid = req.query.uuid;
    if (!isCanonicalPlayerUuid(uuid)) {
        res.status(400).json({ error: 'Ungültige Minecraft-UUID' });
        return;
    }
    try {
        const rows = await query<{ stats_json: string }>(
            'SELECT stats_json FROM minecraft_player_stats WHERE player_uuid = ?', [uuid]
        );
        if (!rows[0]) {
            res.status(404).json({ error: 'Spieler nicht gefunden' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(JSON.parse(rows[0].stats_json));
    } catch (error) {
        logApiFailure(res, 'api.player_stats.load_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
    }
}

async function loadOwnedStats(uuid: string, userId: string): Promise<string | null> {
    const rows = await query<{ stats_json: string }>(
        `SELECT s.stats_json FROM minecraft_player_stats s
         JOIN verified_minecraft_links v ON v.player_uuid = s.player_uuid
         WHERE s.player_uuid = ? AND v.user_uuid = ?`, [uuid, userId]
    );
    return rows[0]?.stats_json ?? null;
}

export function createOwnStatsHandler(load: typeof loadOwnedStats = loadOwnedStats) {
    return async (req: Request, res: Response) => {
        const user = requireUser(res);
        if (!user) return;
        const uuid = req.params.uuid;
        if (!isCanonicalPlayerUuid(uuid)) {
            sendFailure(res, 400, 'Ungültige Minecraft-UUID');
            return;
        }
        try {
            const stored = await load(uuid, user.userId);
            if (!stored) {
                sendFailure(res, 404, 'Spielerstatistik nicht gefunden oder Konto nicht verifiziert');
                return;
            }
            const player = parsePlayerStats(JSON.parse(stored), Date.now());
            if (!player) throw new Error('Invalid stored player stats');
            res.setHeader('Cache-Control', 'private, no-store');
            sendSuccess(res, { player: ownPlayerStats(player, Date.now()) });
        } catch (error) {
            logApiFailure(res, 'api.account.player_stats_load_failed', error);
            sendServerFailure(res);
        }
    };
}

export function createThnPlayersRouter(): Router {
    const router = Router();
    router.post('/account/minecraft/:uuid/link-code', createLinkCode);
    router.get('/account/minecraft/:uuid/stats', createOwnStatsHandler());
    router.put('/services/players/link', verifyLink);
    router.put('/services/players/stats', putStats);
    router.get('/services/players/stats', getServiceStats);
    return router;
}
