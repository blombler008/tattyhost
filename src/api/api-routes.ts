import { Router } from 'express';
import { createAccountRouter } from './api-account.ts';
import { createAdminRouter } from './api-admin.ts';
import { createAuthRouter } from './api-auth.ts';
import { createFilesRouter } from './api-files.ts';
import { createServicesRouter } from './api-services.ts';

export default function createApiRouter(app: Router): Router {
    const router = Router();
    const adminRouter = Router();
    app.use('/api', router);
    adminRouter.use('/admin', createAdminRouter());
    router.use(
        createAuthRouter(),
        createAccountRouter(),
        createServicesRouter(),
        createFilesRouter(),
        adminRouter
    );
    return router;
}
