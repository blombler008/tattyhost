import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import { readdir, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import {
    generateSecureToken,
    rotateKeys,
    type SessionData,
    deleteToken,
    hashPassword,
    verifyPassword
} from '@tattyhost/CryptoUtils';
import { execute, executeTransaction, query, type SqlParameter, withDatabaseTransaction } from '@tattyhost/SQLutils';
import { isSmtpConfigured, sendPasswordResetEmail } from '../email/password-reset-mailer.ts';
import { logEvent } from '../logging/app-logger.ts';
import { logOperationalEvent } from '../logging/operational-log.ts';
import {
    compileFilePatterns,
    getFilesRoot,
    isPathInsideRoot,
    matchesFilePatterns,
    validateFileListingRules,
    type FileListingRules
} from '../files/file-listing.ts';
import {
    createDownloadStorageKey,
    ensureDownloadStorageRoot,
    getStoredDownloadPathForCleanup,
    isValidDownloadStorageKey,
    resolveStoredDownloadPath
} from '../files/download-storage.ts';

const sessionKeyRotationTimer = setInterval(() => {
    logEvent('info', 'security.session_key_rotation.started');
    try {
        rotateKeys();
        logOperationalEvent({ event: 'security.session_key_rotation.completed' });
    } catch (error) {
        logEvent('error', 'security.session_key_rotation.failed', { error });
        logOperationalEvent({
            event: 'security.session_key_rotation.failed',
            level: 'error',
            details: { error }
        });
    }
}, 24 * 60 * 60 * 1000);
sessionKeyRotationTimer.unref();

const SESSION_MAX_AGE = 48 * 60 * 60 * 1000;
const VALID_ROLES = ['user', 'admin'] as const;
const VALID_SERVICE_STATUSES = ['online', 'offline', 'maintenance'] as const;
const MAX_DOWNLOAD_UPLOAD_MB = 512;
const SERVICE_STATUS_PUSH_INTERVAL_MS = 10_000;

type PublicServiceStatus = {
    id: number;
    name: string;
    address: string;
    status: 'online' | 'offline' | 'maintenance';
    details: string;
};

const serviceStatusClients = new Set<Response>();
let serviceStatusPushTimer: NodeJS.Timeout | undefined;
let lastPushedServiceStatus = '';
let serviceStatusPushErrorLogged = false;

type DownloadRow = {
    id: number;
    title: string;
    description: string | null;
    url: string;
    is_active: boolean | number | string;
    created_at: Date;
    storage_key?: string | null;
    original_filename?: string | null;
};

type FileListingSettingsRow = {
    filter_patterns: string;
    star_patterns: string;
};

type DownloadUploadSettingsRow = {
    max_upload_mb: number | string;
};

class FileRequestError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message);
    }
}

function getNodeErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : undefined;
}

async function getFileListingRules(): Promise<FileListingRules> {
    const rows = await query<FileListingSettingsRow>(
        'SELECT filter_patterns, star_patterns FROM file_listing_settings WHERE id = 1 LIMIT 1'
    );
    if (!rows[0]) throw new Error('File listing settings are missing');

    let parsed: unknown;
    try {
        parsed = {
            filter: JSON.parse(rows[0].filter_patterns),
            star: JSON.parse(rows[0].star_patterns)
        };
    } catch {
        throw new Error('File listing settings contain invalid JSON');
    }

    const rules = validateFileListingRules(parsed);
    if (!rules) throw new Error('File listing settings contain invalid patterns');
    return rules;
}

async function getDownloadUploadLimit(): Promise<number> {
    const rows = await query<DownloadUploadSettingsRow>(
        'SELECT max_upload_mb FROM download_upload_settings WHERE id = 1 LIMIT 1'
    );
    const maxUploadMb = Number(rows[0]?.max_upload_mb);
    if (!Number.isInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > MAX_DOWNLOAD_UPLOAD_MB) {
        throw new Error('Download upload size setting is invalid');
    }
    return maxUploadMb;
}

function sanitizeDownloadFilename(value: string): string {
    const portableName = value.replace(/\\/g, '/');
    const safeName = basename(portableName)
        .split('')
        .filter((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join('')
        .trim();
    return (safeName || 'download').slice(0, 255);
}

async function cleanupUploadedFile(res: Response, filePath: string): Promise<boolean> {
    try {
        await unlink(filePath);
        return true;
    } catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT') return true;
        logApiFailure(res, 'api.admin.download_upload_cleanup_failed', error);
        return false;
    }
}

async function resolveFilesPath(requestedPath: string) {
    if (requestedPath.length > 4096 || requestedPath.includes('\0')) {
        throw new FileRequestError(400, 'Ungültiger Dateipfad');
    }

    let root: string;
    try {
        root = await realpath(getFilesRoot());
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
            throw new FileRequestError(503, 'Das Dateiverzeichnis ist nicht verfügbar');
        }
        throw error;
    }

    const candidate = resolve(root, requestedPath || '.');
    if (!isPathInsideRoot(root, candidate)) {
        throw new FileRequestError(400, 'Ungültiger Dateipfad');
    }

    let canonicalPath: string;
    try {
        canonicalPath = await realpath(candidate);
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                throw new FileRequestError(404, 'Datei oder Ordner nicht gefunden');
            }
            if (error.code === 'EACCES' || error.code === 'EPERM') {
                throw new FileRequestError(403, 'Zugriff auf diesen Pfad verweigert');
            }
        }
        throw error;
    }

    if (!isPathInsideRoot(root, canonicalPath)) {
        throw new FileRequestError(403, 'Zugriff auf diesen Pfad verweigert');
    }
    return { root, path: canonicalPath };
}

function sendFileRequestFailure(res: Response, error: unknown, event: string) {
    if (error instanceof FileRequestError) {
        sendFailure(res, error.statusCode, error.message);
        return;
    }
    logApiFailure(res, event, error);
    sendServerFailure(res);
}

function getUserSession(res: Response): SessionData | null {
    const auth = res.locals.ssrAuth as { session?: SessionData | null } | undefined;
    return auth?.session || null;
}

function requireUser(res: Response): SessionData | null {
    const session = getUserSession(res);
    if (!session) sendFailure(res, 401, 'Anmeldung erforderlich');
    return session;
}

function requireAdmin(res: Response): SessionData | null {
    const session = requireUser(res);
    if (session && session.role !== 'admin') {
        sendFailure(res, 403, 'Administratorrechte erforderlich');
        return null;
    }
    return session;
}

async function requireFileAccess(res: Response): Promise<SessionData | null> {
    const session = requireUser(res);
    if (!session) return null;

    try {
        const users = await query<{ has_file_access: boolean | number | string }>(
            'SELECT has_file_access FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        const hasAccess = users[0]?.has_file_access === true ||
            users[0]?.has_file_access === 1 ||
            users[0]?.has_file_access === '1';
        if (!hasAccess) {
            sendFailure(res, 403, 'Dateizugriff ist nicht freigeschaltet');
            return null;
        }
        return session;
    } catch (error) {
        logApiFailure(res, 'api.files.authorization_failed', error);
        sendServerFailure(res);
        return null;
    }
}

function auditStatement(
    res: Response,
    actorId: string | null,
    action: string,
    details: Record<string, unknown> = {},
    targetType: string | null = null,
    targetId: string | null = null
): { sql: string; params: SqlParameter[] } {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : null;
    return {
        sql: `INSERT INTO audit_logs
                (user_uuid, action, details, request_id, target_type, target_id)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [actorId, action, JSON.stringify(details), requestId, targetType, targetId]
    };
}

function logApiFailure(res: Response, event: string, error: unknown) {
    logEvent('error', event, {
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
        error
    });
}

function logAuditCommitted(
    res: Response,
    actorId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    details: Record<string, unknown> = {}
) {
    logEvent('info', action, {
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
        userId: actorId,
        targetType,
        targetId,
        ...details
    });
}

function hashServiceStatusApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

async function authenticateServiceStatusApiKey(req: Request, res: Response): Promise<{ actorId: string | null } | null> {
    const authorization = req.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9+/]{64})$/.exec(authorization);
    const apiKey = match?.[1];
    if (!apiKey || Buffer.from(apiKey, 'base64').toString('base64') !== apiKey) {
        logEvent('warn', 'api.service_status.unauthorized', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
        });
        sendFailure(res, 401, 'Ungültiger API-Schlüssel');
        return null;
    }

    try {
        const keys = await query<{ token_hash: string; created_by: string | null }>(
            'SELECT token_hash, created_by FROM service_status_api_keys WHERE id = 1 LIMIT 1'
        );
        const storedHash = keys[0]?.token_hash;
        if (!storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        const expected = Buffer.from(storedHash, 'hex');
        const supplied = Buffer.from(hashServiceStatusApiKey(apiKey), 'hex');
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            logEvent('warn', 'api.service_status.unauthorized', {
                requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined
            });
            sendFailure(res, 401, 'Ungültiger API-Schlüssel');
            return null;
        }

        return { actorId: keys[0].created_by };
    } catch (error) {
        logApiFailure(res, 'api.service_status.authentication_failed', error);
        sendServerFailure(res);
        return null;
    }
}

function sendSuccess(res: Response, data: Record<string, unknown> = {}) {
    res.status(200).json({ success: true, ...data });
}

function sendFailure(res: Response, status: number, message: string) {
    res.status(status).json({ success: false, error: message });
}

function sendServerFailure(res: Response) {
    sendFailure(res, 500, 'Der Dienst ist derzeit nicht verfügbar');
}

function isDuplicateEntry(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error &&
        error.code === 'ER_DUP_ENTRY';
}

function secureDataAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;
    sendSuccess(res, { role: session.role });
}

async function loginAPIRoute(req: Request, res: Response) {
    try {
        if (getUserSession(res)) {
            sendFailure(res, 409, 'Bereits angemeldet');
            return;
        }

        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' ||
            !username.trim() || !password) {
            sendFailure(res, 400, 'Benutzername/E-Mail und Passwort sind erforderlich');
            return;
        }

        const ip = req.ip || '';
        const identifier = username.trim();
        const users = await query<{
            uuid: string;
            password_hash: string;
            role: string | null;
            is_active: boolean | number;
        }>(`
            SELECT u.uuid, u.password_hash, u.is_active,
                   (SELECT r.name FROM user_roles ur
                    JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_uuid = u.uuid
                    ORDER BY r.id LIMIT 1) AS role
            FROM users u
            WHERE u.username = ? OR u.email = ?
            LIMIT 1
        `, [identifier, identifier]);

        const user = users[0];
        if (!user || !verifyPassword(password, user.password_hash) || !user.is_active) {
            await execute(
                'INSERT INTO login_attempts (user_uuid, ip_address, success) VALUES (?, ?, FALSE)',
                [user?.uuid ?? null, ip]
            );
            sendFailure(res, 401, 'Benutzername oder Passwort ist falsch');
            return;
        }

        const sessionId = randomUUID();
        const timestamp = Date.now();
        const sessionData: SessionData = {
            userId: user.uuid,
            role: user.role || 'user',
            fingerprint: req.headers['user-agent'] || '',
            ip,
            timestamp,
            sessionId
        };

        await executeTransaction([
            {
                sql: `INSERT INTO sessions (id, user_uuid, ip_address, user_agent, expires_at)
                      VALUES (?, ?, ?, ?, ?)`,
                params: [sessionId, user.uuid, ip, sessionData.fingerprint, new Date(timestamp + SESSION_MAX_AGE)]
            },
            {
                sql: 'INSERT INTO login_attempts (user_uuid, ip_address, success) VALUES (?, ?, TRUE)',
                params: [user.uuid, ip]
            },
            auditStatement(res, user.uuid, 'auth.login.succeeded', {}, 'session')
        ]);
        logAuditCommitted(res, user.uuid, 'auth.login.succeeded', 'session', null);

        res.cookie('token', generateSecureToken(sessionData), {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: SESSION_MAX_AGE
        });
        logEvent('debug', 'auth.login.cookie_issued', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
            secureAttributeEnabled: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAgeMs: SESSION_MAX_AGE
        });
        sendSuccess(res, { role: sessionData.role });
    } catch (error) {
        logApiFailure(res, 'api.login.failed', error);
        sendServerFailure(res);
    }
}

async function registerAPIRoute(req: Request, res: Response) {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || typeof email !== 'string' ||
        typeof password !== 'string') {
        sendFailure(res, 400, 'Benutzername, E-Mail und Passwort sind erforderlich');
        return;
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (cleanUsername.length < 3 || cleanUsername.length > 64) {
        sendFailure(res, 400, 'Der Benutzername muss 3 bis 64 Zeichen lang sein');
        return;
    }
    if (!isValidEmail(cleanEmail)) {
        sendFailure(res, 400, 'Bitte gib eine gültige E-Mail-Adresse ein');
        return;
    }
    if (password.length < 8 || password.length > 128) {
        sendFailure(res, 400, 'Das Passwort muss 8 bis 128 Zeichen lang sein');
        return;
    }

    const existing = await query(
        'SELECT uuid FROM users WHERE username = ? OR email = ? LIMIT 1',
        [cleanUsername, cleanEmail]
    );
    if (existing.length) {
        sendFailure(res, 409, 'Benutzername oder E-Mail ist bereits registriert');
        return;
    }

    const userId = randomUUID();
    try {
        await executeTransaction([
            {
                sql: 'INSERT INTO users (uuid, username, email, password_hash) VALUES (?, ?, ?, ?)',
                params: [userId, cleanUsername, cleanEmail, hashPassword(password)]
            },
            {
                sql: `INSERT INTO user_roles (user_uuid, role_id)
                      SELECT ?, id FROM roles WHERE name = 'user' LIMIT 1`,
                params: [userId]
            },
            {
                sql: 'INSERT INTO user_settings (user_uuid) VALUES (?)',
                params: [userId]
            },
            auditStatement(res, userId, 'account.registered', {}, 'user', userId)
        ]);
        logAuditCommitted(res, userId, 'account.registered', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Benutzername oder E-Mail ist bereits registriert');
            return;
        }
        logApiFailure(res, 'api.registration.failed', error);
        sendServerFailure(res);
    }
}

async function logoutAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        await executeTransaction([
            { sql: 'DELETE FROM sessions WHERE id = ?', params: [session.sessionId] },
            auditStatement(res, session.userId, 'auth.logout.completed', {}, 'session')
        ]);
        logAuditCommitted(res, session.userId, 'auth.logout.completed', 'session', null);
        deleteToken(req.cookies?.token);
        res.clearCookie('token', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.logout.failed', error);
        sendServerFailure(res);
    }
}

async function getAccountAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        const rows = await query<{
            username: string;
            email: string;
            has_cloud_access: boolean | number | string;
            has_file_access: boolean | number | string;
        }>(
            'SELECT username, email, has_cloud_access, has_file_access FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!rows[0]) {
            sendFailure(res, 404, 'Benutzerkonto nicht gefunden');
            return;
        }
        const account = rows[0];
        sendSuccess(res, {
            account: {
                username: account.username,
                email: account.email,
                hasCloudAccess: account.has_cloud_access === true ||
                    account.has_cloud_access === 1 ||
                    account.has_cloud_access === '1',
                hasFileAccess: account.has_file_access === true ||
                    account.has_file_access === 1 ||
                    account.has_file_access === '1'
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.account.load_failed', error);
        sendServerFailure(res);
    }
}

async function updateAccountEmailAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { currentPassword, email } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (typeof currentPassword !== 'string' || !currentPassword || !isValidEmail(cleanEmail)) {
        sendFailure(res, 400, 'Bitte gib dein aktuelles Passwort und eine gültige E-Mail-Adresse ein');
        return;
    }

    try {
        const users = await query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!users[0] || !verifyPassword(currentPassword, users[0].password_hash)) {
            sendFailure(res, 401, 'Das aktuelle Passwort ist falsch');
            return;
        }
        await executeTransaction([
            { sql: 'UPDATE users SET email = ? WHERE uuid = ?', params: [cleanEmail, session.userId] },
            auditStatement(res, session.userId, 'account.email.changed', {}, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.email.changed', 'user', session.userId);
        sendSuccess(res, { email: cleanEmail });
    } catch (error) {
        if (isDuplicateEntry(error)) {
            sendFailure(res, 409, 'Diese E-Mail-Adresse wird bereits verwendet');
            return;
        }
        logApiFailure(res, 'api.account.email_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateAccountPasswordAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword ||
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        sendFailure(res, 400, 'Aktuelles Passwort und ein neues Passwort mit 8 bis 128 Zeichen sind erforderlich');
        return;
    }

    try {
        const users = await query<{ password_hash: string }>(
            'SELECT password_hash FROM users WHERE uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!users[0] || !verifyPassword(currentPassword, users[0].password_hash)) {
            sendFailure(res, 401, 'Das aktuelle Passwort ist falsch');
            return;
        }

        await executeTransaction([
            {
                sql: 'UPDATE users SET password_hash = ? WHERE uuid = ?',
                params: [hashPassword(newPassword), session.userId]
            },
            {
                sql: 'DELETE FROM sessions WHERE user_uuid = ? AND id <> ?',
                params: [session.userId, session.sessionId]
            },
            {
                sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?',
                params: [session.userId]
            },
            auditStatement(res, session.userId, 'account.password.changed', {
                otherSessionsRevoked: true,
                pendingPasswordResetsRevoked: true
            }, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.password.changed', 'user', session.userId, {
            otherSessionsRevoked: true,
            pendingPasswordResetsRevoked: true
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.account.password_update_failed', error);
        sendServerFailure(res);
    }
}

async function getUserSettingsAPIRoute(_req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    try {
        let rows = await query<{
            language: string;
            timezone: string;
            dark_mode: boolean | number | string;
        }>(
            'SELECT language, timezone, dark_mode FROM user_settings WHERE user_uuid = ? LIMIT 1',
            [session.userId]
        );
        if (!rows.length) {
            await executeTransaction([
                { sql: 'INSERT IGNORE INTO user_settings (user_uuid) VALUES (?)', params: [session.userId] },
                auditStatement(res, session.userId, 'account.settings.initialized', {}, 'user', session.userId)
            ]);
            logAuditCommitted(res, session.userId, 'account.settings.initialized', 'user', session.userId);
            rows = await query(
                'SELECT language, timezone, dark_mode FROM user_settings WHERE user_uuid = ? LIMIT 1',
                [session.userId]
            );
        }

        const settings = rows[0];
        if (!settings) throw new Error('User settings row was not created');
        sendSuccess(res, {
            settings: {
                language: settings.language,
                timezone: settings.timezone,
                darkMode: settings.dark_mode === true || settings.dark_mode === 1 || settings.dark_mode === '1'
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.settings.load_failed', error);
        sendFailure(res, 500, 'Einstellungen konnten nicht geladen werden');
    }
}

async function updateUserSettingsAPIRoute(req: Request, res: Response) {
    const session = requireUser(res);
    if (!session) return;

    const { language, timezone, darkMode } = req.body || {};
    if (typeof language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) {
        sendFailure(res, 400, 'Ungültige Sprache');
        return;
    }
    if (typeof timezone !== 'string' || timezone.length > 64 || !isValidTimezone(timezone)) {
        sendFailure(res, 400, 'Ungültige Zeitzone');
        return;
    }
    if (typeof darkMode !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Dark-Mode-Einstellung');
        return;
    }

    try {
        await executeTransaction([
            {
                sql: `INSERT INTO user_settings (user_uuid, language, timezone, dark_mode)
                      VALUES (?, ?, ?, ?)
                      ON DUPLICATE KEY UPDATE
                        language = VALUES(language),
                        timezone = VALUES(timezone),
                        dark_mode = VALUES(dark_mode)`,
                params: [session.userId, language, timezone, darkMode]
            },
            auditStatement(res, session.userId, 'account.settings.updated', {
                fields: ['language', 'timezone', 'darkMode']
            }, 'user', session.userId)
        ]);
        logAuditCommitted(res, session.userId, 'account.settings.updated', 'user', session.userId, {
            fields: ['language', 'timezone', 'darkMode']
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.settings.save_failed', error);
        sendFailure(res, 500, 'Einstellungen konnten nicht gespeichert werden');
    }
}

function isValidEmail(email: string): boolean {
    return email.length <= 128 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

function getPasswordResetUrl(token: string): string | null {
    const appBaseUrl = process.env.APP_BASE_URL?.trim();
    if (!appBaseUrl) return null;

    try {
        const baseUrl = new URL(appBaseUrl);
        if ((baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') ||
            (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')) {
            return null;
        }
        const resetUrl = new URL('/reset-password', baseUrl);
        resetUrl.hash = new URLSearchParams({ token }).toString();
        return resetUrl.toString();
    } catch {
        return null;
    }
}

async function resetPasswordAPIRoute(req: Request, res: Response) {
    const { token, newPassword } = req.body || {};
    if (typeof token !== 'string' || token.length !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        Buffer.from(token, 'base64url').toString('base64url') !== token ||
        typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        sendFailure(res, 400, 'Ungültiger Reset-Link oder ungültiges Passwort');
        return;
    }

    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    try {
        const userId = await withDatabaseTransaction(
            ['SELECT', 'UPDATE', 'DELETE', 'DELETE', 'INSERT'],
            async (connection) => {
                const resetRows = await connection.query<Array<{ user_uuid: string }>>(
                    `SELECT user_uuid
                     FROM password_reset_tokens
                     WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
                     FOR UPDATE`,
                    [tokenHash]
                );
                const reset = resetRows[0];
                if (!reset) return null;

                await connection.query(
                    'UPDATE users SET password_hash = ? WHERE uuid = ?',
                    [hashPassword(newPassword), reset.user_uuid]
                );
                await connection.query('DELETE FROM sessions WHERE user_uuid = ?', [reset.user_uuid]);
                await connection.query('DELETE FROM password_reset_tokens WHERE user_uuid = ?', [reset.user_uuid]);
                const audit = auditStatement(
                    res,
                    reset.user_uuid,
                    'auth.password_reset.completed',
                    {},
                    'user',
                    reset.user_uuid
                );
                await connection.query(audit.sql, audit.params);
                return reset.user_uuid;
            }
        );

        if (!userId) {
            sendFailure(res, 400, 'Der Reset-Link ist ungültig oder abgelaufen');
            return;
        }
        logAuditCommitted(res, userId, 'auth.password_reset.completed', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.password_reset.failed', error);
        sendServerFailure(res);
    }
}

async function getServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    try {
        const keys = await query<{ created_at: Date }>(
            'SELECT created_at FROM service_status_api_keys WHERE id = 1 LIMIT 1'
        );
        sendSuccess(res, {
            configured: Boolean(keys[0]),
            createdAt: keys[0]?.created_at || null
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_load_failed', error);
        sendServerFailure(res);
    }
}

async function rotateServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    const apiKey = randomBytes(48).toString('base64');
    try {
        await executeTransaction([
            {
                sql: `INSERT INTO service_status_api_keys (id, token_hash, created_by)
                      VALUES (1, ?, ?)
                      ON DUPLICATE KEY UPDATE
                        token_hash = VALUES(token_hash),
                        created_by = VALUES(created_by),
                        created_at = CURRENT_TIMESTAMP`,
                params: [hashServiceStatusApiKey(apiKey), admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.service_status_api_key.rotated',
                { keyLength: apiKey.length, encoding: 'base64' },
                'service_status_api_key',
                '1'
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.service_status_api_key.rotated',
            'service_status_api_key',
            '1',
            { keyLength: apiKey.length, encoding: 'base64' }
        );
        res.setHeader('Cache-Control', 'no-store');
        sendSuccess(res, { apiKey });
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_rotate_failed', error);
        sendServerFailure(res);
    }
}

async function revokeServiceStatusApiKeyAPIRoute(_req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    try {
        await executeTransaction([
            { sql: 'DELETE FROM service_status_api_keys WHERE id = 1' },
            auditStatement(
                res,
                admin.userId,
                'admin.service_status_api_key.revoked',
                {},
                'service_status_api_key',
                '1'
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.service_status_api_key.revoked',
            'service_status_api_key',
            '1'
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.service_status_key_revoke_failed', error);
        sendServerFailure(res);
    }
}

async function getServicesAPIRoute(_req: Request, res: Response) {
    try {
        const services = await getPublicServiceStatuses();
        sendSuccess(res, { services });
    } catch (error) {
        logApiFailure(res, 'api.services.load_failed', error);
        sendServerFailure(res);
    }
}

async function getPublicServiceStatuses(): Promise<PublicServiceStatus[]> {
    return query<PublicServiceStatus>(
            `SELECT id, name, address,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 'offline'
                        ELSE status
                    END AS status,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 'Keine Statusmeldung seit über 60 Sekunden'
                        ELSE details
                    END AS details
             FROM service_status ORDER BY sort_order, id`
        );
}

function writeServiceStatusEvent(client: Response, payload: string) {
    if (client.destroyed || client.writableEnded) return false;
    try {
        client.write(`event: services\ndata: ${payload}\n\n`);
        return true;
    } catch (error) {
        logEvent('warn', 'api.services.push_client_write_failed', { error });
        return false;
    }
}

async function refreshServiceStatusPush() {
    try {
        const services = await getPublicServiceStatuses();
        serviceStatusPushErrorLogged = false;
        const payload = JSON.stringify({ services });
        if (payload === lastPushedServiceStatus) return;
        lastPushedServiceStatus = payload;
        for (const client of serviceStatusClients) {
            if (!writeServiceStatusEvent(client, payload)) serviceStatusClients.delete(client);
        }
    } catch (error) {
        if (serviceStatusPushErrorLogged) return;
        serviceStatusPushErrorLogged = true;
        logEvent('error', 'api.services.push_refresh_failed', { error });
        logOperationalEvent({
            event: 'api.services.push_refresh_failed',
            level: 'error',
            details: { error }
        });
    }
}

function startServiceStatusPushTimer() {
    if (serviceStatusPushTimer) return;
    serviceStatusPushTimer = setInterval(() => void refreshServiceStatusPush(), SERVICE_STATUS_PUSH_INTERVAL_MS);
    serviceStatusPushTimer.unref();
}

async function serviceStatusEventsAPIRoute(_req: Request, res: Response) {
    try {
        const services = await getPublicServiceStatuses();
        const payload = JSON.stringify({ services });
        const existingClients = [...serviceStatusClients];

        res.status(200).set({
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write('retry: 5000\n\n');
        writeServiceStatusEvent(res, payload);
        serviceStatusClients.add(res);

        if (payload !== lastPushedServiceStatus) {
            lastPushedServiceStatus = payload;
            for (const client of existingClients) {
                if (!writeServiceStatusEvent(client, payload)) serviceStatusClients.delete(client);
            }
        }

        const heartbeat = setInterval(() => {
            if (res.destroyed || res.writableEnded) return;
            try {
                res.write(': keep-alive\n\n');
            } catch (error) {
                logEvent('warn', 'api.services.push_heartbeat_failed', { error });
                clearInterval(heartbeat);
                serviceStatusClients.delete(res);
            }
        }, 25_000);
        heartbeat.unref();
        res.on('close', () => {
            clearInterval(heartbeat);
            serviceStatusClients.delete(res);
            if (serviceStatusClients.size === 0 && serviceStatusPushTimer) {
                clearInterval(serviceStatusPushTimer);
                serviceStatusPushTimer = undefined;
            }
        });
        startServiceStatusPushTimer();
    } catch (error) {
        logApiFailure(res, 'api.services.push_connect_failed', error);
        sendServerFailure(res);
    }
}

async function updateServiceStatusFromServerAPIRoute(req: Request, res: Response) {
    const apiKeyAuth = await authenticateServiceStatusApiKey(req, res);
    if (!apiKeyAuth) return;

    const { name, status, details } = req.body || {};
    const serviceName = typeof name === 'string' ? name.trim() : '';
    const serviceDetails = typeof details === 'string' ? details.trim() : '';
    if (!serviceName || serviceName.length > 64 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        (details !== undefined && typeof details !== 'string') || serviceDetails.length > 255) {
        sendFailure(res, 400, 'Ungültige Serverstatus-Angaben');
        return;
    }

    try {
        const services = await query<{
            id: number;
            status: string;
            details: string;
            heartbeat_expired: number | string | boolean;
        }>(
            `SELECT id, status, details,
                    CASE
                        WHEN last_reported_at IS NOT NULL
                         AND last_reported_at < CURRENT_TIMESTAMP - INTERVAL 60 SECOND
                        THEN 1 ELSE 0
                    END AS heartbeat_expired
             FROM service_status WHERE name = ? LIMIT 1`,
            [serviceName]
        );
        const service = services[0];
        if (!service) {
            sendFailure(res, 404, 'Service nicht gefunden');
            return;
        }

        const detailsToSave = details === undefined ? service.details : serviceDetails;
        const wasHeartbeatExpired = Number(service.heartbeat_expired) === 1;
        const statusChanged = service.status !== status || (wasHeartbeatExpired && status !== 'offline');
        const detailsChanged = details !== undefined && service.details !== detailsToSave;
        const statements: Array<{ sql: string; params: SqlParameter[] }> = [{
            sql: `UPDATE service_status
                  SET status = ?, details = ?, updated_by = ?, last_reported_at = CURRENT_TIMESTAMP
                  WHERE id = ?`,
            params: [status, detailsToSave, apiKeyAuth.actorId, service.id]
        }];
        if (statusChanged || detailsChanged) {
            statements.push(auditStatement(
                res,
                apiKeyAuth.actorId,
                'service_status.reported',
                { status, source: 'api_key' },
                'service',
                String(service.id)
            ));
        }
        await executeTransaction(statements);
        void refreshServiceStatusPush();
        if (statusChanged || detailsChanged) {
            logAuditCommitted(
                res,
                apiKeyAuth.actorId,
                'service_status.reported',
                'service',
                String(service.id),
                { status, source: 'api_key' }
            );
        }
        sendSuccess(res, { updated: true });
    } catch (error) {
        logApiFailure(res, 'api.service_status.update_failed', error);
        sendServerFailure(res);
    }
}

async function getDownloadsAPIRoute(_req: Request, res: Response) {
    try {
        const downloads = await query<DownloadRow>(
            `SELECT id, title, description, url, is_active, created_at
             FROM downloads WHERE is_active = TRUE ORDER BY created_at DESC`
        );
        sendSuccess(res, { downloads });
    } catch (error) {
        logApiFailure(res, 'api.downloads.load_failed', error);
        sendServerFailure(res);
    }
}

async function getFilesAPIRoute(req: Request, res: Response) {
    if (!await requireFileAccess(res)) return;
    if (req.query.path !== undefined && typeof req.query.path !== 'string') {
        sendFailure(res, 400, 'Ungültiger Dateipfad');
        return;
    }

    try {
        const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
        const [{ root, path: directoryPath }, rules] = await Promise.all([
            resolveFilesPath(requestedPath),
            getFileListingRules()
        ]);
        const directoryStats = await stat(directoryPath);
        if (!directoryStats.isDirectory()) {
            sendFailure(res, 404, 'Ordner nicht gefunden');
            return;
        }

        const filterPatterns = compileFilePatterns(rules.filter);
        const starPatterns = compileFilePatterns(rules.star);
        const entries = await readdir(directoryPath, { withFileTypes: true });
        const contents = entries
            .filter((entry) => entry.isDirectory() || entry.isFile())
            .filter((entry) => !matchesFilePatterns(entry.name, filterPatterns))
            .map((entry) => ({
                name: entry.name,
                path: [relative(root, directoryPath), entry.name]
                    .filter(Boolean)
                    .join(sep)
                    .split(sep)
                    .join('/'),
                isDirectory: entry.isDirectory(),
                isStarred: matchesFilePatterns(entry.name, starPatterns)
            }))
            .sort((left, right) => {
                const leftGroup = left.isDirectory ? 0 : left.isStarred ? 1 : 2;
                const rightGroup = right.isDirectory ? 0 : right.isStarred ? 1 : 2;
                return leftGroup - rightGroup || left.name.localeCompare(right.name);
            });

        const currentPath = relative(root, directoryPath).split(sep).join('/');
        const parentDirectory = currentPath ? dirname(currentPath) : '';
        sendSuccess(res, {
            currentPath,
            parentPath: !currentPath || parentDirectory === '.' ? null : parentDirectory,
            contents
        });
    } catch (error) {
        sendFileRequestFailure(res, error, 'api.files.list_failed');
    }
}

async function downloadFileAPIRoute(req: Request, res: Response) {
    if (!await requireFileAccess(res)) return;
    if (typeof req.query.path !== 'string' || !req.query.path) {
        sendFailure(res, 400, 'Ungültiger Dateipfad');
        return;
    }

    try {
        const [{ path: filePath }, rules] = await Promise.all([
            resolveFilesPath(req.query.path),
            getFileListingRules()
        ]);
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
            sendFailure(res, 404, 'Datei nicht gefunden');
            return;
        }
        if (matchesFilePatterns(basename(filePath), compileFilePatterns(rules.filter))) {
            sendFailure(res, 404, 'Datei nicht gefunden');
            return;
        }

        res.download(filePath, basename(filePath), (error) => {
            if (!error) return;
            if (res.headersSent) {
                logApiFailure(res, 'api.files.download_stream_failed', error);
                return;
            }
            sendFileRequestFailure(res, error, 'api.files.download_failed');
        });
    } catch (error) {
        sendFileRequestFailure(res, error, 'api.files.download_failed');
    }
}

async function getAdminOverviewAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;

    try {
        const [users, activeUsers, sessions, failedLogins, downloads] = await Promise.all([
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM users'),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE'),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM sessions WHERE expires_at > CURRENT_TIMESTAMP'),
            query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM login_attempts
                                               WHERE success = FALSE AND attempted_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY`),
            query<{ count: number | string }>('SELECT COUNT(*) AS count FROM downloads WHERE is_active = TRUE')
        ]);
        sendSuccess(res, {
            overview: {
                users: Number(users[0]?.count || 0),
                activeUsers: Number(activeUsers[0]?.count || 0),
                activeSessions: Number(sessions[0]?.count || 0),
                failedLogins24h: Number(failedLogins[0]?.count || 0),
                activeDownloads: Number(downloads[0]?.count || 0)
            }
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.overview_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminUsersAPIRoute(req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';

    try {
        const users = await query<{
            uuid: string;
            username: string;
            email: string;
            is_active: boolean | number;
            has_cloud_access: boolean | number | string;
            has_file_access: boolean | number | string;
            role: string | null;
            created_at: Date;
        }>(`
            SELECT u.uuid, u.username, u.email, u.is_active, u.has_cloud_access, u.has_file_access, u.created_at,
                   (SELECT r.name FROM user_roles ur
                    JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_uuid = u.uuid
                    ORDER BY r.id LIMIT 1) AS role
            FROM users u
            WHERE (? = '' OR u.username LIKE CONCAT('%', ?, '%') OR u.email LIKE CONCAT('%', ?, '%'))
            ORDER BY u.created_at DESC
            LIMIT 100
        `, [search, search, search]);
        sendSuccess(res, {
            users: users.map((user) => ({
                ...user,
                is_active: Boolean(user.is_active),
                has_cloud_access: user.has_cloud_access === true ||
                    user.has_cloud_access === 1 ||
                    user.has_cloud_access === '1',
                has_file_access: user.has_file_access === true ||
                    user.has_file_access === 1 ||
                    user.has_file_access === '1',
                role: user.role || 'user'
            }))
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.users_load_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserRoleAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { role } = req.body || {};
    if (typeof role !== 'string' || !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
        sendFailure(res, 400, 'Ungültige Benutzerrolle');
        return;
    }
    if (userId === admin.userId && role !== 'admin') {
        sendFailure(res, 400, 'Die eigene Administratorrolle kann hier nicht entfernt werden');
        return;
    }

    try {
        const roleRows = await query<{ id: number }>('SELECT id FROM roles WHERE name = ? LIMIT 1', [role]);
        if (!roleRows[0]) {
            sendFailure(res, 404, 'Rolle nicht gefunden');
            return;
        }
        await executeTransaction([
            { sql: 'DELETE FROM user_roles WHERE user_uuid = ?', params: [userId] },
            {
                sql: 'INSERT INTO user_roles (user_uuid, role_id) VALUES (?, ?)',
                params: [userId, roleRows[0].id]
            },
            auditStatement(res, admin.userId, 'admin.user.role_changed', { role }, 'user', userId)
        ]);
        logAuditCommitted(res, admin.userId, 'admin.user.role_changed', 'user', userId, { role });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_role_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserStatusAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
        sendFailure(res, 400, 'Ungültiger Kontostatus');
        return;
    }
    if (userId === admin.userId && !isActive) {
        sendFailure(res, 400, 'Das eigene Konto kann hier nicht gesperrt werden');
        return;
    }

    try {
        const statements: Array<{ sql: string; params: SqlParameter[] }> = [
            { sql: 'UPDATE users SET is_active = ? WHERE uuid = ?', params: [isActive, userId] }
        ];
        if (!isActive) {
            statements.push({ sql: 'DELETE FROM sessions WHERE user_uuid = ?', params: [userId] });
            statements.push({ sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?', params: [userId] });
        }
        statements.push(auditStatement(
            res,
            admin.userId,
            isActive ? 'admin.user.activated' : 'admin.user.deactivated',
            { isActive },
            'user',
            userId
        ));
        await executeTransaction(statements);
        logAuditCommitted(
            res,
            admin.userId,
            isActive ? 'admin.user.activated' : 'admin.user.deactivated',
            'user',
            userId,
            { isActive }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_status_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserCloudAccessAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Cloud-Berechtigung');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'UPDATE users SET has_cloud_access = ? WHERE uuid = ?', params: [enabled, userId] },
            auditStatement(
                res,
                admin.userId,
                enabled ? 'admin.user.cloud_access_granted' : 'admin.user.cloud_access_revoked',
                { enabled },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            enabled ? 'admin.user.cloud_access_granted' : 'admin.user.cloud_access_revoked',
            'user',
            userId,
            { enabled }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_cloud_access_update_failed', error);
        sendServerFailure(res);
    }
}

async function updateUserFileAccessAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Dateiberechtigung');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'UPDATE users SET has_file_access = ? WHERE uuid = ?', params: [enabled, userId] },
            auditStatement(
                res,
                admin.userId,
                enabled ? 'admin.user.file_access_granted' : 'admin.user.file_access_revoked',
                { enabled },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            enabled ? 'admin.user.file_access_granted' : 'admin.user.file_access_revoked',
            'user',
            userId,
            { enabled }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_file_access_update_failed', error);
        sendServerFailure(res);
    }
}

async function deleteUserAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const userId = req.params.uuid;
    if (userId === admin.userId) {
        sendFailure(res, 400, 'Das eigene Konto kann hier nicht gelöscht werden');
        return;
    }

    try {
        await executeTransaction([
            { sql: 'DELETE FROM users WHERE uuid = ?', params: [userId] },
            auditStatement(res, admin.userId, 'admin.user.deleted', {}, 'user', userId)
        ]);
        logAuditCommitted(res, admin.userId, 'admin.user.deleted', 'user', userId);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.user_delete_failed', error);
        sendServerFailure(res);
    }
}

async function requestAdminPasswordResetAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    if (!isSmtpConfigured()) {
        sendFailure(res, 503, 'SMTP-Mailversand ist nicht konfiguriert');
        return;
    }

    const requestedEmail = req.body?.recipientEmail;
    if (requestedEmail !== undefined && typeof requestedEmail !== 'string') {
        sendFailure(res, 400, 'Ungültige Wunsch-E-Mail-Adresse');
        return;
    }
    const customEmail = typeof requestedEmail === 'string' ? requestedEmail.trim() : '';
    if (customEmail && !isValidEmail(customEmail)) {
        sendFailure(res, 400, 'Ungültige Wunsch-E-Mail-Adresse');
        return;
    }

    const userId = req.params.uuid;
    try {
        const users = await query<{ username: string; email: string }>(
            'SELECT username, email FROM users WHERE uuid = ? LIMIT 1',
            [userId]
        );
        const user = users[0];
        if (!user) {
            sendFailure(res, 404, 'Benutzerkonto nicht gefunden');
            return;
        }

        const token = randomBytes(32).toString('base64url');
        const resetUrl = getPasswordResetUrl(token);
        if (!resetUrl) {
            sendFailure(res, 503, 'APP_BASE_URL fehlt oder ist ungültig; der Reset-Link kann nicht erstellt werden');
            return;
        }

        const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
        const recipientType = customEmail ? 'custom' : 'account';
        const recipient = customEmail || user.email;
        await executeTransaction([
            { sql: 'DELETE FROM password_reset_tokens WHERE user_uuid = ?', params: [userId] },
            {
                sql: `INSERT INTO password_reset_tokens
                        (token_hash, user_uuid, created_by, expires_at)
                      VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 1 HOUR))`,
                params: [tokenHash, userId, admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.password_reset.requested',
                { recipientType },
                'user',
                userId
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.password_reset.requested',
            'user',
            userId,
            { recipientType }
        );

        try {
            await sendPasswordResetEmail(recipient, user.username, resetUrl);
        } catch (error) {
            logApiFailure(res, 'api.admin.password_reset_email_failed', error);
            try {
                await execute('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
            } catch (cleanupError) {
                logApiFailure(res, 'api.admin.password_reset_token_cleanup_failed', cleanupError);
            }
            sendFailure(res, 502, 'Reset-Mail konnte nicht versendet werden; bitte SMTP-Verbindung prüfen');
            return;
        }

        logEvent('info', 'email.password_reset.sent', {
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined,
            userId,
            recipientType
        });
        sendSuccess(res, { recipientType });
    } catch (error) {
        logApiFailure(res, 'api.admin.password_reset_request_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminServicesAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    getServicesAPIRoute(_req, res);
}

async function updateServiceStatusAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const serviceId = Number(req.params.id);
    const { status, details } = req.body || {};
    if (!Number.isInteger(serviceId) || serviceId <= 0 ||
        typeof status !== 'string' || !VALID_SERVICE_STATUSES.includes(status as typeof VALID_SERVICE_STATUSES[number]) ||
        typeof details !== 'string' || details.length > 255) {
        sendFailure(res, 400, 'Ungültige Serverstatus-Angaben');
        return;
    }

    try {
        await executeTransaction([
            {
                sql: 'UPDATE service_status SET status = ?, details = ?, updated_by = ? WHERE id = ?',
                params: [status, details.trim(), admin.userId, serviceId]
            },
            auditStatement(res, admin.userId, 'admin.service.status_changed', { status }, 'service', String(serviceId))
        ]);
        void refreshServiceStatusPush();
        logAuditCommitted(res, admin.userId, 'admin.service.status_changed', 'service', String(serviceId), { status });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.service_update_failed', error);
        sendServerFailure(res);
    }
}

function validateDownloadMetadata(body: unknown): { title: string; description: string } | null {
    if (!body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if (typeof value.title !== 'string' ||
        (value.description !== undefined && typeof value.description !== 'string')) return null;

    const title = value.title.trim();
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!title || title.length > 128 || description.length > 2000) return null;
    return { title, description };
}

function validateDownloadInput(body: unknown): { title: string; description: string; url: string } | null {
    const metadata = validateDownloadMetadata(body);
    if (!metadata || !body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if (typeof value.url !== 'string') return null;
    const url = value.url.trim();
    if (url.length > 2048) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    } catch {
        return null;
    }
    return { ...metadata, url };
}

async function getAdminDownloadsAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    try {
        const [downloads, maxUploadMb] = await Promise.all([
            query<DownloadRow>(
                'SELECT id, title, description, url, is_active, created_at, storage_key, original_filename FROM downloads ORDER BY created_at DESC'
            ),
            getDownloadUploadLimit()
        ]);
        sendSuccess(res, {
            downloads: downloads.map((download) => ({ ...download, is_active: Boolean(download.is_active) })),
            maxUploadMb
        });
    } catch (error) {
        logApiFailure(res, 'api.admin.downloads_load_failed', error);
        sendServerFailure(res);
    }
}

async function getPublicDownloadFileAPIRoute(req: Request, res: Response) {
    const storageKey = req.params.storageKey;
    if (!isValidDownloadStorageKey(storageKey)) {
        sendFailure(res, 404, 'Download nicht gefunden');
        return;
    }

    try {
        const downloads = await query<Pick<DownloadRow, 'original_filename'>>(
            'SELECT original_filename FROM downloads WHERE storage_key = ? AND is_active = TRUE LIMIT 1',
            [storageKey]
        );
        const download = downloads[0];
        if (!download) {
            sendFailure(res, 404, 'Download nicht gefunden');
            return;
        }

        const filePath = await resolveStoredDownloadPath(storageKey);
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
            sendFailure(res, 404, 'Download nicht gefunden');
            return;
        }
        res.download(filePath, sanitizeDownloadFilename(download.original_filename || 'download'), (error) => {
            if (!error) return;
            logApiFailure(res, 'api.download.file_send_failed', error);
            if (!res.headersSent) sendServerFailure(res);
        });
    } catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT') {
            sendFailure(res, 404, 'Download nicht gefunden');
            return;
        }
        logApiFailure(res, 'api.download.file_load_failed', error);
        sendServerFailure(res);
    }
}

async function getAdminFileListingSettingsAPIRoute(_req: Request, res: Response) {
    if (!requireAdmin(res)) return;
    try {
        sendSuccess(res, { rules: await getFileListingRules() });
    } catch (error) {
        logApiFailure(res, 'api.admin.files.settings_load_failed', error);
        sendServerFailure(res);
    }
}

async function updateAdminFileListingSettingsAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const rules = validateFileListingRules(req.body);
    if (!rules) {
        sendFailure(res, 400, 'Ungültige Filter- oder Stern-Regeln');
        return;
    }

    try {
        await executeTransaction([
            {
                sql: `UPDATE file_listing_settings
                      SET filter_patterns = ?, star_patterns = ?, updated_by = ?
                      WHERE id = 1`,
                params: [JSON.stringify(rules.filter), JSON.stringify(rules.star), admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.files.rules.updated',
                { filter: rules.filter, star: rules.star },
                'file_listing_settings',
                '1'
            )
        ]);
        logAuditCommitted(res, admin.userId, 'admin.files.rules.updated', 'file_listing_settings', '1', {
            filterCount: rules.filter.length,
            starCount: rules.star.length
        });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.files.settings_update_failed', error);
        sendServerFailure(res);
    }
}

async function createDownloadAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const download = validateDownloadInput(req.body);
    if (!download) {
        sendFailure(res, 400, 'Bitte gib einen Titel und eine gültige HTTP(S)-URL ein');
        return;
    }
    try {
        await executeTransaction([
            {
                sql: 'INSERT INTO downloads (title, description, url, created_by) VALUES (?, ?, ?, ?)',
                params: [download.title, download.description, download.url, admin.userId]
            },
            auditStatement(res, admin.userId, 'admin.download.created', {}, 'download')
        ]);
        logAuditCommitted(res, admin.userId, 'admin.download.created', 'download', null);
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.download_create_failed', error);
        sendServerFailure(res);
    }
}

async function updateAdminDownloadUploadSettingsAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const maxUploadMb = req.body?.maxUploadMb;
    if (!Number.isInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > MAX_DOWNLOAD_UPLOAD_MB) {
        sendFailure(res, 400, `Die Upload-Grenze muss zwischen 1 und ${MAX_DOWNLOAD_UPLOAD_MB} MB liegen`);
        return;
    }

    try {
        await executeTransaction([
            {
                sql: 'UPDATE download_upload_settings SET max_upload_mb = ?, updated_by = ? WHERE id = 1',
                params: [maxUploadMb, admin.userId]
            },
            auditStatement(
                res,
                admin.userId,
                'admin.download.upload_limit_updated',
                { maxUploadMb },
                'download_upload_settings',
                '1'
            )
        ]);
        logAuditCommitted(
            res,
            admin.userId,
            'admin.download.upload_limit_updated',
            'download_upload_settings',
            '1',
            { maxUploadMb }
        );
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.download_upload_limit_update_failed', error);
        sendServerFailure(res);
    }
}

async function completeDownloadUpload(req: Request, res: Response, adminId: string, uploadError: unknown) {
    if (uploadError) {
        if (uploadError instanceof multer.MulterError) {
            const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
            sendFailure(
                res,
                tooLarge ? 413 : 400,
                tooLarge ? 'Die Datei überschreitet das konfigurierte Upload-Limit' : 'Ungültige Upload-Anfrage'
            );
            return;
        }
        logApiFailure(res, 'api.admin.download_upload_failed', uploadError);
        sendServerFailure(res);
        return;
    }

    const file = req.file;
    if (!file) {
        sendFailure(res, 400, 'Bitte wähle eine Datei aus');
        return;
    }

    const originalFilename = sanitizeDownloadFilename(file.originalname);
    const suppliedTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = suppliedTitle || originalFilename;
    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    const metadata = validateDownloadMetadata({ title, description });
    if (!metadata) {
        const cleaned = await cleanupUploadedFile(res, file.path);
        if (!cleaned) {
            sendServerFailure(res);
            return;
        }
        sendFailure(res, 400, 'Der Titel darf höchstens 128 und die Beschreibung höchstens 2000 Zeichen lang sein');
        return;
    }

    const storageKey = file.filename;
    const url = `/api/downloads/file/${storageKey}`;
    try {
        await executeTransaction([
            {
                sql: `INSERT INTO downloads
                      (title, description, url, is_active, storage_key, original_filename, created_by)
                      VALUES (?, ?, ?, TRUE, ?, ?, ?)`,
                params: [metadata.title, metadata.description, url, storageKey, originalFilename, adminId]
            },
            auditStatement(
                res,
                adminId,
                'admin.download.uploaded',
                { sizeBytes: file.size },
                'download'
            )
        ]);
        logAuditCommitted(res, adminId, 'admin.download.uploaded', 'download', null, { sizeBytes: file.size });
        sendSuccess(res, { downloadUrl: url });
    } catch (error) {
        await cleanupUploadedFile(res, file.path);
        logApiFailure(res, 'api.admin.download_upload_failed', error);
        sendServerFailure(res);
    }
}

async function uploadDownloadAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;

    let maxUploadMb: number;
    try {
        maxUploadMb = await getDownloadUploadLimit();
    } catch (error) {
        logApiFailure(res, 'api.admin.download_upload_limit_load_failed', error);
        sendServerFailure(res);
        return;
    }

    const storage = multer.diskStorage({
        destination: (_request, _file, callback) => {
            ensureDownloadStorageRoot().then(
                (root) => callback(null, root),
                (error: unknown) => callback(error instanceof Error ? error : new Error('Unable to prepare download storage'), '')
            );
        },
        filename: (_request, _file, callback) => callback(null, createDownloadStorageKey())
    });
    const upload = multer({
        storage,
        limits: {
            fileSize: maxUploadMb * 1024 * 1024,
            files: 1,
            fields: 2,
            parts: 3
        }
    }).single('file');
    upload(req, res, (error) => {
        void completeDownloadUpload(req, res, admin.userId, error);
    });
}

async function updateDownloadAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const id = Number(req.params.id);
    const metadata = validateDownloadMetadata(req.body);
    const isActive = req.body?.isActive;
    if (!Number.isInteger(id) || id <= 0 || !metadata || typeof isActive !== 'boolean') {
        sendFailure(res, 400, 'Ungültige Download-Angaben');
        return;
    }
    try {
        const rows = await query<Pick<DownloadRow, 'storage_key' | 'url'>>(
            'SELECT storage_key, url FROM downloads WHERE id = ? LIMIT 1',
            [id]
        );
        const existing = rows[0];
        if (!existing) {
            sendFailure(res, 404, 'Download nicht gefunden');
            return;
        }
        const externalDownload = existing.storage_key ? null : validateDownloadInput(req.body);
        if (!existing.storage_key && !externalDownload) {
            sendFailure(res, 400, 'Bitte gib eine gültige HTTP(S)-URL ein');
            return;
        }
        await executeTransaction([
            {
                sql: 'UPDATE downloads SET title = ?, description = ?, url = ?, is_active = ? WHERE id = ?',
                params: [
                    metadata.title,
                    metadata.description,
                    externalDownload?.url ?? existing.url,
                    isActive,
                    id
                ]
            },
            auditStatement(res, admin.userId, 'admin.download.updated', { isActive }, 'download', String(id))
        ]);
        logAuditCommitted(res, admin.userId, 'admin.download.updated', 'download', String(id), { isActive });
        sendSuccess(res);
    } catch (error) {
        logApiFailure(res, 'api.admin.download_update_failed', error);
        sendServerFailure(res);
    }
}

async function deleteDownloadAPIRoute(req: Request, res: Response) {
    const admin = requireAdmin(res);
    if (!admin) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        sendFailure(res, 400, 'Ungültige Download-ID');
        return;
    }
    try {
        const rows = await query<Pick<DownloadRow, 'storage_key'>>(
            'SELECT storage_key FROM downloads WHERE id = ? LIMIT 1',
            [id]
        );
        if (!rows[0]) {
            sendFailure(res, 404, 'Download nicht gefunden');
            return;
        }
        await executeTransaction([
            { sql: 'DELETE FROM downloads WHERE id = ?', params: [id] },
            auditStatement(
                res,
                admin.userId,
                'admin.download.deleted',
                { uploaded: Boolean(rows[0].storage_key) },
                'download',
                String(id)
            )
        ]);
        logAuditCommitted(res, admin.userId, 'admin.download.deleted', 'download', String(id));
        let cleanupFailed = false;
        if (rows[0].storage_key) {
            try {
                await unlink(getStoredDownloadPathForCleanup(rows[0].storage_key));
            } catch (error) {
                if (getNodeErrorCode(error) !== 'ENOENT') {
                    cleanupFailed = true;
                    logApiFailure(res, 'api.admin.download_file_delete_failed', error);
                }
            }
        }
        sendSuccess(res, { cleanupFailed });
    } catch (error) {
        logApiFailure(res, 'api.admin.download_delete_failed', error);
        sendServerFailure(res);
    }
}

export default function createApiRouter(app: Router): Router {
    const router = Router();
    app.use('/api', router);

    router.get('/secure-data', secureDataAPIRoute);
    router.post('/login', loginAPIRoute);
    router.post('/register', registerAPIRoute);
    router.post('/logout', logoutAPIRoute);
    router.post('/password-reset', resetPasswordAPIRoute);
    router.get('/settings', getUserSettingsAPIRoute);
    router.put('/settings', updateUserSettingsAPIRoute);
    router.get('/account', getAccountAPIRoute);
    router.put('/account/email', updateAccountEmailAPIRoute);
    router.put('/account/password', updateAccountPasswordAPIRoute);
    router.get('/services', getServicesAPIRoute);
    router.get('/services/events', serviceStatusEventsAPIRoute);
    router.put('/services/status', updateServiceStatusFromServerAPIRoute);
    router.get('/downloads', getDownloadsAPIRoute);
    router.get('/downloads/file/:storageKey', getPublicDownloadFileAPIRoute);
    router.get('/files', getFilesAPIRoute);
    router.get('/files/download', downloadFileAPIRoute);
    router.get('/admin/overview', getAdminOverviewAPIRoute);
    router.get('/admin/users', getAdminUsersAPIRoute);
    router.put('/admin/users/:uuid/role', updateUserRoleAPIRoute);
    router.patch('/admin/users/:uuid/status', updateUserStatusAPIRoute);
    router.patch('/admin/users/:uuid/cloud-access', updateUserCloudAccessAPIRoute);
    router.patch('/admin/users/:uuid/file-access', updateUserFileAccessAPIRoute);
    router.delete('/admin/users/:uuid', deleteUserAPIRoute);
    router.post('/admin/users/:uuid/password-reset', requestAdminPasswordResetAPIRoute);
    router.get('/admin/services', getAdminServicesAPIRoute);
    router.get('/admin/services/status-key', getServiceStatusApiKeyAPIRoute);
    router.post('/admin/services/status-key', rotateServiceStatusApiKeyAPIRoute);
    router.delete('/admin/services/status-key', revokeServiceStatusApiKeyAPIRoute);
    router.put('/admin/services/:id', updateServiceStatusAPIRoute);
    router.get('/admin/downloads', getAdminDownloadsAPIRoute);
    router.put('/admin/downloads/settings', updateAdminDownloadUploadSettingsAPIRoute);
    router.get('/admin/files/settings', getAdminFileListingSettingsAPIRoute);
    router.put('/admin/files/settings', updateAdminFileListingSettingsAPIRoute);
    router.post('/admin/downloads', createDownloadAPIRoute);
    router.post('/admin/downloads/upload', uploadDownloadAPIRoute);
    router.put('/admin/downloads/:id', updateDownloadAPIRoute);
    router.delete('/admin/downloads/:id', deleteDownloadAPIRoute);
    return router;
}
