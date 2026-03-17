import { Router } from 'express';
import checksRouter from './checks';
import syncRouter from './sync';
import cleanupRouter from './cleanup';
import fixesBookingRouter from './fixes-booking';
import fixesMemberRouter from './fixes-member';

const router = Router();

router.use(checksRouter);
router.use(syncRouter);
router.use(cleanupRouter);
router.use(fixesBookingRouter);
router.use(fixesMemberRouter);

export default router;
