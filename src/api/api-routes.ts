import { Router } from 'express';
import { createAccountRouter } from './api-account.ts';
import { createAccountMinecraftRouter } from './api-account-minecraft.ts';
import { createAdminRouter } from './api-admin.ts';
import { createAuthRouter } from './api-auth.ts';
import { createFilesRouter } from './api-files.ts';
import { createServicesRouter } from './api-services.ts';
import { createWhitelistRouter } from './api-whitelist.ts';
import { createThnPlayersRouter } from './api-thn-players.ts';

export default function createApiRouter(app: Router): Router {
    const router = Router();
    const adminRouter = Router();
    app.use('/api', router);
    adminRouter.use('/admin', createAdminRouter());
    router.use(
        createAuthRouter(),
        createAccountRouter(),
        createAccountMinecraftRouter(),
        createServicesRouter(),
        createThnPlayersRouter(),
        createWhitelistRouter(),
        createFilesRouter(),
        adminRouter
    );
    return router;
}
