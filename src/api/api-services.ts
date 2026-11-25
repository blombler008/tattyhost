import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { UpsertResult } from 'mariadb';
import { execute, executeTransaction, query, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';
import { logOperationalEvent } from '../logging/operational-log.ts';
import { auditStatement, isDuplicateEntry, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import {
    applyServiceHeartbeat,
    HEARTBEAT_EXPIRED_DETAILS,
    hashServiceStatusApiKey,
    isValidServiceConfiguration,
    parseServiceStatusReport,
    resolveServiceApiKeyRecord,
    ServiceRateLimiter,
    SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS,
    VALID_SERVICE_STATUSES
} from './service-status-contract.ts';
import type { ServiceType } from './service-status-contract.ts';
import { parseServiceApiBearer } from './whitelist-contract.ts';

const SERVICE_STATUS_PUSH_INTERVAL_MS = 10_000;
const serviceRateLimiter = new ServiceRateLimiter(120, 60_000);

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
    playersOnline: number | null;
    playersMax: number | null;
    minecraftVersion: string | null;
    whitelistRequired: boolean;
};

const serviceStatusClients = new Set<Response>();
let serviceStatusPushTimer: NodeJS.Timeout | undefined;
let lastPushedServiceStatus = '';
let serviceStatusPushErrorLogged = false;

export async function authenticateServiceApiKey(req: Request, res: Response): Promise<{ serviceId: number; actorId: string | null } | null> {
    const cached = res.locals.serviceApiAuth as { serviceId: number; actorId: string | null } | undefined;
    if (cached) return cached;
    const authorization = req.get('authorization') || '';
    const apiKey = parseServiceApiBearer(authorization);
    if (!apiKey) {
        logEvent('warn', 'api.service_status.unauthorized', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
        });
        res.status(401).json({ error: 'Ungültiger API-Schlüssel' });
        return null;
    }

    try {
        const keys = await query<{ service_id: number; token_hash: string; created_by: string | null }>(
            'SELECT service_id, token_hash, created_by FROM service_status_service_api_keys WHERE token_hash = ? LIMIT 1',
            [hashServiceStatusApiKey(apiKey)]
        );
        const key = keys[0];
        const serviceAuth = resolveServiceApiKeyRecord(apiKey, key && {
            serviceId: key.service_id,
            actorId: key.created_by,
            tokenHash: key.token_hash
        });
        if (!serviceAuth) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            res.status(401).json({ error: 'Ungültiger API-Schlüssel' });
            return null;
        }

        if (!serviceRateLimiter.allow(serviceAuth.serviceId, Date.now())) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'Zu viele Anfragen' });
            return null;
        }
        res.locals.serviceApiAuth = serviceAuth;
        return serviceAuth;
    } catch (error) {
        logApiFailure(res, 'api.service_status.authentication_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
        return null;
    }
}

async function loadServiceConfiguration(serviceId: number) {
    const services = await query<{ service_type: string; thnlink_enabled: unknown }>(
        'SELECT service_type, thnlink_enabled FROM service_status WHERE id = ?', [serviceId]
    );
    return services[0] ?? null;
}

export function createMinecraftServiceAuthenticator(
    authenticate = authenticateServiceApiKey,
    loadConfiguration = loadServiceConfiguration
) {
    return async (req: Request, res: Response, requireThnLink = false) => {
        const auth = await authenticate(req, res);
        if (!auth) return null;
        try {
            const service = await loadConfiguration(auth.serviceId);
            if (!service || service.service_type !== 'minecraft' ||
                (requireThnLink && !isDatabaseBoolean(service.thnlink_enabled))) {
                res.status(403).json({ error: 'Minecraft oder THNLink ist für diesen Service nicht aktiviert' });
                return null;
            }
            return auth;
        } catch (error) {
            logApiFailure(res, 'api.service_status.configuration_failed', error);
            res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
            return null;
        }
    };
}

export const authenticateMinecraftService = createMinecraftServiceAuthenticator();

export function createServiceApiPreAuthRouter(authenticate = authenticateServiceApiKey): Router {
    const router = Router();
    router.all(
        ['/api/services/status', '/api/services/whitelist', '/api/services/players/stats', '/api/services/players/link', '/api/services/players/lookup'],
        async (req, res, next) => {
            if (await authenticate(req, res)) next();
        }
    );
    return router;
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
    const services = await query<Omit<PublicServiceStatus, 'whitelistRequired'> & { whitelistRequired: unknown }>(
        `SELECT id, name, address, status, details,
                players_online AS playersOnline, players_max AS playersMax,
                minecraft_version AS minecraftVersion,
                whitelist_required AS whitelistRequired
         FROM service_status ORDER BY sort_order, id`
    );
    return services.map((service) => ({
        ...service,
        whitelistRequired: isDatabaseBoolean(service.whitelistRequired)
    }));
}

async function markExpiredServiceStatuses() {
    await execute(
        `UPDATE service_status
         SET status = 'offline',
             details = '${HEARTBEAT_EXPIRED_DETAILS}',
             players_online = NULL,
             players_max = NULL,
             minecraft_version = NULL
         WHERE manual_override = FALSE
           AND last_reported_at IS NOT NULL
           AND (status <> 'offline' OR details <> '${HEARTBEAT_EXPIRED_DETAILS}')
           AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL ${SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS} SECOND`
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
        });
        startServiceStatusPushTimer();
    } catch (error) {
        logApiFailure(res, 'api.services.push_connect_failed', error);
        sendServerFailure(res);
    }
}

async function updateServiceStatusFromServerAPIRoute(req: Request, res: Response) {
    const apiKeyAuth = await authenticateServiceApiKey(req, res);
    if (!apiKeyAuth) return;

    if (!req.is('application/json')) {
        res.status(415).json({ error: 'Content-Type muss application/json sein' });
        return;
    }

    const report = parseServiceStatusReport(req.body);
    if (!report) {
        res.status(400).json({ error: 'Ungültige Serverstatus-Angaben' });
        return;
    }

    try {
        const outcome = await withDatabaseTransaction(
            ['SELECT', 'UPDATE', 'INSERT'],
            async (connection) => {
                const services = await connection.query<Array<{
                    id: number;
                    status: string;
                    details: string;
                    players_online: number | null;
                    players_max: number | null;
                    minecraft_version: string | null;
                    manual_override: unknown;
                }>>(
                    `SELECT id, status, details, players_online, players_max,
                            minecraft_version, manual_override
                     FROM service_status WHERE id = ? FOR UPDATE`,
                    [apiKeyAuth.serviceId]
                );
                const service = services[0];
                if (!service) return { result: 'missing' as const };

                const manualOverride = isDatabaseBoolean(service.manual_override);
                const heartbeat = applyServiceHeartbeat(
                    {
                        status: service.status,
                        details: service.details,
                        playersOnline: service.players_online,
                        playersMax: service.players_max,
                        minecraftVersion: service.minecraft_version
                    },
                    report,
                    manualOverride,
                    new Date()
                );
                if (manualOverride) {
                    await connection.query(
                        `UPDATE service_status SET last_reported_at = CURRENT_TIMESTAMP,
                         plugin_api_port = ? WHERE id = ?`,
                        [report.api?.port ?? null, service.id]
                    );
                    return {
                        result: 'updated' as const,
                        statusChanged: false,
                        detailsChanged: false,
                        metricsChanged: false
                    };
                }

                await connection.query(
                    `UPDATE service_status
                     SET status = ?, details = ?, players_online = ?, players_max = ?,
                         minecraft_version = ?, updated_by = ?, last_reported_at = CURRENT_TIMESTAMP,
                         plugin_api_port = ?
                     WHERE id = ?`,
                    [
                        heartbeat.status,
                        heartbeat.details,
                        heartbeat.playersOnline,
                        heartbeat.playersMax,
                        heartbeat.minecraftVersion,
                        apiKeyAuth.actorId,
                        report.api?.port ?? null,
                        service.id
                    ]
                );
                if (heartbeat.statusChanged || heartbeat.detailsChanged ||
                    heartbeat.playersChanged || heartbeat.minecraftVersionChanged) {
                    const audit = auditStatement(
                        res,
                        apiKeyAuth.actorId,
                        'service_status.reported',
                        {
                            status: report.status,
                            players: report.players,
                            minecraftVersion: report.minecraftVersion,
                            source: 'api_key'
                        },
                        'service',
                        String(service.id)
                    );
                    await connection.query(audit.sql, audit.params);
                }
                return {
                    result: 'updated' as const,
                    statusChanged: heartbeat.statusChanged,
                    detailsChanged: heartbeat.detailsChanged,
                    metricsChanged: heartbeat.playersChanged || heartbeat.minecraftVersionChanged
                };
            }
        );

        if (outcome.result === 'missing') {
            res.status(404).json({ error: 'Service nicht gefunden' });
            return;
        }

        void refreshServiceStatusPush();
        if (outcome.statusChanged || outcome.detailsChanged || outcome.metricsChanged) {
            logAuditCommitted(
                res,
                apiKeyAuth.actorId,
                'service_status.reported',
                'service',
                String(apiKeyAuth.serviceId),
                {
                    status: report.status,
                    players: report.players,
                    minecraftVersion: report.minecraftVersion,
                    source: 'api_key'
                }
            );
        }
        res.status(204).end();
    } catch (error) {
        logApiFailure(res, 'api.service_status.update_failed', error);
        res.status(500).json({ error: 'Der Dienst ist derzeit nicht verfügbar' });
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
            whitelist_required: unknown;
            service_type: ServiceType;
            thnlink_enabled: unknown;
            api_key_configured: unknown;
            api_key_created_at: Date | null;
            last_reported_at: Date | null;
            players_online: number | null;
            players_max: number | null;
            minecraft_version: string | null;
        }>(`
            SELECT s.id, s.name, s.address, s.status, s.details, s.manual_override, s.whitelist_required, s.service_type, s.thnlink_enabled,
                   s.last_reported_at, s.players_online, s.players_max, s.minecraft_version,
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
                whitelistRequired: isDatabaseBoolean(service.whitelist_required),
                serviceType: service.service_type,
                thnlinkEnabled: isDatabaseBoolean(service.thnlink_enabled),
                apiKeyConfigured: isDatabaseBoolean(service.api_key_configured),
                apiKeyCreatedAt: service.api_key_created_at,
                lastReportedAt: service.last_reported_at,
                playersOnline: service.players_online,
                playersMax: service.players_max,
                minecraftVersion: service.minecraft_version
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

    const { name, address, status, details, manualOverride, whitelistRequired, serviceType, thnlinkEnabled } = req.body || {};
    const configuredType = serviceType === undefined ? 'minecraft' : serviceType;
    const configuredThn = thnlinkEnabled === undefined ? serviceType === undefined : thnlinkEnabled;
    const configuredWhitelist = whitelistRequired === undefined ? false : whitelistRequired;
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceAddress = typeof address === 'string' ? address.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!serviceName || serviceName.length > 64 ||
        !serviceAddress || serviceAddress.length > 255 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        (details !== undefined && typeof details !== 'string') || serviceDetails.length > 255 ||
        (manualOverride !== undefined && typeof manualOverride !== 'boolean') ||
        !isValidServiceConfiguration(configuredType, configuredThn, configuredWhitelist)) {
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
                        (name, address, status, details, sort_order, updated_by, manual_override, whitelist_required, service_type, thnlink_enabled)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [serviceName, serviceAddress, status, serviceDetails, sortOrder, admin.userId, manualOverride ?? false, configuredWhitelist, configuredType, configuredThn]
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
                    { name: serviceName, address: serviceAddress, status, serviceType: configuredType, thnlinkEnabled: configuredThn },
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
    const { name, address, status, details, manualOverride, whitelistRequired, serviceType, thnlinkEnabled } = req.body || {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceAddress = typeof address === 'string' ? address.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0 ||
        !serviceName || serviceName.length > 64 ||
        !serviceAddress || serviceAddress.length > 255 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        typeof details !== 'string' || serviceDetails.length > 255 ||
        typeof manualOverride !== 'boolean' ||
        typeof whitelistRequired !== 'boolean' ||
        (serviceType !== undefined && serviceType !== 'generic' && serviceType !== 'minecraft') ||
        (thnlinkEnabled !== undefined && typeof thnlinkEnabled !== 'boolean')) {
        sendFailure(res, 400, 'Ungültige Service-Angaben');
        return;
    }

    try {
        const services = await query<{ id: number; service_type: ServiceType; thnlink_enabled: unknown }>(
            'SELECT id, service_type, thnlink_enabled FROM service_status WHERE id = ? LIMIT 1',
            [serviceId]
        );
        if (!services[0]) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }
        const configuredType = serviceType === undefined ? services[0].service_type : serviceType;
        const configuredThn = thnlinkEnabled === undefined ? isDatabaseBoolean(services[0].thnlink_enabled) : thnlinkEnabled;
        if (!isValidServiceConfiguration(configuredType, configuredThn, whitelistRequired)) {
            sendFailure(res, 400, 'Ungültige Service-Angaben');
            return;
        }

        await executeTransaction([
            {
                sql: `UPDATE service_status
                      SET name = ?, address = ?, status = ?, details = ?, updated_by = ?,
                          manual_override = ?, whitelist_required = ?, service_type = ?, thnlink_enabled = ?, last_reported_at = NULL,
                          players_online = NULL, players_max = NULL, minecraft_version = NULL
                      WHERE id = ?`,
                params: [serviceName, serviceAddress, status, serviceDetails, admin.userId, manualOverride, whitelistRequired, configuredType, configuredThn, serviceId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.service.updated',
                { name: serviceName, address: serviceAddress, status, serviceType: configuredType, thnlinkEnabled: configuredThn },
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
    startServiceStatusPushTimer();
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
