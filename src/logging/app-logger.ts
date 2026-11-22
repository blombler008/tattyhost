import 'dotenv/config';
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const logDirectory = resolve(process.env.LOG_DIR || 'logs');
const retentionValue = Number(process.env.LOG_RETENTION_DAYS || 90);
export const logRetentionDays = Number.isInteger(retentionValue) && retentionValue > 0 ? retentionValue : 90;
const levelPriority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = process.env.APP_LOG_LEVEL?.toLowerCase();
const minimumLevel: LogLevel = (['debug', 'info', 'warn', 'error'] as const)
    .find((level) => level === configuredLevel) || 'info';
const sensitiveKeyPattern = /password|token|secret|authorization|cookie|email|username|body|user[_-]?agent|fingerprint|sql|query/i;
const levelColors: Record<LogLevel, string> = {
    debug: '\u001b[94m',
    info: '\u001b[32m',
    warn: '\u001b[33m',
    error: '\u001b[31m'
};
const colorReset = '\u001b[0m';

let fileQueue = Promise.resolve();

function isSensitiveKey(key: string) {
    return sensitiveKeyPattern.test(key) || /^ip(?:_address)?$/i.test(key) || /^session[_-]?id$/i.test(key);
}

function normalizeValue(value: unknown, key = '', depth = 0): unknown {
    if (isSensitiveKey(key)) return '[REDACTED]';
    if (value instanceof Error) {
        const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
        return { name: value.name, ...(code ? { code } : {}) };
    }
    if (typeof value === 'string' && key.toLowerCase() === 'error') return '[REDACTED_ERROR]';
    if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 4) return '[MAX_DEPTH]';
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => normalizeValue(item, '', depth + 1));

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 50)
            .map(([childKey, childValue]) => [childKey, normalizeValue(childValue, childKey, depth + 1)])
    );
}

export function sanitizeLogDetails(details: Record<string, unknown>) {
    return normalizeValue(details) as Record<string, unknown>;
}

function formatConsoleValue(value: unknown): string {
    if (typeof value === 'string') {
        return inspect(value, { colors: false, compact: true, breakLength: Infinity });
    }
    return inspect(value, {
        colors: false,
        compact: true,
        breakLength: Infinity,
        depth: 3,
        maxArrayLength: 20,
        maxStringLength: 200
    });
}

function formatConsoleLine(level: LogLevel, timestamp: string, event: string, context: Record<string, unknown>) {
    const time = new Date(timestamp).toLocaleTimeString();
    const fields = Object.entries(context)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatConsoleValue(value)}`);
    const line = `[${time}] ${level.toUpperCase().padEnd(5)} ${event}${fields.length ? ` | ${fields.join(' ')}` : ''}`;
    return line;
}

function writeConsoleLine(level: LogLevel, line: string) {
    const streamIsTTY = level === 'error' ? process.stderr.isTTY : process.stdout.isTTY;
    const useColor = !process.env.NO_COLOR && (streamIsTTY || Boolean(process.env.FORCE_COLOR));
    const output = useColor ? `${levelColors[level]}${line}${colorReset}` : line;

    if (level === 'error') console.error(output);
    else if (level === 'warn') console.warn(output);
    else if (level === 'debug') console.debug(output);
    else console.info(output);
}

function writeLogFile(line: string, timestamp: string) {
    const fileName = `tattyhost-${timestamp.slice(0, 10)}.log`;
    fileQueue = fileQueue.then(async () => {
        await mkdir(logDirectory, { recursive: true, mode: 0o700 });
        await appendFile(join(logDirectory, fileName), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    }).catch((error: unknown) => {
        const failedAt = new Date().toISOString();
        writeConsoleLine('error', formatConsoleLine('error', failedAt, 'logging.file_write_failed', {
            error: normalizeValue(error)
        }));
    });
}

export function logEvent(level: LogLevel, event: string, context: Record<string, unknown> = {}) {
    if (levelPriority[level] < levelPriority[minimumLevel]) return;

    const timestamp = new Date().toISOString();
    const entry = normalizeValue({ timestamp, level, event, ...context }) as Record<string, unknown>;
    writeConsoleLine(level, formatConsoleLine(
        level,
        timestamp,
        String(entry.event),
        Object.fromEntries(Object.entries(entry).filter(([key]) => !['timestamp', 'level', 'event'].includes(key)))
    ));
    writeLogFile(JSON.stringify(entry), timestamp);
}

export async function pruneLogFiles() {
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
    const fileNames = await readdir(logDirectory);

    for (const fileName of fileNames) {
        if (!/^tattyhost-\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;
        const date = fileName.slice('tattyhost-'.length, -'.log'.length);
        const fileTime = Date.parse(`${date}T00:00:00.000Z`);
        if (Number.isFinite(fileTime) && fileTime < cutoff) {
            await unlink(join(logDirectory, fileName));
        }
    }
}

export async function flushFileLogs() {
    await fileQueue;
}
