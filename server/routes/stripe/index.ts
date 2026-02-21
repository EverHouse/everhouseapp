import { Router } from 'express';
import configRouter from './config';
import paymentsRouter from './payments';
import subscriptionsRouter from './subscriptions';
import invoicesRouter from './invoices';
import memberPaymentsRouter from './member-payments';
import adminRouter from './admin';
import couponsRouter from './coupons';

import terminalRouter from './terminal';

const router = Router();

router.use(configRouter);
router.use(paymentsRouter);
router.use(subscriptionsRouter);
router.use(invoicesRouter);
router.use(memberPaymentsRouter);
router.use(adminRouter);
router.use(couponsRouter);

router.use(terminalRouter);

export default router;
