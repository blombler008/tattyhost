import { resolve, relative, isAbsolute, sep } from 'node:path';
import { DEFAULT_FILE_LISTING_RULES, type FileListingRules } from '../../lib/SQLUtils/FileListingDefaults.ts';

export { DEFAULT_FILE_LISTING_RULES, type FileListingRules };

const MAX_FILE_RULES = 100;
const MAX_FILE_RULE_LENGTH = 128;

export function validateFileListingRules(value: unknown): FileListingRules | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;

    function validatePatterns(patterns: unknown): string[] | null {
        if (!Array.isArray(patterns) || patterns.length > MAX_FILE_RULES) return null;
        const result: string[] = [];

        for (const pattern of patterns) {
            if (typeof pattern !== 'string') return null;
            const trimmed = pattern.trim();
            if (!trimmed) continue;
            if (trimmed.length > MAX_FILE_RULE_LENGTH) return null;
            try {
                new RegExp(trimmed);
            } catch {
                return null;
            }
            result.push(trimmed);
        }

        return result;
    }

    const filter = validatePatterns(candidate.filter);
    const star = validatePatterns(candidate.star);
    return filter && star ? { filter, star } : null;
}

export function compileFilePatterns(patterns: string[]): RegExp[] {
    return patterns.map((pattern) => new RegExp(pattern));
}

export function matchesFilePatterns(name: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(name));
}

export function getFilesRoot(): string {
    const fallback = process.platform === 'win32'
        ? resolve('webfiles')
        : '/home/lucie/privdata/webfiles';
    return resolve(process.env.FILES_ROOT || fallback);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
    const relativePath = relative(root, candidate);
    return relativePath === '' ||
        (relativePath !== '..' &&
            !relativePath.startsWith(`..${sep}`) &&
            !isAbsolute(relativePath));
}
