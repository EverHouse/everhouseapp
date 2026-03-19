import { Router } from 'express';
import { otpRouter } from './otp';
import { sessionRouter } from './session';
export { createSupabaseToken } from './helpers';

const router = Router();
router.use(otpRouter);
router.use(sessionRouter);

export default router;
