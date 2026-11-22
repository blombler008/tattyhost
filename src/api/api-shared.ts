import type { Response } from 'express';
import type { SessionData } from '@tattyhost/CryptoUtils';
import { query, type SqlParameter } from '@tattyhost/SQLutils';
import { logEvent } from '../logging/app-logger.ts';

export function getNodeErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : undefined;
}

export function getUserSession(res: Response): SessionData | null {
    const auth = res.locals.ssrAuth as { session?: SessionData | null } | undefined;
    return auth?.session || null;
}

export function requireUser(res: Response): SessionData | null {
    const session = getUserSession(res);
    if (!session) sendFailure(res, 401, 'Anmeldung erforderlich');
    return session;
}

export function requireAdmin(res: Response): SessionData | null {
    const session = requireUser(res);
    if (session && session.role !== 'admin') {
        sendFailure(res, 403, 'Administratorrechte erforderlich');
        return null;
    }
    return session;
}

export async function requireFileAccess(res: Response): Promise<SessionData | null> {
    const session = requireUser(res);
    if (!session) return null;

    try {
        const users = await query<{ has_file_access: boolean | number | string }>(
            'SELECT has_file_access FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        const hasAccess = users[0]?.has_file_access === true ||
            users[0]?.has_file_access === 1 ||
            users[0]?.has_file_access === '1';
        if (!hasAccess) {
            sendFailure(res, 403, 'Dateizugriff ist nicht freigeschaltet');
            return null;
        }
        return session;
    } catch (error) {
        logApiFailure(res, 'api.files.authorization_failed', error);
        sendServerFailure(res);
        return null;
    }
}

export function auditStatement(
    res: Response,
    actorId: string | null,
    action: string,
    details: Record<string, unknown> = {},
    targetType: string | null = null,
    targetId: string | null = null
): { sql: string; params: SqlParameter[] } {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : null;
    return {
        sql: `INSERT INTO audit_logs
                (user_uuid, action, details, request_id, target_type, target_id)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [actorId, action, JSON.stringify(details), requestId, targetType, targetId]
    };
}

export function logApiFailure(res: Response, event: string, error: unknown) {
    logEvent('error', event, {
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
        error
    });
}

export function logAuditCommitted(
    res: Response,
    actorId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    details: Record<string, unknown> = {}
) {
    logEvent('info', action, {
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
        userId: actorId,
        targetType,
        targetId,
        ...details
    });
}

export function sendSuccess(res: Response, data: Record<string, unknown> = {}) {
    res.status(200).json({ success: true, ...data });
}

export function sendFailure(res: Response, status: number, message: string) {
    res.status(status).json({ success: false, error: message });
}

export function sendServerFailure(res: Response) {
    sendFailure(res, 500, 'Der Dienst ist derzeit nicht verfügbar');
}

export function isDuplicateEntry(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error &&
        error.code === 'ER_DUP_ENTRY';
}
