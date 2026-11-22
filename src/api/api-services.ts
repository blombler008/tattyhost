import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { executeTransaction, query, type SqlParameter } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';
import { logOperationalEvent } from '../logging/operational-log.ts';
import { auditStatement, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';

const VALID_SERVICE_STATUSES = ['online', 'offline', 'maintenance'] as const;
const SERVICE_STATUS_PUSH_INTERVAL_MS = 10_000;

type PublicServiceStatus = {
    id: number;
    name: string;
    address: string;
    status: 'online' | 'offline' | 'maintenance';
    details: string;
};

const serviceStatusClients = new Set<Response>();
let serviceStatusPushTimer: NodeJS.Timeout | undefined;
let lastPushedServiceStatus = '';
let serviceStatusPushErrorLogged = false;

function hashServiceStatusApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

async function authenticateServiceStatusApiKey(req: Request, res: Response): Promise<{ actorId: string | null } | null> {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9+/]{64})$/.exec(authorization);
    const apiKey = match?.[1];
    if (!apiKey || Buffer.from(apiKey, 'base64').toString('base64') !== apiKey) {
        logEvent('warn', 'api.service_status.unauthorized', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
        });
        sendFailure(res, 401, 'Ungültiger API-Schlüssel');
        return null;
    }

    try {
        const keys = await query<{ token_hash: string; created_by: string | null }>(
            'SELECT token_hash, created_by FROM service_status_api_keys WHERE id = 1 LIMIT 1'
        );
        const storedHash = keys[0]?.token_hash;
        if (!storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        const expected = Buffer.from(storedHash, 'hex');
        const supplied = Buffer.from(hashServiceStatusApiKey(apiKey), 'hex');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        return { actorId: keys[0].created_by };
    } catch (error) {
        logApiFailure(res, 'api.service_status.authentication_failed', error);
        sendServerFailure(res);
        return null;
    }
}

async function getServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    try {
        const keys = await query<{ created_at: Date }>(
            'SELECT created_at FROM service_status_api_keys WHERE id = 1 LIMIT 1'
        );
        sendSuccess(res, {
            configured: Boolean(keys[0]),
            createdAt: keys[0]?.created_at || null
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_load_failed', error);
        sendServerFailure(res);
    }
}

async function rotateServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const apiKey = randomBytes(48).toString('base64');
    try {
        await executeTransaction([
            {
                sql: `INSERT INTO service_status_api_keys (id, token_hash, created_by)
                      VALUES (1, ?, ?)
                      ON DUPLICATE KEY UPDATE
                        token_hash = VALUES(token_hash),
                        created_by = VALUES(created_by),
                        created_at = CURRENT_TIMESTAMP`,
                params: [hashServiceStatusApiKey(apiKey), admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.service_status_api_key.rotated',
                { keyLength: apiKey.length, encoding: 'base64' },
                'service_status_api_key',
                '1'
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.service_status_api_key.rotated',
            'service_status_api_key',
            '1',
            { keyLength: apiKey.length, encoding: 'base64' }
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { apiKey });
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_rotate_failed', error);
        sendServerFailure(res);
    }
}

async function revokeServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    try {
        await executeTransaction([
            { sql: 'DELETE FROM service_status_api_keys WHERE id = 1' },
            auditStatement(
                res,
                admin.userId,
                'admin.service_status_api_key.revoked',
                {},
                'service_status_api_key',
                '1'
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.service_status_api_key.revoked',
            'service_status_api_key',
            '1'
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_revoke_failed', error);
        sendServerFailure(res);
    }
}

async function getServicesAPIRoute(_req: Request, res: Response) {
    try {
        const services = await getPublicServiceStatuses();
        sendSuccess(res, { services });
    } catch (error) {
        logApiFailure(res, 'api.services.load_failed', error);
        sendServerFailure(res);
    }
}

async function getPublicServiceStatuses(): Promise<PublicServiceStatus[]> {
    return query<PublicServiceStatus>(
            `SELECT id, name, address,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 'offline'
                        ELSE status
                    END AS status,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 'Keine Statusmeldung seit über 60 Sekunden'
                        ELSE details
                    END AS details
             FROM service_status ORDER BY sort_order, id`
        );
}

function writeServiceStatusEvent(client: Response, payload: string) {
    if (client.destroyed || client.writableEnded) return false;
    try {
        client.write(`event: services\ndata: ${payload}\n\n`);
        return true;
    } catch (error) {
        logEvent('warn', 'api.services.push_client_write_failed', { error });
        return false;
    }
}

async function refreshServiceStatusPush() {
    try {
        const services = await getPublicServiceStatuses();
        serviceStatusPushErrorLogged = false;
        const payload = JSON.stringify({ services });
        if (payload === lastPushedServiceStatus) return;
        lastPushedServiceStatus = payload;
        for (const client of serviceStatusClients) {
            if (!writeServiceStatusEvent(client, payload)) serviceStatusClients.delete(client);
        }
    } catch (error) {
        if (serviceStatusPushErrorLogged) return;
        serviceStatusPushErrorLogged = true;
        logEvent('error', 'api.services.push_refresh_failed', { error });
        logOperationalEvent({
            event: 'api.services.push_refresh_failed',
            level: 'error',
            details: { error }
        });
    }
}

function startServiceStatusPushTimer() {
    if (serviceStatusPushTimer) return;
    serviceStatusPushTimer = setInterval(() => void refreshServiceStatusPush(), SERVICE_STATUS_PUSH_INTERVAL_MS);
    serviceStatusPushTimer.unref();
}

async function serviceStatusEventsAPIRoute(_req: Request, res: Response) {
    try {
        const services = await getPublicServiceStatuses();
        const payload = JSON.stringify({ services });
        const existingClients = [...serviceStatusClients];

        res.status(200).set({
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write('retry: 5000\n\n');
        writeServiceStatusEvent(res, payload);
        serviceStatusClients.add(res);

        if (payload !== lastPushedServiceStatus) {
            lastPushedServiceStatus = payload;
            for (const client of existingClients) {
                if (!writeServiceStatusEvent(client, payload)) serviceStatusClients.delete(client);
            }
        }

        const heartbeat = setInterval(() => {
            if (res.destroyed || res.writableEnded) return;
            try {
                res.write(': keep-alive\n\n');
            } catch (error) {
                logEvent('warn', 'api.services.push_heartbeat_failed', { error });
                clearInterval(heartbeat);
                serviceStatusClients.delete(res);
            }
        }, 25_000);
        heartbeat.unref();
        res.on('close', () => {
            clearInterval(heartbeat);
            serviceStatusClients.delete(res);
            if (serviceStatusClients.size === 0 && serviceStatusPushTimer) {
                clearInterval(serviceStatusPushTimer);
                serviceStatusPushTimer = undefined;
            }
        });
        startServiceStatusPushTimer();
    } catch (error) {
        logApiFailure(res, 'api.services.push_connect_failed', error);
        sendServerFailure(res);
    }
}

async function updateServiceStatusFromServerAPIRoute(req: Request, res: Response) {
    const apiKeyAuth = await authenticateServiceStatusApiKey(req, res);
    if (!apiKeyAuth) return;

    const { name, status, details } = req.body || {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!serviceName || serviceName.length > 64 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        (details !== undefined && typeof details !== 'string') || serviceDetails.length > 255) {
        sendFailure(res, 400, 'Ungültige Serverstatus-Angaben');
        return;
    }

    try {
        const services = await query<{
            id: number;
            status: string;
            details: string;
            heartbeat_expired: number | string | boolean;
        }>(
            `SELECT id, status, details,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 1 ELSE 0
                    END AS heartbeat_expired
             FROM service_status WHERE name = ? LIMIT 1`,
            [serviceName]
        );
        const service = services[0];
        if (!service) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        const detailsToSave = details === undefined ? service.details : serviceDetails;
        const wasHeartbeatExpired = Number(service.heartbeat_expired) === 1;
        const statusChanged = service.status !== status || (wasHeartbeatExpired && status !== 'offline');
        const detailsChanged = details !== undefined && service.details !== detailsToSave;
        const statements: Array<{ sql: string; params: SqlParameter[] }> = [{
            sql: `UPDATE service_status
                  SET status = ?, details = ?, updated_by = ?, last_reported_at = CURRENT_TIMESTAMP
                  WHERE id = ?`,
            params: [status, detailsToSave, apiKeyAuth.actorId, service.id]
        }];
        if (statusChanged || detailsChanged) {
            statements.push(auditStatement(
                res,
                apiKeyAuth.actorId,
                'service_status.reported',
                { status, source: 'api_key' },
                'service',
                String(service.id)
            ));
        }
        await executeTransaction(statements);
        void refreshServiceStatusPush();
        if (statusChanged || detailsChanged) {
            logAuditCommitted(
                res,
                apiKeyAuth.actorId,
                'service_status.reported',
                'service',
                String(service.id),
                { status, source: 'api_key' }
            );
        }
        sendSuccess(res, { updated: true });
    } catch (error) {
        logApiFailure(res, 'api.service_status.update_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminServicesAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    getServicesAPIRoute(_req, res);
}

async function updateServiceStatusAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const serviceId = Number(req.params.id);
    const { status, details } = req.body || {};
    if (!Number.isInteger(serviceId) || serviceId <= 0 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        typeof details !== 'string' || details.length > 255) {
        sendFailure(res, 400, 'Ungültige Serverstatus-Angaben');
        return;
    }

    try {
        await executeTransaction([
            {
                sql: 'UPDATE service_status SET status = ?, details = ?, updated_by = ? WHERE id = ?',
                params: [status, details.trim(), admin.userId, serviceId]
            },
            auditStatement(res, admin.userId, 'admin.service.status_changed', { status }, 'service', String(serviceId))
        ]);
        void refreshServiceStatusPush();
        logAuditCommitted(res, admin.userId, 'admin.service.status_changed', 'service', String(serviceId), { status });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.service_update_failed', error);
        sendServerFailure(res);
    }
}

export function createServicesRouter(): Router {
    const router = Router();
    const servicesRouter = Router();
    servicesRouter.get('/', getServicesAPIRoute);
    servicesRouter.get('/events', serviceStatusEventsAPIRoute);
    servicesRouter.put('/status', updateServiceStatusFromServerAPIRoute);
    router.use('/services', servicesRouter);
    return router;
}

export function createAdminServicesRouter(): Router {
    const router = Router();
    router.get('/', getAdminServicesAPIRoute);
    router.get('/status-key', getServiceStatusApiKeyAPIRoute);
    router.post('/status-key', rotateServiceStatusApiKeyAPIRoute);
    router.delete('/status-key', revokeServiceStatusApiKeyAPIRoute);
    router.put('/:id', updateServiceStatusAPIRoute);
    return router;
}
