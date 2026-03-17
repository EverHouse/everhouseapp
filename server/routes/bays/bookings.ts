import { Router } from 'express';
import bookingListRouter from './booking-list';
import bookingCreateRouter from './booking-create';
import bookingCancelRouter from './booking-cancel';
import bookingQueriesRouter from './booking-queries';

const router = Router();

router.use(bookingListRouter);
router.use(bookingCreateRouter);
router.use(bookingQueriesRouter);
router.use(bookingCancelRouter);

export default router;
