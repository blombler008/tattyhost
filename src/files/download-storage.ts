import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isPathInsideRoot } from './file-listing.ts';

const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getDownloadStorageRoot(): string {
    return resolve(process.env.DOWNLOADS_ROOT || 'uploads/downloads');
}

export function createDownloadStorageKey(): string {
    return randomUUID();
}

export function isValidDownloadStorageKey(value: string): boolean {
    return STORAGE_KEY_PATTERN.test(value);
}

export async function ensureDownloadStorageRoot(): Promise<string> {
    const root = getDownloadStorageRoot();
    await mkdir(root, { recursive: true });
    return root;
}

export async function resolveStoredDownloadPath(storageKey: string): Promise<string> {
    if (!isValidDownloadStorageKey(storageKey)) {
        throw new Error('Invalid stored download key');
    }

    const root = await realpath(getDownloadStorageRoot());
    const candidate = resolve(root, storageKey);
    if (!isPathInsideRoot(root, candidate)) {
        throw new Error('Stored download path is outside its configured directory');
    }

    const canonicalPath = await realpath(candidate);
    if (!isPathInsideRoot(root, canonicalPath)) {
        throw new Error('Stored download path is outside its configured directory');
    }
    return canonicalPath;
}

export function getStoredDownloadPathForCleanup(storageKey: string): string {
    if (!isValidDownloadStorageKey(storageKey)) {
        throw new Error('Invalid stored download key');
    }
    return join(getDownloadStorageRoot(), storageKey);
}
