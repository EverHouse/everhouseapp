import { Router } from 'express';
import crudRouter from './crud';
import adminRouter from './admin';

const router = Router();
router.use(crudRouter);
router.use(adminRouter);

export default router;
