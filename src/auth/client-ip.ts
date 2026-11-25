import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { execute, type SqlParameter } from '@tattyhost/SQLutils';

export function normalizeClientIp(value: unknown): string | null {
    if (typeof value !== 'string' || value.includes('%')) return null;
    const version = isIP(value);
    if (version === 4) return value;
    if (version !== 6) return null;

    const address = new URL(`http://[${value}]`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
    if (mapped) {
        const high = parseInt(mapped[1], 16);
        const low = parseInt(mapped[2], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return address;
}

export function isPublicClientIp(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
            !(a === 100 && b >= 64 && b <= 127) &&
            !(a === 169 && b === 254) &&
            !(a === 172 && b >= 16 && b <= 31) &&
            !(a === 192 && b === 168);
    }
    if (isIP(address) !== 6) return false;
    const first = parseInt(address.split(':')[0] || '0', 16);
    return address !== '::' && address !== '::1' &&
        (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80 &&
        (first & 0xffc0) !== 0xfec0 &&
        !/^::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(address) &&
        (first & 0xff00) !== 0xff00;
}

export function getIpLookupSecret(): Buffer {
    const secret = process.env.IP_LOOKUP_HMAC_SECRET;
    if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
        throw new Error('IP_LOOKUP_HMAC_SECRET must be a 32-byte random secret encoded as 64 hex characters');
    }
    return Buffer.from(secret, 'hex');
}

export function hashClientIp(address: string): string {
    return createHmac('sha256', getIpLookupSecret()).update(address, 'utf8').digest('hex');
}

type ExecuteCommand = (sql: string, params?: SqlParameter[]) => Promise<void>;

export async function recordClientIp(
    userId: string,
    rawIp: string | undefined,
    runCommand: ExecuteCommand = execute
): Promise<void> {
    const address = normalizeClientIp(rawIp);
    if (!address || !isPublicClientIp(address)) return;
    await runCommand(
        `INSERT INTO user_client_ips (user_uuid, ip_hash, seen_at)
         SELECT u.uuid, ?, CURRENT_TIMESTAMP(3)
         FROM users u LEFT JOIN user_settings s ON s.user_uuid = u.uuid
         WHERE u.uuid = ? AND u.is_active = TRUE AND COALESCE(s.personalised_server_list, FALSE) = TRUE
         ON DUPLICATE KEY UPDATE seen_at = CURRENT_TIMESTAMP(3)`,
        [hashClientIp(address), userId]
    );
}

export async function pruneClientIps(runCommand: ExecuteCommand = execute): Promise<void> {
    await runCommand('DELETE FROM user_client_ips WHERE seen_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 47 HOUR)');
}
