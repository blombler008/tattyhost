import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UpsertResult } from 'mariadb';
import { execute, executeTransaction, query, type SqlParameter, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';
import { logOperationalEvent } from '../logging/operational-log.ts';
import { auditStatement, isDuplicateEntry, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';

const VALID_SERVICE_STATUSES = ['online', 'offline', 'maintenance'] as const;
const SERVICE_STATUS_PUSH_INTERVAL_MS = 10_000;
const HEARTBEAT_EXPIRED_DETAILS = 'Keine Statusmeldung seit über 60 Sekunden';

function isDatabaseBoolean(value: unknown): boolean {
    if (value === true || value === 1 || value === '1') return true;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    if (!Buffer.isBuffer(value)) return false;
    return value.length === 1 ? value[0] === 1 : value.toString('utf8').toLowerCase() === 'true';
}

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

async function authenticateServiceStatusApiKey(req: Request, res: Response): Promise<{ serviceId: number; actorId: string | null } | null> {
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
        const keys = await query<{ service_id: number; token_hash: string; created_by: string | null }>(
            'SELECT service_id, token_hash, created_by FROM service_status_service_api_keys WHERE token_hash = ? LIMIT 1',
            [hashServiceStatusApiKey(apiKey)]
        );
        const key = keys[0];
        if (!key || !/^[a-f0-9]{64}$/i.test(key.token_hash)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        const expected = Buffer.from(key.token_hash, 'hex');
        const supplied = Buffer.from(hashServiceStatusApiKey(apiKey), 'hex');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        return { serviceId: key.service_id, actorId: key.created_by };
    } catch (error) {
        logApiFailure(res, 'api.service_status.authentication_failed', error);
        sendServerFailure(res);
        return null;
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
    await markExpiredServiceStatuses();
    return query<PublicServiceStatus>(
        'SELECT id, name, address, status, details FROM service_status ORDER BY sort_order, id'
    );
}

async function markExpiredServiceStatuses() {
    await execute(
        `UPDATE service_status
         SET status = 'offline',
             details = '${HEARTBEAT_EXPIRED_DETAILS}',
             last_reported_at = NULL
         WHERE manual_override = FALSE
           AND last_reported_at IS NOT NULL
           AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND`
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

    const { status, details } = req.body || {};
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        (details !== undefined && typeof details !== 'string') || serviceDetails.length > 255) {
        sendFailure(res, 400, 'Ungültige Serverstatus-Angaben');
        return;
    }

    try {
        const services = await query<{
            id: number;
            status: string;
            details: string;
            manual_override: unknown;
        }>(
            `SELECT id, status, details, manual_override
             FROM service_status WHERE id = ? LIMIT 1`,
            [apiKeyAuth.serviceId]
        );
        const service = services[0];
        if (!service) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        if (isDatabaseBoolean(service.manual_override)) {
            sendSuccess(res, { updated: true });
            return;
        }

        const detailsToSave = details === undefined
            ? service.details === HEARTBEAT_EXPIRED_DETAILS ? '' : service.details
            : serviceDetails;
        const statusChanged = service.status !== status;
        const detailsChanged = service.details !== detailsToSave;
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

    try {
        await markExpiredServiceStatuses();
        const services = await query<{
            id: number;
            name: string;
            address: string;
            status: PublicServiceStatus['status'];
            details: string;
            manual_override: unknown;
            api_key_configured: unknown;
            api_key_created_at: Date | null;
        }>(`
            SELECT s.id, s.name, s.address, s.status, s.details, s.manual_override,
                   k.service_id IS NOT NULL AS api_key_configured,
                   k.created_at AS api_key_created_at
            FROM service_status s
            LEFT JOIN service_status_service_api_keys k ON k.service_id = s.id
            ORDER BY s.sort_order, s.id
        `);
        sendSuccess(res, {
            services: services.map((service) => ({
                id: service.id,
                name: service.name,
                address: service.address,
                status: service.status,
                details: service.details,
                manualOverride: isDatabaseBoolean(service.manual_override),
                apiKeyConfigured: isDatabaseBoolean(service.api_key_configured),
                apiKeyCreatedAt: service.api_key_created_at
            }))
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.services_load_failed', error);
        sendServerFailure(res);
    }
}

async function createServiceAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const { name, address, status, details, manualOverride } = req.body || {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceAddress = typeof address === 'string' ? address.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!serviceName || serviceName.length > 64 ||
        !serviceAddress || serviceAddress.length > 255 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        (details !== undefined && typeof details !== 'string') || serviceDetails.length > 255 ||
        (manualOverride !== undefined && typeof manualOverride !== 'boolean')) {
        sendFailure(res, 400, 'Ungültige Service-Angaben');
        return;
    }

    const apiKey = randomBytes(48).toString('base64');
    try {
        const serviceId = await withDatabaseTransaction(
            ['SELECT', 'INSERT', 'INSERT', 'INSERT'],
            async (connection) => {
                const sortRows = await connection.query<Array<{ next_sort_order: number | string }>>(
                    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort_order FROM service_status'
                );
                const sortOrder = Number(sortRows[0]?.next_sort_order || 1);
                const inserted = await connection.query<UpsertResult>(
                    `INSERT INTO service_status
                        (name, address, status, details, sort_order, updated_by, manual_override)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [serviceName, serviceAddress, status, serviceDetails, sortOrder, admin.userId, manualOverride ?? false]
                );
                const id = Number(inserted.insertId);
                if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Service ID was not returned after insert');

                await connection.query(
                    `INSERT INTO service_status_service_api_keys (service_id, token_hash, created_by)
                     VALUES (?, ?, ?)`,
                    [id, hashServiceStatusApiKey(apiKey), admin.userId]
                );
                const audit = auditStatement(
                    res,
                    admin.userId,
                    'admin.service.created',
                    { name: serviceName, address: serviceAddress, status },
                    'service',
                    String(id)
                );
                await connection.query(audit.sql, audit.params);
                return id;
            }
        );

        logAuditCommitted(res, admin.userId, 'admin.service.created', 'service', String(serviceId), {
            name: serviceName,
            address: serviceAddress,
            status
        });
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { serviceId, apiKey });
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Ein Service mit diesem Namen existiert bereits');
            return;
        }
        logApiFailure(res, 'api.admin.service_create_failed', error);
        sendServerFailure(res);
    }
}

async function rotateServiceApiKeyAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const serviceId = Number(req.params.id);
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
        sendFailure(res, 400, 'Ungültige Service-ID');
        return;
    }

    const apiKey = randomBytes(48).toString('base64');
    try {
        const exists = await query<{ id: number }>(
            'SELECT id FROM service_status WHERE id = ? LIMIT 1',
            [serviceId]
        );
        if (!exists[0]) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        await executeTransaction([
            {
                sql: `INSERT INTO service_status_service_api_keys (service_id, token_hash, created_by)
                      VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE
                        token_hash = VALUES(token_hash),
                        created_by = VALUES(created_by),
                        created_at = CURRENT_TIMESTAMP`,
                params: [serviceId, hashServiceStatusApiKey(apiKey), admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.service.api_key.rotated',
                { keyLength: apiKey.length, encoding: 'base64' },
                'service',
                String(serviceId)
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.service.api_key.rotated',
            'service',
            String(serviceId),
            { keyLength: apiKey.length, encoding: 'base64' }
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { apiKey });
    } catch (error) {
        logApiFailure(res, 'api.admin.service_api_key_rotate_failed', error);
        sendServerFailure(res);
    }
}

async function updateServiceAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const serviceId = Number(req.params.id);
    const { name, address, status, details, manualOverride } = req.body || {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceAddress = typeof address === 'string' ? address.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0 ||
        !serviceName || serviceName.length > 64 ||
        !serviceAddress || serviceAddress.length > 255 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        typeof details !== 'string' || serviceDetails.length > 255 ||
        typeof manualOverride !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Service-Angaben');
        return;
    }

    try {
        const services = await query<{ id: number }>(
            'SELECT id FROM service_status WHERE id = ? LIMIT 1',
            [serviceId]
        );
        if (!services[0]) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        await executeTransaction([
            {
                sql: `UPDATE service_status
                      SET name = ?, address = ?, status = ?, details = ?, updated_by = ?,
                          manual_override = ?, last_reported_at = NULL
                      WHERE id = ?`,
                params: [serviceName, serviceAddress, status, serviceDetails, admin.userId, manualOverride, serviceId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.service.updated',
                { name: serviceName, address: serviceAddress, status },
                'service',
                String(serviceId)
            )
        ]);
        void refreshServiceStatusPush();
        logAuditCommitted(res, admin.userId, 'admin.service.updated', 'service', String(serviceId), {
            name: serviceName,
            address: serviceAddress,
            status
        });
        sendSuccess(res);
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Ein Service mit diesem Namen existiert bereits');
            return;
        }
        logApiFailure(res, 'api.admin.service_update_failed', error);
        sendServerFailure(res);
    }
}

async function deleteServiceAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const serviceId = Number(req.params.id);
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
        sendFailure(res, 400, 'Ungültige Service-ID');
        return;
    }

    try {
        const services = await query<{ id: number }>(
            'SELECT id FROM service_status WHERE id = ? LIMIT 1',
            [serviceId]
        );
        if (!services[0]) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        await executeTransaction([
            { sql: 'DELETE FROM service_status WHERE id = ?', params: [serviceId] },
            auditStatement(res, admin.userId, 'admin.service.deleted', {}, 'service', String(serviceId))
        ]);
        void refreshServiceStatusPush();
        logAuditCommitted(res, admin.userId, 'admin.service.deleted', 'service', String(serviceId));
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.service_delete_failed', error);
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
    router.post('/', createServiceAPIRoute);
    router.post('/:id/api-key', rotateServiceApiKeyAPIRoute);
    router.put('/:id', updateServiceAPIRoute);
    router.delete('/:id', deleteServiceAPIRoute);
    return router;
}
