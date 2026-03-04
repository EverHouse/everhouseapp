import { Router } from 'express';
import bookingFeesRouter from './booking-fees';
import quickChargeRouter from './quick-charge';
import paymentAdminRouter from './payment-admin';
import financialReportsRouter from './financial-reports';

const router = Router();

router.use(bookingFeesRouter);
router.use(quickChargeRouter);
router.use(paymentAdminRouter);
router.use(financialReportsRouter);

export default router;
