import { Router, type Request, type Response } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import { query } from '@tattyhost/SQLutils';
import { compileFilePatterns, matchesFilePatterns } from '../files/file-listing.ts';
import { isValidDownloadStorageKey, resolveStoredDownloadPath } from '../files/download-storage.ts';
import { getFileListingRules, resolveFilesPath, sendFileRequestFailure } from './api-file-utils.ts';
import { getNodeErrorCode, logApiFailure, requireFileAccess, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { sanitizeDownloadFilename, type DownloadRow } from './api-download-utils.ts';

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
            parentPath: !currentPath ? null : parentDirectory === '.' ? '' : parentDirectory,
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

export function createFilesRouter(): Router {
    const router = Router();
    router.get('/downloads', getDownloadsAPIRoute);
    router.get('/downloads/file/:storageKey', getPublicDownloadFileAPIRoute);
    router.get('/files', getFilesAPIRoute);
    router.get('/files/download', downloadFileAPIRoute);
    return router;
}
