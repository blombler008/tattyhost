import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { unlink } from 'node:fs/promises';
import { executeTransaction, query } from '@tattyhost/SQLutils';
import { auditStatement, getNodeErrorCode, logApiFailure, logAuditCommitted, requireAdmin, sendFailure, sendServerFailure, sendSuccess } from './api-shared.ts';
import { getStoredDownloadPathForCleanup, createDownloadStorageKey, ensureDownloadStorageRoot } from '../files/download-storage.ts';
import { validateFileListingRules } from '../files/file-listing.ts';
import { getFileListingRules } from './api-file-utils.ts';
import { cleanupUploadedFile, getDownloadUploadLimit, MAX_DOWNLOAD_UPLOAD_MB, sanitizeDownloadFilename, validateDownloadInput, validateDownloadMetadata, type DownloadRow } from './api-download-utils.ts';

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

export function createAdminDownloadsRouter(): Router {
    const router = Router();
    const downloadsRouter = Router();
    const filesRouter = Router();
    downloadsRouter.get('/', getAdminDownloadsAPIRoute);
    downloadsRouter.put('/settings', updateAdminDownloadUploadSettingsAPIRoute);
    filesRouter.get('/settings', getAdminFileListingSettingsAPIRoute);
    filesRouter.put('/settings', updateAdminFileListingSettingsAPIRoute);
    downloadsRouter.post('/', createDownloadAPIRoute);
    downloadsRouter.post('/upload', uploadDownloadAPIRoute);
    downloadsRouter.put('/:id', updateDownloadAPIRoute);
    downloadsRouter.delete('/:id', deleteDownloadAPIRoute);
    router.use('/downloads', downloadsRouter);
    router.use('/files', filesRouter);
    return router;
}
