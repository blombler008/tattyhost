import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, insertOperationalLogRecord } from '@tattyhost/SQLutils';
import { logEvent, logRetentionDays, sanitizeLogDetails, type LogLevel } from './app-logger.ts';

type OperationalLog = {
    event: string;
    level?: LogLevel;
    requestId?: string | null;
    method?: string | null;
    route?: string | null;
    statusCode?: number | null;
    durationMs?: number | null;
    userId?: string | null;
    details?: Record<string, unknown>;
};

const pendingDatabaseLogs = new Set<Promise<void>>();
const safeRouteSegments = new Set([
    'about', 'account', 'admin', 'api', 'download', 'downloads', 'email', 'files', 'home', 'impressum',
    'license', 'login', 'logout', 'overview', 'password', 'password-reset', 'register', 'role',
    'secure-data', 'services', 'settings', 'sitemap', 'status', 'users'
]);

export function logOperationalEvent(entry: OperationalLog) {
    const level = entry.level || 'info';
    const details = sanitizeLogDetails(entry.details || {});
    const route = entry.route ? sanitizeRoute(entry.route) : null;

    logEvent(level, entry.event, {
        requestId: entry.requestId,
        method: entry.method,
        route,
        statusCode: entry.statusCode,
        durationMs: entry.durationMs,
        userId: entry.userId,
        details
    });

    const task = insertOperationalLogRecord([
            entry.requestId || null,
            level,
            entry.event.slice(0, 128),
            entry.method?.slice(0, 16) || null,
            route,
            entry.statusCode ?? null,
            entry.durationMs == null ? null : Math.max(0, Math.round(entry.durationMs)),
            entry.userId || null,
            JSON.stringify(details)
        ]).then(() => undefined).catch((error: unknown) => {
        logEvent('error', 'logging.database_write_failed', {
            requestId: entry.requestId,
            event: entry.event,
            error
        });
    }).finally(() => {
        pendingDatabaseLogs.delete(task);
    });

    pendingDatabaseLogs.add(task);
}

export async function pruneOperationalLogs() {
    await execute(
        `DELETE FROM application_logs
         WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${logRetentionDays} DAY)`
    );
    logOperationalEvent({
        event: 'logging.database_retention_applied',
        details: { retentionDays: logRetentionDays }
    });
}

export async function flushDatabaseLogs() {
    while (pendingDatabaseLogs.size) {
        await Promise.all([...pendingDatabaseLogs]);
    }
}

function sanitizeRoute(route: string): string {
    const safePath = route.split('/').map((segment) => {
        if (!segment) return '';
        if (segment.startsWith(':')) return ':param';
        return safeRouteSegments.has(segment.toLowerCase()) ? segment : ':param';
    }).join('/');
    return (safePath || '/').slice(0, 255);
}

export function getLogRoute(req: Request): string {
    const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
    if (routePath && routePath !== '*all') return `${req.baseUrl}${routePath}`.slice(0, 255);
    return sanitizeRoute(req.path);
}

export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    logEvent('info', 'http.request.started', {
        requestId,
        method: req.method,
        route: getLogRoute(req)
    });

    res.once('finish', () => {
        const auth = res.locals.ssrAuth as { session?: { userId?: string } | null } | undefined;
        const statusCode = res.statusCode;
        logOperationalEvent({
            requestId,
            event: 'http.request.completed',
            level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
            method: req.method,
            route: getLogRoute(req),
            statusCode,
            durationMs: Date.now() - startedAt,
            userId: auth?.session?.userId || null
        });
    });

    next();
}
