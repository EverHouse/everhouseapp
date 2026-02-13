import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { getAllTemplates, renderTemplatePreview } from '../core/emailTemplatePreview';
import { logFromRequest } from '../core/auditLog';

const router = Router();

router.get('/api/admin/email-templates', isStaffOrAdmin, async (_req, res) => {
  try {
    const templates = getAllTemplates();
    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

router.get('/api/admin/email-templates/:templateId/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const html = renderTemplatePreview(templateId);

    if (!html) {
      return res.status(404).json({ error: 'Template not found' });
    }

    logFromRequest(req, 'view' as any, 'system' as any, templateId, `Email template preview: ${templateId}`);

    res.json({ html });
  } catch (error) {
    res.status(500).json({ error: 'Failed to render template preview' });
  }
});

export default router;
