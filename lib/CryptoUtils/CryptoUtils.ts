// === CryptoUtils.ts ===

import * as crypto from 'crypto';
import dotenv from 'dotenv'; 


dotenv.config();
// === ENVIRONMENT VARIABLES ===

// === CONSTANTS ===
const IV_LENGTH = 12;
const UTF8__ = 'utf8';
// const BASE64__ = 'base64'; // may be used for other encodings
const BASE64URL__ = 'base64url';
const JWT_ALG__ = 'HS256';
const JWT_TYP__ = 'JWT';
const JWT_SEPARATOR__ = '.';
const JWT_HEADER__ = toBase64(JSON.stringify({ alg: JWT_ALG__, typ: JWT_TYP__ }));
const AES_ALGO__ = 'aes-256-gcm';
const HMAC_ALGO__ = 'sha256';
const CLEANUP_INTERVAL_MS__ = 60 * 60 * 1000;
const TOKEN_EXPIRATION_MS__ = 48 * CLEANUP_INTERVAL_MS__;

// === TYPES ===
export type SessionData = {
    userId: string;
    role: string;
    fingerprint: string;
    ip: string;
    timestamp: number;
    sessionId: string;
};

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString(BASE64URL__);
    const hash = crypto.scryptSync(password, salt, 64).toString(BASE64URL__);
    return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

    try {
        const hash = crypto.scryptSync(password, parts[1], 64);
        const expected = Buffer.from(parts[2], BASE64URL__);
        return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
    } catch {
        return false;
    }
}

type DataMeta = {
    iv: Buffer;
    authTag: Buffer;
    expires: number;
};

// === STATE ===
let currentKey: Buffer = crypto.randomBytes(32);
let previousKey: Buffer | null = null;
const dataIndexMap: Map<string, DataMeta> = new Map();

// === KEY ROTATION ===
export function rotateKeys(): void {
    previousKey = currentKey;
    currentKey = crypto.randomBytes(32);
}

// === ENCODING ===
function toBase64(input: string): string {
    return Buffer.from(input).toString(BASE64URL__);
}

function fromBase64(input: string): Buffer {
    return Buffer.from(input, BASE64URL__);
}

function joinJwtParts(...parts: string[]): string {
    return parts.join(JWT_SEPARATOR__);
}

// === HMAC ===
function createHMACfromParts(header: string, payload: string, key: string): string {
    const combined = joinJwtParts(header, payload);
    return createHMAC(combined, key);
}

function createHMAC(input: string, key: string): string {
    return crypto.createHmac(HMAC_ALGO__, key).update(input).digest(BASE64URL__);
}

// === IV + TAG STORAGE ===
function storeIVandTag(key: string, iv: Buffer, authTag: Buffer): void {
    dataIndexMap.set(key, {
        iv,
        authTag,
        expires: getExpirationTime(),
    });
}

function getExpirationTime(): number {
    return Date.now() + TOKEN_EXPIRATION_MS__;
}

// === ENCRYPTION ===
function getCipherText(cipher: crypto.CipherGCM, data: object): string {
    const jsonData = JSON.stringify(data);
    return Buffer.concat([
        cipher.update(jsonData, UTF8__),
        cipher.final(),
    ]).toString(BASE64URL__);
}

function getNewIVandCipher(key: Buffer): [Buffer, crypto.CipherGCM] {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(AES_ALGO__, key, iv);
    return [iv, cipher];
}

function decipherText(key: Buffer, dataMeta: DataMeta, encrypted: Buffer): string {
    const decipher = crypto.createDecipheriv(AES_ALGO__, key, dataMeta.iv);
    decipher.setAuthTag(dataMeta.authTag);
    return decipher.update(encrypted, undefined, UTF8__) + decipher.final(UTF8__);
}

function encrypt(data: SessionData, key: Buffer): string {
    const [iv, cipher] = getNewIVandCipher(key);
    const encryptedBuffer = getCipherText(cipher, data); 

    storeIVandTag(encryptedBuffer, iv, cipher.getAuthTag());

    return encryptedBuffer;
}

function decrypt(encodedData: string, key: Buffer): SessionData | null {
    const dataMeta = dataIndexMap.get(encodedData);
    if (!dataMeta) return null;

    try {
        const encrypted = fromBase64(encodedData);
        const decrypted = decipherText(key, dataMeta, encrypted);
        return JSON.parse(decrypted);
    } catch {
        return null;
    }
}

// === CLEANUP ===
function cleanupExpiredEntries(): void {
    const now = Date.now();
    for (const [key, { expires }] of dataIndexMap.entries()) {
        if (expires <= now) {
            dataIndexMap.delete(key);
        }
    }
}

setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS__);

// === HELPERS ===
function allJwtPartsPresent(header: string, payload: string, signature: string): boolean {
    return Boolean(header && payload && signature);
}

function parseAndDecryptPayload(payload: string): string {
    return payload;
}

function validateSession(encodedData: string, fingerprint: string): SessionData | null {
    const session = tryDecryptWith(currentKey, encodedData, fingerprint);
    if (session) return session;

    const fallbackSession = tryDecryptWith(previousKey, encodedData, fingerprint);
    if (fallbackSession) {
        dataIndexMap.delete(encodedData);
        return fallbackSession;
    }

    return null;
}

function tryDecryptWith(key: Buffer | null, encodedData: string, fingerprint: string): SessionData | null {
    if (!key) return null;
    const session = decrypt(encodedData, key);
    return isSessionValid(session, fingerprint) ? session : null;
}

function isSessionValid(session: SessionData | null, fingerprint: string): boolean {
    return session?.fingerprint === fingerprint;
}

function encodePayload(encodedData: string): string {
    return encodedData;
}

// === MAIN EXPORTS ===

/**
 * Generates a secure JWT-like token with encrypted session data and HMAC signature.
 */
export function generateSecureToken(data: SessionData): string {
    const encodedData = encrypt(data, currentKey);
    const payload = encodePayload(encodedData);
    const signature = createHMACfromParts(JWT_HEADER__, payload, data.fingerprint);
    return joinJwtParts(JWT_HEADER__, payload, signature);
}

/**
 * Verifies and decrypts the secure token using current or previous secret key.
 */
export function verifyToken(token: string, fingerprint: string): SessionData | null {
    if (!token) return null;

    const [header, payload, signature] = token.split(JWT_SEPARATOR__);
    if (!allJwtPartsPresent(header, payload, signature)) return null;

    const expectedSignature = createHMACfromParts(header, payload, fingerprint);
    if (expectedSignature !== signature) return null;

    const encodedData = parseAndDecryptPayload(payload);
    if (!encodedData) return null;

    return validateSession(encodedData, fingerprint);
}

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
): TokenVerificationFailureReason {
    if (!token) return 'cookie_missing';

    const [header, payload, signature] = token.split(JWT_SEPARATOR__);
    if (!allJwtPartsPresent(header, payload, signature)) return 'token_malformed';
    if (createHMACfromParts(header, payload, fingerprint) !== signature) {
        return 'signature_or_fingerprint_mismatch';
    }

    const encodedData = parseAndDecryptPayload(payload);
    if (!encodedData || !dataIndexMap.has(encodedData)) return 'process_state_missing';

    for (const key of [currentKey, previousKey]) {
        if (!key) continue;
        const session = decrypt(encodedData, key);
        if (!session) continue;
        if (session.fingerprint !== fingerprint) return 'signature_or_fingerprint_mismatch';
        return 'verification_state_inconsistent';
    }

    return 'encryption_key_mismatch';
}

export function deleteToken(token: string): void {
    if (!token) return;
    
    const [header, payload, signature] = token.split(JWT_SEPARATOR__);
    if (!allJwtPartsPresent(header, payload, signature)) return;

    const encodedData = parseAndDecryptPayload(payload);
    dataIndexMap.delete(encodedData);
}