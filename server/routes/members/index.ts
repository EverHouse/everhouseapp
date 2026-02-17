import { Router } from 'express';
import searchRouter from './search';
import profileRouter from './profile';
import adminActionsRouter from './admin-actions';
import communicationsRouter from './communications';
import notesRouter from './notes';
import visitorsRouter from './visitors';
import dashboardRouter from './dashboard';
import onboardingRouter from './onboarding';
import applicationPipelineRouter from './applicationPipeline';

const router = Router();

router.use(searchRouter);
router.use(profileRouter);
router.use(adminActionsRouter);
router.use(communicationsRouter);
router.use(notesRouter);
router.use(visitorsRouter);
router.use(dashboardRouter);
router.use(onboardingRouter);
router.use(applicationPipelineRouter);

export default router;
