// === SERVER SETUP ===
import fs from 'node:fs/promises';
import express, { type Request, type Response, type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import ApiRouter from './src/api/api-routes.ts';
import { checkAuthMiddleware } from './src/middleware/check-auth.ts';
import { setupAllTables } from './lib/SQLUtils/DBSchemaSetup.ts';
import { closeDatabasePool, getDatabasePoolStats } from './lib/SQLUtils/SQLUtils.ts';
import { flushFileLogs, logEvent, pruneLogFiles } from './src/logging/app-logger.ts';
import {
    flushDatabaseLogs,
    getLogRoute,
    logOperationalEvent,
    pruneOperationalLogs,
    requestLoggingMiddleware
} from './src/logging/operational-log.ts';

const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || 5173;
const base = process.env.BASE || '/';
logEvent('info', 'system.server.starting', { environment: process.env.NODE_ENV || 'development', port, base });

async function failStartup(event: string, error: unknown): Promise<never> {
    logEvent('error', event, { error });
    try {
        await closeDatabasePool();
    } catch (closeError) {
        logEvent('error', 'system.database.close_after_startup_failure_failed', { error: closeError });
    }
    await flushFileLogs();
    throw error;
}

try {
    await setupAllTables();
} catch (error) {
    await failStartup('system.database.setup_failed', error);
}

let templateHtml = '';
if (isProduction) {
    try {
        templateHtml = await fs.readFile('./dist/client/index.html', 'utf-8');
    } catch (error) {
        await failStartup('system.server.template_load_failed', error);
    }
}

const app = express();
app.set('trust proxy', 'loopback');

let vite: import('vite').ViteDevServer | undefined = undefined;
try {
    if (!isProduction) {
        const { createServer } = await import('vite');
        vite = await createServer({
            server: { middlewareMode: true },
            appType: 'custom',
            base
        });

        logEvent('info', 'system.vite.started', { mode: 'middleware' });

        app.use(vite.middlewares);
    } else {
        const compression = (await import('compression')).default;
        const sirv = (await import('sirv')).default;
        app.use(compression());
        app.use(base, sirv('./dist/client', { extensions: [] }));
    }
} catch (error) {
    await failStartup('system.http_middleware.start_failed', error);
}

app.use(requestLoggingMiddleware);
app.use(express.json());
app.use(cookieParser());
app.use(checkAuthMiddleware); // Middleware to check auth status
ApiRouter(app);

app.use('*all', async (req: Request, res: Response) => {
    try {
        const url = req.originalUrl.replace(base, '');
        let template = templateHtml;
        type ServerRender = typeof import('./src/entry-server.tsx').render;
        let render: ServerRender;
        if (!isProduction) {
            template = await fs.readFile('./index.html', 'utf-8');
            template = await vite!.transformIndexHtml(url, template);
            render = (await vite!.ssrLoadModule('./src/entry-server.tsx')).render;
        } else {
            const builtEntry = await import(new URL('./dist/server/entry-server.js', import.meta.url).href) as {
                render: ServerRender;
            };
            render = builtEntry.render;
        } 

        const rendered = await render(url, req, res);
        const ssrAuth = res.locals.ssrAuth; // Get the SSR auth state from the response locals
        const html = template!
            .replace(`<!--app-head-->`, rendered.head ?? '')
            .replace(`<!--app-html-->`, rendered.html ?? '')
            .replace(`<!--app-auth-->`, JSON.stringify(ssrAuth));
  
        res.status(200).set({
            'Cache-Control': 'private, no-store, no-cache, must-revalidate',
            'Content-Type': 'text/html',
            Expires: '0',
            Pragma: 'no-cache'
        }).end(html);
    } catch (error) {
        if (error instanceof Error) vite?.ssrFixStacktrace(error);
        logOperationalEvent({
            requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : null,
            event: 'http.ssr.failed',
            level: 'error',
            method: req.method,
            route: getLogRoute(req),
            statusCode: 500,
            details: { error }
        });
        res.status(500).send('Internal Server Error');
    }
});

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) {
        next(error);
        return;
    }

    const statusCode = typeof error === 'object' && error !== null && 'status' in error &&
        typeof error.status === 'number' && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
    logOperationalEvent({
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : null,
        event: 'http.middleware.failed',
        level: statusCode >= 500 ? 'error' : 'warn',
        method: req.method,
        route: getLogRoute(req),
        statusCode,
        details: { error }
    });

    if (req.path.startsWith('/api/')) {
        res.status(statusCode).json({ success: false, error: 'Anfrage konnte nicht verarbeitet werden' });
    } else {
        res.status(statusCode).send('Anfrage konnte nicht verarbeitet werden');
    }
};
app.use(errorHandler);

try {
    await Promise.all([pruneLogFiles(), pruneOperationalLogs()]);
} catch (error) {
    logEvent('error', 'logging.retention_cleanup_failed', { error });
}

const retentionTimer = setInterval(() => {
    void Promise.all([pruneLogFiles(), pruneOperationalLogs()]).catch((error: unknown) => {
        logEvent('error', 'logging.retention_cleanup_failed', { error });
    });
}, 24 * 60 * 60 * 1000);
retentionTimer.unref();

logOperationalEvent({
    event: 'system.database.ready',
    details: getDatabasePoolStats()
});

const httpServer = app.listen(port, () => {
    logOperationalEvent({
        event: 'system.server.started',
        details: { environment: process.env.NODE_ENV || 'development', port, base, ...getDatabasePoolStats() }
    });
});

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(retentionTimer);
    logOperationalEvent({ event: 'system.server.stopping', details: { signal } });

    httpServer.close(async (error) => {
        if (error) logEvent('error', 'system.server.close_failed', { error });
        let shutdownError: unknown = error;
        try {
            if (vite) await vite.close();
            logOperationalEvent({ event: 'system.server.stopped', details: { signal } });
            await flushDatabaseLogs();
            await closeDatabasePool();
        } catch (closeError) {
            shutdownError = closeError;
            logEvent('error', 'system.server.shutdown_failed', { error: closeError });
        }
        await flushFileLogs();
        process.exitCode = shutdownError ? 1 : 0;
    });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
httpServer.once('error', (error) => {
    logEvent('error', 'system.server.listen_failed', { error });
    logOperationalEvent({ event: 'system.server.listen_failed', level: 'error', details: { error } });
    void (async () => {
        try {
            if (vite) await vite.close();
            await flushDatabaseLogs();
            await closeDatabasePool();
        } catch (shutdownError) {
            logEvent('error', 'system.server.listen_failure_cleanup_failed', { error: shutdownError });
        }
        await flushFileLogs();
        process.exitCode = 1;
    })();
});
