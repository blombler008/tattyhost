// File: src/middleware/check-auth.ts

import type { Request, Response, NextFunction } from 'express';
import type { SessionData } from '@tattyhost/CryptoUtils';
import { getUserSession } from '../auth/user-session.ts';
import { logEvent } from '../logging/app-logger.ts';

interface SSRAuthState {
    isLoggedIn: boolean;
    session: SessionData | null;
}

/**
 * Middleware zum Überprüfen, ob ein Nutzer eingeloggt ist.
 * Setzt req.ssrAuth mit Login-Status und Session-Infos.
 */
export async function checkAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const isHomeNavigation = req.method === 'GET' && req.path === '/';
        let failureReason: string | undefined;
        const session = await getUserSession(req, (reason) => {
            failureReason = reason;
        });
        if (isHomeNavigation) {
            logEvent('debug', 'auth.session.home_diagnostic', {
                requestId: res.locals.requestId,
                route: req.path,
                sessionCredentialPresent: Boolean(req.cookies?.token),
                sessionAccepted: session !== null,
                failureReason: session ? undefined : failureReason
            });
        }
        res.locals.ssrAuth = {
            isLoggedIn: session !== null,
            session
        } satisfies SSRAuthState;
        next();
    } catch (error) {
        next(error);
    }
}

export type { SSRAuthState };
