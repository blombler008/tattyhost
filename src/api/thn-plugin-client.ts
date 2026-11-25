import http, { type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { isCanonicalPlayerUuid } from './thn-player-contract.ts';
import { isValidWhitelistPlayerName } from './whitelist-contract.ts';

export type PluginStatus = { version: string; minecraftVersion: string; online: number; max: number; luckPerms: boolean };
export type PluginPlayer = { uuid: string; name: string };
export type PlayerBackup = { id: string; createdAt: number | string; reason: 'quit' | 'manual' | 'web'; sizeBytes: number };
export type WorldBackup = { id: string; createdAt: number | string; sizeBytes: number };
export type WorldBackups = { world: string; backups: WorldBackup[] };

export class PluginApiError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export function isLoopbackHost(value: string): boolean {
    return value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

export function isPlayerBackupId(value: string, allowLatest = false): boolean {
    return (allowLatest && value === 'latest') || /^[0-9]{1,18}_[a-z]{1,16}$/.test(value);
}

export function isWorldBackupId(value: string): boolean {
    return /^[0-9]{1,18}$/.test(value);
}

export function isWorldName(value: string): boolean {
    return value !== '.' && value !== '..' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBackup(value: unknown, world: boolean): boolean {
    if (!object(value) || typeof value.id !== 'string' ||
        !(world ? isWorldBackupId(value.id) : isPlayerBackupId(value.id)) ||
        typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 ||
        !(typeof value.createdAt === 'string' || typeof value.createdAt === 'number') ||
        !Number.isFinite(new Date(value.createdAt).getTime())) return false;
    return world || value.reason === 'quit' || value.reason === 'manual' || value.reason === 'web';
}

function invalidResponse(): never {
    throw new PluginApiError(502, 'Ungültige Plugin-Antwort');
}

export class ThnPluginClient {
    constructor(private readonly host: string, private readonly port: number) {
        if (!isLoopbackHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new PluginApiError(503, 'Server offline oder wird neu gestartet');
        }
    }

    private async request(path: string, method: 'GET' | 'POST', timeoutMs: number): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const request = http.request({
                hostname: this.host, port: this.port, path, method,
                headers: method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': '2' } : {}
            });
            const timer = setTimeout(() => request.destroy(new Error('Plugin request timed out')), timeoutMs);
            request.once('response', (response) => {
                clearTimeout(timer);
                resolve(response);
            });
            request.once('error', () => {
                clearTimeout(timer);
                reject(new PluginApiError(503, 'Server offline oder wird neu gestartet'));
            });
            request.end(method === 'POST' ? '{}' : undefined);
        });
    }

    private async json<T>(path: string, method: 'GET' | 'POST' = 'GET', timeoutMs = 20_000): Promise<T> {
        const started = Date.now();
        const response = await this.request(path, method, timeoutMs);
        const timer = setTimeout(() => response.destroy(new Error('Plugin response timed out')), Math.max(1, timeoutMs - (Date.now() - started)));
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buffer.length;
                if (size > 1_048_576) throw new PluginApiError(502, 'Plugin-Antwort zu groß');
                chunks.push(buffer);
            }
            let body: unknown;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                throw new PluginApiError(502, 'Ungültige Plugin-Antwort');
            }
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
                    ? body.error.slice(0, 500) : 'Plugin-Anfrage fehlgeschlagen';
                const status = response.statusCode && [400, 404, 409, 413, 415].includes(response.statusCode) ? response.statusCode : 502;
                throw new PluginApiError(status, message);
            }
            return body as T;
        } catch (error) {
            if (error instanceof PluginApiError) throw error;
            throw new PluginApiError(503, 'Server offline oder wird neu gestartet');
        } finally {
            clearTimeout(timer);
        }
    }

    async status(): Promise<PluginStatus> {
        const value = await this.json<unknown>('/v1/status');
        if (!object(value) || typeof value.version !== 'string' || value.version.length > 128 ||
            typeof value.minecraftVersion !== 'string' || value.minecraftVersion.length > 128 ||
            typeof value.online !== 'number' || !Number.isSafeInteger(value.online) || value.online < 0 ||
            typeof value.max !== 'number' || !Number.isSafeInteger(value.max) || value.max < 0 ||
            typeof value.luckPerms !== 'boolean') return invalidResponse();
        return { version: value.version, minecraftVersion: value.minecraftVersion, online: value.online, max: value.max, luckPerms: value.luckPerms };
    }
    async players(): Promise<{ players: PluginPlayer[] }> {
        const value = await this.json<unknown>('/v1/players');
        if (!object(value) || !Array.isArray(value.players) || value.players.length > 10_000 ||
            !value.players.every((player: unknown) => object(player) && isCanonicalPlayerUuid(player.uuid) && isValidWhitelistPlayerName(player.name))) return invalidResponse();
        return { players: value.players };
    }
    async playerStats(uuid: string): Promise<Record<string, unknown>> {
        this.checkUuid(uuid);
        const value = await this.json<unknown>(`/v1/players/${uuid}/stats`);
        if (!object(value)) return invalidResponse();
        return value;
    }
    async playerBackups(uuid: string): Promise<{ backups: PlayerBackup[] }> {
        this.checkUuid(uuid);
        const value = await this.json<unknown>(`/v1/players/${uuid}/backups`);
        if (!object(value) || !Array.isArray(value.backups) || value.backups.length > 10_000 ||
            !value.backups.every((entry: unknown) => validBackup(entry, false))) return invalidResponse();
        return { backups: value.backups };
    }
    async createPlayerBackup(uuid: string): Promise<{ id: string }> {
        this.checkUuid(uuid);
        const value = await this.json<unknown>(`/v1/players/${uuid}/backups`, 'POST', 90_000);
        if (!object(value) || typeof value.id !== 'string' || !isPlayerBackupId(value.id)) return invalidResponse();
        return { id: value.id };
    }
    async restorePlayerBackup(uuid: string, id: string): Promise<{ message: string }> {
        this.checkUuid(uuid);
        if (!isPlayerBackupId(id, true)) throw new PluginApiError(400, 'Ungültige Backup-ID');
        const value = await this.json<unknown>(`/v1/players/${uuid}/backups/${id}/restore`, 'POST');
        if (!object(value) || typeof value.message !== 'string' || value.message.length > 500) return invalidResponse();
        return { message: value.message };
    }
    async worldBackups(): Promise<{ worlds: WorldBackups[] }> {
        const value = await this.json<unknown>('/v1/worlds/backups');
        if (!object(value) || !Array.isArray(value.worlds) || value.worlds.length > 1000 ||
            !value.worlds.every((world: unknown) => object(world) && typeof world.world === 'string' &&
                isWorldName(world.world) && Array.isArray(world.backups) && world.backups.length <= 10_000 &&
                world.backups.every((entry: unknown) => validBackup(entry, true)))) return invalidResponse();
        return { worlds: value.worlds };
    }
    async createWorldBackup(world: string): Promise<{ started: string[] }> {
        if (!isWorldName(world)) throw new PluginApiError(400, 'Ungültiger Weltname');
        const value = await this.json<unknown>(`/v1/worlds/${encodeURIComponent(world)}/backups`, 'POST', 90_000);
        if (!object(value) || !Array.isArray(value.started) || value.started.length > 1000 ||
            !value.started.every((item: unknown) => typeof item === 'string' && isWorldName(item))) return invalidResponse();
        return { started: value.started };
    }
    async downloadPlayer(uuid: string, id: string) {
        this.checkUuid(uuid);
        if (!isPlayerBackupId(id)) throw new PluginApiError(400, 'Ungültige Backup-ID');
        return this.download(`/v1/players/${uuid}/backups/${id}`);
    }
    async downloadWorld(world: string, id: string) {
        if (!isWorldName(world) || !isWorldBackupId(id)) throw new PluginApiError(400, 'Ungültiger Weltname oder Backup-ID');
        return this.download(`/v1/worlds/${encodeURIComponent(world)}/backups/${id}`);
    }
    private checkUuid(uuid: string) {
        if (!isCanonicalPlayerUuid(uuid)) throw new PluginApiError(400, 'Ungültige Minecraft-UUID');
    }
    private async download(path: string): Promise<IncomingMessage> {
        const response = await this.request(path, 'GET', 20_000);
        if (response.statusCode !== 200) {
            const status = response.statusCode && [400, 404, 409, 413, 415].includes(response.statusCode)
                ? response.statusCode : 502;
            const timer = setTimeout(() => response.destroy(), 20_000);
            try {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of response) {
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    size += buffer.length;
                    if (size > 8192) break;
                    chunks.push(buffer);
                }
                const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const message = object(body) && typeof body.error === 'string'
                    ? body.error.slice(0, 500) : 'Backup konnte nicht geladen werden';
                throw new PluginApiError(status, message);
            } catch (error) {
                if (error instanceof PluginApiError) throw error;
                throw new PluginApiError(status, 'Backup konnte nicht geladen werden');
            } finally {
                clearTimeout(timer);
                response.destroy();
            }
        }
        return response;
    }
}
