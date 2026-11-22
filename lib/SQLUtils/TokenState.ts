export const TokenState = {
    VALID: 'valid',
    INVALID_STRUCTURE: 'invalid_structure',
    INVALID_SIGNATURE: 'invalid_signature',
    PAYLOAD_CORRUPTED: 'payload_corrupted',
    SESSION_EXPIRED: 'session_expired',
    SESSION_MISMATCH: 'session_mismatch',
    UNKNOWN: 'unknown'
} as const;
export type TokenState = (typeof TokenState)[keyof typeof TokenState];