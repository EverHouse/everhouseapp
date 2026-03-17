import { Router } from 'express';
import contextRouter from './context';
import billingRouter from './billing';
import directAddRouter from './directAdd';

const router = Router();

router.use(contextRouter);
router.use(billingRouter);
router.use(directAddRouter);

export default router;
