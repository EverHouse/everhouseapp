import { Router } from 'express';
import crudRouter from './crud';
import rsvpRouter from './rsvp';
import syncRouter from './sync';

const router = Router();

router.use(crudRouter);
router.use(rsvpRouter);
router.use(syncRouter);

export default router;
