import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { getAllTemplates, renderTemplatePreview } from '../core/emailTemplatePreview';
import { logFromRequest } from '../core/auditLog';

const router = Router();

router.get('/api/admin/email-templates', isStaffOrAdmin, async (_req, res) => {
  try {
    const templates = getAllTemplates();
    res.json({ templates });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

router.get('/api/admin/email-templates/:templateId/preview', isStaffOrAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const html = await renderTemplatePreview(templateId as string);

    if (!html) {
      return res.status(404).json({ error: 'Template not found' });
    }

    logFromRequest(req, 'view_email_template', 'system', templateId as string, `Email template preview: ${templateId}`);

    res.json({ html });
  } catch (error: unknown) {
    res.status(500).json({ error: 'Failed to render template preview' });
  }
});

export default router;
