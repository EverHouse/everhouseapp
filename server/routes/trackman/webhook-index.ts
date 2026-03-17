import { Router } from 'express';
import webhookReceiverRouter from './webhook-receiver';
import webhookDiagnosticsRouter from './webhook-diagnostics';
import webhookAdminOpsRouter, { cleanupOldWebhookLogs } from './webhook-admin-ops';
import webhookReprocessRouter from './webhook-reprocess';

const router = Router();

router.use(webhookReceiverRouter);
router.use(webhookDiagnosticsRouter);
router.use(webhookAdminOpsRouter);
router.use(webhookReprocessRouter);

export { cleanupOldWebhookLogs };

export default router;
