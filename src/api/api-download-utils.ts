import { unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Response } from 'express';
import { query } from '@tattyhost/SQLutils';
import { getNodeErrorCode, logApiFailure } from './api-shared.ts';

export const MAX_DOWNLOAD_UPLOAD_MB = 512;

type DownloadUploadSettingsRow = {
    max_upload_mb: number | string;
};

export type DownloadRow = {
    id: number;
    title: string;
    description: string | null;
    url: string;
    is_active: boolean | number | string;
    created_at: Date;
    storage_key?: string | null;
    original_filename?: string | null;
};

export async function getDownloadUploadLimit(): Promise<number> {
    const rows = await query<DownloadUploadSettingsRow>(
        'SELECT max_upload_mb FROM download_upload_settings WHERE id = 1 LIMIT 1'
    );
    const maxUploadMb = Number(rows[0]?.max_upload_mb);
    if (!Number.isInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > MAX_DOWNLOAD_UPLOAD_MB) {
        throw new Error('Download upload size setting is invalid');
    }
    return maxUploadMb;
}

export function sanitizeDownloadFilename(value: string): string {
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

export async function cleanupUploadedFile(res: Response, filePath: string): Promise<boolean> {
    try {
        await unlink(filePath);
        return true;
    } catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT') return true;
        logApiFailure(res, 'api.admin.download_upload_cleanup_failed', error);
        return false;
    }
}

export function validateDownloadMetadata(body: unknown): { title: string; description: string } | null {
    if (!body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if (typeof value.title !== 'string' ||
        (value.description !== undefined && typeof value.description !== 'string')) return null;

    const title = value.title.trim();
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!title || title.length > 128 || description.length > 2000) return null;
    return { title, description };
}

export function validateDownloadInput(body: unknown): { title: string; description: string; url: string } | null {
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
