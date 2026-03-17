import { Router } from 'express';
import bookingPaymentsRouter from './booking-payments';
import savedCardsRouter from './saved-cards';
import invoicesRouter from './invoices';
import guestPassesRouter from './guest-passes';
import balanceRouter from './balance';

const router = Router();

router.use(bookingPaymentsRouter);
router.use(savedCardsRouter);
router.use(invoicesRouter);
router.use(guestPassesRouter);
router.use(balanceRouter);

export default router;
