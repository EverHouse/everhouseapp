import { Router } from 'express';
import contactsRouter from './contacts';
import formsRouter from './forms';
import webhooksRouter from './webhooks';
import syncRouter from './sync';
import adminRouter from './admin';

export { invalidateHubSpotContactsCache, fetchAllHubSpotContacts } from './shared';

const router = Router();

router.use(contactsRouter);
router.use(formsRouter);
router.use(webhooksRouter);
router.use(syncRouter);
router.use(adminRouter);

export default router;
