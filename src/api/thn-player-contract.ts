import { createHash } from 'node:crypto';
import { isValidWhitelistPlayerName } from './whitelist-contract.ts';

const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LINK_CODE = /^[0-9]{6}$/;

export function isCanonicalPlayerUuid(value: unknown): value is string {
    return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function hashLinkCode(uuid: string, code: string): string {
    return createHash('sha256').update(`${uuid}:${code}`).digest('hex');
}

export function isLinkCode(value: unknown): value is string {
    return typeof value === 'string' && LINK_CODE.test(value);
}

export type PlayerStats = {
    uuid: string;
    name: string;
    lastSeen: number;
    online: boolean;
    playtimeTicks: number;
    deaths: number;
    mobKills: number;
    playerKills: number;
    level: number;
    health: number;
    foodLevel: number;
    gameMode: string;
    world: string;
    x: number;
    y: number;
    z: number;
    primaryGroup?: string;
};

function nonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function coordinate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000;
}

export function parsePlayerStats(value: unknown, now: number): PlayerStats | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const p = value as Record<string, unknown>;
    if (!isCanonicalPlayerUuid(p.uuid) || !isValidWhitelistPlayerName(p.name) ||
        !nonnegativeInteger(p.lastSeen) || p.lastSeen > now + 120_000 ||
        typeof p.online !== 'boolean' || !nonnegativeInteger(p.playtimeTicks) ||
        !nonnegativeInteger(p.deaths) || !nonnegativeInteger(p.mobKills) ||
        !nonnegativeInteger(p.playerKills) || !nonnegativeInteger(p.level) ||
        typeof p.health !== 'number' || !Number.isFinite(p.health) || p.health < 0 || p.health > 2048 ||
        !nonnegativeInteger(p.foodLevel) || p.foodLevel > 20 ||
        typeof p.gameMode !== 'string' || !/^[A-Za-z_]{1,32}$/.test(p.gameMode) ||
        typeof p.world !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(p.world) ||
        !coordinate(p.x) || !coordinate(p.y) || !coordinate(p.z) ||
        (p.primaryGroup !== undefined &&
            (typeof p.primaryGroup !== 'string' || p.primaryGroup.length < 1 || p.primaryGroup.length > 128))) return null;
    return {
        uuid: p.uuid, name: p.name, lastSeen: p.lastSeen, online: p.online,
        playtimeTicks: p.playtimeTicks, deaths: p.deaths, mobKills: p.mobKills,
        playerKills: p.playerKills, level: p.level, health: p.health,
        foodLevel: p.foodLevel, gameMode: p.gameMode, world: p.world,
        x: p.x, y: p.y, z: p.z,
        ...(typeof p.primaryGroup === 'string' ? { primaryGroup: p.primaryGroup } : {})
    };
}

export function parsePlayerBatch(values: unknown[], now: number): { players: PlayerStats[]; rejected: number } {
    const players: PlayerStats[] = [];
    for (const value of values) {
        const player = parsePlayerStats(value, now);
        if (player) players.push(player);
    }
    return { players, rejected: values.length - players.length };
}

export function ownPlayerStats(stats: PlayerStats, now: number) {
    const { x, y, z, ...own } = stats;
    void x;
    void y;
    void z;
    return { ...own, online: own.online && now - own.lastSeen <= 90_000 };
}
