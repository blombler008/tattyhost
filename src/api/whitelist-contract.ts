import { createHash, timingSafeEqual } from 'node:crypto';

const MINECRAFT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const UUID_PATTERN = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
const COMPACT_UUID_PATTERN = /^[a-fA-F0-9]{32}$/;

export type MinecraftProfile = {
    uuid: string;
    name: string;
};

export type WhitelistSnapshot = {
    revision: number;
    players: string[];
};

export type WhitelistHttpResult =
    | { status: 200; etag: string; body: WhitelistSnapshot }
    | { status: 304; etag: string; body: null };

export class InvalidMinecraftNameError extends Error {}
export class MinecraftProfileNotFoundError extends Error {}
export class MinecraftProfileServiceError extends Error {}

export function parseServiceApiBearer(authorization: string): string | null {
    const match = /^Bearer ([A-Za-z0-9+/]{64})$/.exec(authorization);
    const apiKey = match?.[1];
    if (!apiKey || Buffer.from(apiKey, 'base64').toString('base64') !== apiKey) return null;
    return apiKey;
}

export function verifyServiceApiKey(apiKey: string, tokenHash: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return false;
    const expected = Buffer.from(tokenHash, 'hex');
    const supplied = createHash('sha256').update(apiKey, 'utf8').digest();
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function canonicalizeMinecraftUuid(value: string): string {
    if (UUID_PATTERN.test(value)) return value.toLowerCase();
    if (!COMPACT_UUID_PATTERN.test(value)) throw new Error('Ungültige Minecraft-UUID');

    const hex = value.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWhitelistETag(serviceId: number, revision: number): string {
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0 ||
        !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('Ungültige Whitelist-Version');
    }
    return `"service-${serviceId}-revision-${revision}"`;
}

export function ifNoneMatchIncludes(header: string | undefined, etag: string): boolean {
    if (!header) return false;
    return header.split(',').some((candidate) => {
        const tag = candidate.trim();
        return tag === '*' || tag.replace(/^W\//, '') === etag;
    });
}

export function createWhitelistHttpResult(
    serviceId: number,
    snapshot: WhitelistSnapshot,
    ifNoneMatch: string | undefined
): WhitelistHttpResult {
    const etag = createWhitelistETag(serviceId, snapshot.revision);
    if (ifNoneMatchIncludes(ifNoneMatch, etag)) return { status: 304, etag, body: null };
    return { status: 200, etag, body: snapshot };
}

export function createWhitelistSnapshot(revisionValue: number | string, playerValues: string[]): WhitelistSnapshot {
    const revision = Number(revisionValue);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Ungültige Whitelist-Version');

    const players = [...new Set(playerValues.map(canonicalizeMinecraftUuid))].sort();
    return { revision, players };
}

export function nextWhitelistRevision(current: number, membershipChanged: boolean): number {
    if (!Number.isSafeInteger(current) || current < 0 ||
        (membershipChanged && current === Number.MAX_SAFE_INTEGER)) {
        throw new Error('Whitelist-Version ist außerhalb des unterstützten Bereichs');
    }
    return membershipChanged ? current + 1 : current;
}

export async function resolveMinecraftProfile(
    playerName: string,
    fetchProfile: typeof fetch = fetch
): Promise<MinecraftProfile> {
    if (!MINECRAFT_NAME_PATTERN.test(playerName)) throw new InvalidMinecraftNameError('Ungültiger Minecraft-Name');

    const response = await requestMinecraftProfile(
        `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(playerName)}`,
        fetchProfile
    );
    return parseMinecraftProfileResponse(response);
}

export async function resolveMinecraftProfileByUuid(
    playerUuid: string,
    fetchProfile: typeof fetch = fetch
): Promise<MinecraftProfile> {
    let canonicalUuid: string;
    try {
        canonicalUuid = canonicalizeMinecraftUuid(playerUuid);
    } catch {
        throw new MinecraftProfileServiceError('Ungültige gespeicherte Minecraft-UUID');
    }

    const response = await requestMinecraftProfile(
        `https://sessionserver.mojang.com/session/minecraft/profile/${canonicalUuid.replace(/-/g, '')}`,
        fetchProfile
    );
    const profile = await parseMinecraftProfileResponse(response);
    if (profile.uuid !== canonicalUuid) {
        throw new MinecraftProfileServiceError('Minecraft-Profil-Dienst lieferte eine abweichende UUID');
    }
    return profile;
}

async function requestMinecraftProfile(url: string, fetchProfile: typeof fetch): Promise<Response> {
    let response: Response;
    try {
        response = await fetchProfile(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5_000)
        });
    } catch {
        throw new MinecraftProfileServiceError('Minecraft-Profil kann derzeit nicht geprüft werden');
    }

    if (response.status === 204 || response.status === 404) {
        throw new MinecraftProfileNotFoundError('Minecraft-Profil wurde nicht gefunden');
    }
    if (!response.ok) throw new MinecraftProfileServiceError('Minecraft-Profil kann derzeit nicht geprüft werden');
    return response;
}

async function parseMinecraftProfileResponse(response: Response): Promise<MinecraftProfile> {
    let profile: unknown;
    try {
        profile = await response.json();
    } catch {
        throw new MinecraftProfileServiceError('Ungültige Antwort vom Minecraft-Profil-Dienst');
    }

    if (typeof profile !== 'object' || profile === null ||
        !('id' in profile) || typeof profile.id !== 'string' ||
        !('name' in profile) || typeof profile.name !== 'string' ||
        !MINECRAFT_NAME_PATTERN.test(profile.name)) {
        throw new MinecraftProfileServiceError('Ungültige Antwort vom Minecraft-Profil-Dienst');
    }

    try {
        return { uuid: canonicalizeMinecraftUuid(profile.id), name: profile.name };
    } catch {
        throw new MinecraftProfileServiceError('Ungültige Antwort vom Minecraft-Profil-Dienst');
    }
}
