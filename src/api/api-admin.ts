import { Router } from 'express';
import { createAdminDownloadsRouter } from './api-admin-downloads.ts';
import { createAdminUsersRouter } from './api-admin-users.ts';
import { createAdminServicesRouter } from './api-services.ts';

export function createAdminRouter(): Router {
    const router = Router();
    router.use(createAdminUsersRouter());
    router.use('/services', createAdminServicesRouter());
    router.use(createAdminDownloadsRouter());
    return router;
}
