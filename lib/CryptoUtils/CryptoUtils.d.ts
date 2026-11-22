// === CryptoUtils.d.ts ===

/**
 * Session data used in token generation and validation.
 */
export type SessionData = {
    userId: string;
    role: string;
    fingerprint: string;
    ip: string;
    timestamp: number;
    sessionId: string;
};

/**
 * Rotates the encryption keys, moving the current key to backup.
 */
export function rotateKeys(): void;

/**
 * Generates a secure, encrypted and HMAC-signed JWT-like token.
 *
 * @param data - The session data to encode in the token.
 * @returns A signed and encrypted token string.
 */
export function generateSecureToken(data: SessionData): string;

/**
 * Verifies the authenticity and integrity of a secure token.
 *
 * @param token - The token to verify.
 * @param fingerprint - The fingerprint string to compare.
 * @returns The session data if valid and decrypted, otherwise null.
 */
export function verifyToken(
    token: string,
    fingerprint: string
): SessionData | null;

export type TokenVerificationFailureReason =
    | 'cookie_missing'
    | 'token_malformed'
    | 'signature_or_fingerprint_mismatch'
    | 'process_state_missing'
    | 'encryption_key_mismatch'
    | 'verification_state_inconsistent';

export function getTokenVerificationFailureReason(
    token: string,
    fingerprint: string
): TokenVerificationFailureReason;
