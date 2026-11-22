import type { Response } from 'express';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { query } from '@tattyhost/SQLutils';
import {
    getFilesRoot,
    isPathInsideRoot,
    validateFileListingRules,
    type FileListingRules
} from '../files/file-listing.ts';
import { logApiFailure, sendFailure, sendServerFailure } from './api-shared.ts';

type FileListingSettingsRow = {
    filter_patterns: string;
    star_patterns: string;
};

class FileRequestError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message);
    }
}

export async function getFileListingRules(): Promise<FileListingRules> {
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

export async function resolveFilesPath(requestedPath: string) {
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

export function sendFileRequestFailure(res: Response, error: unknown, event: string) {
    if (error instanceof FileRequestError) {
        sendFailure(res, error.statusCode, error.message);
        return;
    }
    logApiFailure(res, event, error);
    sendServerFailure(res);
}
