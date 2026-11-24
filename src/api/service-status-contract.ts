import { createHash } from 'node:crypto';
import { verifyServiceApiKey } from './whitelist-contract.ts';

export const VALID_SERVICE_STATUSES = ['online', 'offline', 'maintenance'] as const;
export const SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS = 60;
export const HEARTBEAT_EXPIRED_DETAILS = 'Keine Statusmeldung seit über 60 Sekunden';

export type ServiceStatus = typeof VALID_SERVICE_STATUSES[number];

export type ServiceStatusReport = {
    status: ServiceStatus;
    details?: string;
    players?: {
        online: number;
        max: number;
    };
    minecraftVersion?: string;
};

export type ServiceStatusState = {
    status: string;
    details: string;
    playersOnline?: number | null;
    playersMax?: number | null;
    minecraftVersion?: string | null;
};

export type ServiceHeartbeatResult = ServiceStatusState & {
    receivedAt: Date;
    statusChanged: boolean;
    detailsChanged: boolean;
    playersChanged: boolean;
    minecraftVersionChanged: boolean;
};

export const MAX_SERVICE_PLAYERS = 4_294_967_295;
export const MAX_MINECRAFT_VERSION_LENGTH = 32;

export function hashServiceStatusApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function resolveServiceApiKeyRecord(
    apiKey: string,
    record: { serviceId: number; actorId: string | null; tokenHash: string } | undefined
): { serviceId: number; actorId: string | null } | null {
    if (!record || !Number.isSafeInteger(record.serviceId) || record.serviceId <= 0 ||
        !verifyServiceApiKey(apiKey, record.tokenHash)) return null;
    return { serviceId: record.serviceId, actorId: record.actorId };
}

export function parseServiceStatusReport(value: unknown): ServiceStatusReport | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    if (typeof body.status !== 'string' ||
        !VALID_SERVICE_STATUSES.includes(body.status as ServiceStatus)) return null;
    if (body.details !== undefined &&
        (typeof body.details !== 'string' || body.details.length > 255)) return null;

    let players: ServiceStatusReport['players'];
    if (body.players !== undefined) {
        if (typeof body.players !== 'object' || body.players === null || Array.isArray(body.players)) return null;
        const playerCounts = body.players as Record<string, unknown>;
        if (!Number.isSafeInteger(playerCounts.online) || !Number.isSafeInteger(playerCounts.max) ||
            (playerCounts.online as number) < 0 || (playerCounts.max as number) < 0 ||
            (playerCounts.online as number) > MAX_SERVICE_PLAYERS ||
            (playerCounts.max as number) > MAX_SERVICE_PLAYERS) return null;
        players = { online: playerCounts.online as number, max: playerCounts.max as number };
    }

    let minecraftVersion: string | undefined;
    if (body.minecraftVersion !== undefined) {
        if (typeof body.minecraftVersion !== 'string' ||
            body.minecraftVersion.length > MAX_MINECRAFT_VERSION_LENGTH ||
            body.minecraftVersion.trim().length === 0 ||
            body.minecraftVersion.trim().length > MAX_MINECRAFT_VERSION_LENGTH) return null;
        minecraftVersion = body.minecraftVersion.trim();
    }

    return {
        status: body.status as ServiceStatus,
        ...(typeof body.details === 'string' ? { details: body.details.trim() } : {}),
        ...(players ? { players } : {}),
        ...(minecraftVersion ? { minecraftVersion } : {})
    };
}

export function applyServiceHeartbeat(
    current: ServiceStatusState,
    report: ServiceStatusReport,
    manualOverride: boolean,
    receivedAt: Date
): ServiceHeartbeatResult {
    if (manualOverride) {
        return {
            ...current,
            receivedAt,
            statusChanged: false,
            detailsChanged: false,
            playersChanged: false,
            minecraftVersionChanged: false
        };
    }

    const details = report.details ??
        (current.details === HEARTBEAT_EXPIRED_DETAILS ? '' : current.details);
    const playersOnline = report.status === 'online'
        ? report.players?.online ?? current.playersOnline ?? null
        : null;
    const playersMax = report.status === 'online'
        ? report.players?.max ?? current.playersMax ?? null
        : null;
    const minecraftVersion = report.status === 'online'
        ? report.minecraftVersion ?? current.minecraftVersion ?? null
        : null;
    return {
        status: report.status,
        details,
        playersOnline,
        playersMax,
        minecraftVersion,
        receivedAt,
        statusChanged: current.status !== report.status,
        detailsChanged: current.details !== details,
        playersChanged: (current.playersOnline ?? null) !== playersOnline ||
            (current.playersMax ?? null) !== playersMax,
        minecraftVersionChanged: (current.minecraftVersion ?? null) !== minecraftVersion
    };
}

export function isHeartbeatExpired(
    lastReportedAt: Date | null,
    manualOverride: boolean,
    now: Date
): boolean {
    if (manualOverride || lastReportedAt === null) return false;
    return now.getTime() - lastReportedAt.getTime() >
        SERVICE_STATUS_HEARTBEAT_TIMEOUT_SECONDS * 1000;
}

export function applyHeartbeatTimeout(
    lastReportedAt: Date | null,
    manualOverride: boolean,
    now: Date
): (ServiceStatusState & { playersOnline: null; playersMax: null; minecraftVersion: null; lastReportedAt: null }) | null {
    if (!isHeartbeatExpired(lastReportedAt, manualOverride, now)) return null;
    return {
        status: 'offline',
        details: HEARTBEAT_EXPIRED_DETAILS,
        playersOnline: null,
        playersMax: null,
        minecraftVersion: null,
        lastReportedAt: null
    };
}
