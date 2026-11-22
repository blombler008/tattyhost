import type { Request } from 'express';
import {
    deleteToken,
    getTokenVerificationFailureReason,
    verifyToken,
    type TokenVerificationFailureReason
} from '@tattyhost/CryptoUtils';
import type { SessionData } from '@tattyhost/CryptoUtils';
import { query } from '@tattyhost/SQLutils';

type SessionRow = {
    role: string | null;
};

export type SessionFailureReason = TokenVerificationFailureReason | 'database_session_missing_or_expired';

export async function getUserSession(
    req: Request,
    onSessionFailure?: (reason: SessionFailureReason) => void
): Promise<SessionData | null> {
    const token = req.cookies?.token;
    const fingerprint = req.headers['user-agent'] || '';
    const tokenSession = verifyToken(token, fingerprint);
    if (!tokenSession) {
        onSessionFailure?.(getTokenVerificationFailureReason(token, fingerprint));
        return null;
    }

    const sessions = await query<SessionRow>(
        `SELECT (SELECT r.name
                 FROM user_roles ur
                 JOIN roles r ON r.id = ur.role_id
                 WHERE ur.user_uuid = u.uuid
                 ORDER BY r.id
                 LIMIT 1) AS role
         FROM sessions s
         JOIN users u ON u.uuid = s.user_uuid
         WHERE s.id = ?
           AND s.user_uuid = ?
           AND s.expires_at > CURRENT_TIMESTAMP
           AND u.is_active = TRUE
         LIMIT 1`,
        [tokenSession.sessionId, tokenSession.userId]
    );

    const sessionRow = sessions[0];
    if (!sessionRow) {
        deleteToken(token);
        onSessionFailure?.('database_session_missing_or_expired');
        return null;
    }

    return { ...tokenSession, role: sessionRow.role || 'user' };
}
