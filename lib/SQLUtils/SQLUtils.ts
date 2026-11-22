// === SQLUtils.ts ===

import mariadb, { type PoolConnection } from 'mariadb';
import dotenv from 'dotenv';
import { TokenState } from './TokenState.ts';
import { logEvent } from '../../src/logging/app-logger.ts';

dotenv.config();
TokenState.INVALID_SIGNATURE;

// === ENVIRONMENT VARIABLES ===
const DB_HOST = process.env.SQL_ADDR || process.env['sql-addr'];
const DB_PORT = Number(process.env.SQL_PORT || process.env['sql-port']);
const DB_USER = process.env.WEB_USER || process.env['web-user'];
const DB_PASS = process.env.WEB_KEY || process.env['web-key'];
const DB_NAME = process.env.SQL_DATABASE || process.env['web-database'];

// === POOL SETUP ===
const pool = mariadb.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    connectionLimit: 5
});

pool.on('connection', () => {
    const details = getDatabasePoolStats();
    logEvent('info', 'database.connection.opened', details);
});
pool.on('enqueue', () => {
    logEvent('warn', 'database.connection.queued', getDatabasePoolStats());
});

export type SqlParameter = string | number | boolean | Date | null;

function getSqlOperation(sql: string): string {
    return sql.trimStart().match(/^[a-z]+/i)?.[0].toUpperCase() || 'UNKNOWN';
}

export function getDatabasePoolStats() {
    return {
        activeConnections: pool.activeConnections(),
        idleConnections: pool.idleConnections(),
        totalConnections: pool.totalConnections(),
        queuedRequests: pool.taskQueueSize()
    };
}

export async function insertOperationalLogRecord(params: SqlParameter[]) {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query(
            `INSERT INTO application_logs
                (request_id, log_level, event_name, method, route, status_code, duration_ms, user_uuid, details)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params
        );
    } finally {
        if (conn) conn.release();
    }
}

export async function closeDatabasePool() {
    if (pool.closed) return;
    logEvent('info', 'database.pool.closing', getDatabasePoolStats());
    await pool.end();
    logEvent('info', 'database.pool.closed');
}

export async function withDatabaseTransaction<T>(
    operations: string[],
    callback: (connection: PoolConnection) => Promise<T>
): Promise<T> {
    let conn;
    const startedAt = Date.now();
    logEvent('info', 'database.transaction.started', { statementCount: operations.length, operations });
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const result = await callback(conn);
        await conn.commit();
        logEvent('info', 'database.transaction.committed', {
            statementCount: operations.length,
            operations,
            durationMs: Date.now() - startedAt
        });
        return result;
    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                logEvent('error', 'database.transaction.rollback_failed', {
                    operations,
                    error: rollbackError
                });
            }
        }
        logEvent('error', 'database.transaction.failed', {
            statementCount: operations.length,
            operations,
            durationMs: Date.now() - startedAt,
            error
        });
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

export async function executeTransaction(
    statements: Array<{ sql: string; params?: SqlParameter[] }>
): Promise<void> {
    const operations = statements.map((statement) => getSqlOperation(statement.sql));
    await withDatabaseTransaction(operations, async (connection) => {
        for (const statement of statements) {
            await connection.query(statement.sql, statement.params || []);
        }
    });
}

// === QUERY EXECUTION ===
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    let conn;
    const operation = getSqlOperation(sql);
    const startedAt = Date.now();
    logEvent('info', 'database.query.started', { operation });
    try {
        conn = await pool.getConnection();
        const result = await conn.query(sql, params);
        logEvent('info', 'database.query.completed', { operation, durationMs: Date.now() - startedAt });
        return result;
    } catch (error) {
        logEvent('error', 'database.query.failed', {
            operation,
            durationMs: Date.now() - startedAt,
            error
        });
        throw error;
    } finally {
        if (conn) conn.release();
    }
}

export async function execute(sql: string, params: any[] = []): Promise<void> {
    let conn;
    const operation = getSqlOperation(sql);
    const startedAt = Date.now();
    logEvent('info', 'database.command.started', { operation });
    try {
        conn = await pool.getConnection();
        await conn.query(sql, params);
        logEvent('info', 'database.command.completed', { operation, durationMs: Date.now() - startedAt });
    } catch (error) {
        logEvent('error', 'database.command.failed', {
            operation,
            durationMs: Date.now() - startedAt,
            error
        });
        throw error;
    } finally {
        if (conn) conn.release();
    }
}
