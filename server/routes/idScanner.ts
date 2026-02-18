import { Router } from 'express';
import { isStaffOrAdmin } from '../core/middleware';
import { openai } from '../replit_integrations/image/client';
import { ObjectStorageService } from '../replit_integrations/object_storage';
import { db } from '../db';
import { users } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { logFromRequest } from '../core/auditLog';
import { logger } from '../core/logger';

const router = Router();
const objectStorageService = new ObjectStorageService();

router.post('/api/admin/scan-id', isStaffOrAdmin, async (req, res) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: image and mimeType' });
    }

    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
      return res.status(400).json({ error: 'Invalid mimeType. Must be image/jpeg or image/png' });
    }

    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    if (Buffer.byteLength(image, 'base64') > maxSizeBytes) {
      return res.status(400).json({ error: 'Image too large. Maximum size is 10MB.' });
    }

    const dataUrl = `data:${mimeType};base64,${image}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an ID document scanner. Analyze the provided image of a driver's license or ID card. Extract personal information and assess the image quality. Return a JSON object with exactly this structure:
{
  "data": {
    "firstName": "string or null if unreadable",
    "lastName": "string or null if unreadable",
    "dateOfBirth": "YYYY-MM-DD format or null if unreadable",
    "streetAddress": "string or null if unreadable",
    "city": "string or null if unreadable",
    "state": "two-letter state code or null if unreadable",
    "zipCode": "string or null if unreadable"
  },
  "quality": {
    "isReadable": true or false,
    "qualityIssues": []
  }
}

For qualityIssues, include any applicable values from: "too_blurry", "too_dark", "too_far", "glare", "partially_obscured".
Set isReadable to false if the image quality significantly impacts the ability to extract information.
Even if quality is poor, still attempt to extract whatever information is visible.`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please scan this ID document and extract the personal information. Also assess the image quality.'
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ],
      max_tokens: 1000
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return res.status(500).json({ error: 'No response from AI model' });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      logger.error('Failed to parse AI response', { extra: { content } });
      return res.status(500).json({ error: 'Failed to parse scan results' });
    }

    const data = parsed.data || {
      firstName: null, lastName: null, dateOfBirth: null,
      streetAddress: null, city: null, state: null, zipCode: null
    };
    const quality = parsed.quality || { isReadable: false, qualityIssues: ['parse_error'] };

    logFromRequest(req, 'scan_id', 'member', undefined, undefined, {
      isReadable: quality.isReadable,
      qualityIssues: quality.qualityIssues,
      fieldsExtracted: Object.entries(data).filter(([_, v]) => v !== null).map(([k]) => k),
    });

    res.json({
      success: true,
      data,
      quality
    });
  } catch (error: unknown) {
    logger.error('ID scan error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to scan ID document' });
  }
});

router.post('/api/admin/save-id-image', isStaffOrAdmin, async (req, res) => {
  try {
    const { userId, image, mimeType } = req.body;

    if (!userId || !image || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: userId, image, and mimeType' });
    }

    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
      return res.status(400).json({ error: 'Invalid mimeType. Must be image/jpeg or image/png' });
    }

    const maxSizeBytes = 10 * 1024 * 1024; // 10MB limit
    if (Buffer.byteLength(image, 'base64') > maxSizeBytes) {
      return res.status(400).json({ error: 'Image too large. Maximum size is 10MB.' });
    }

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const buffer = Buffer.from(image, 'base64');
    const uploadResponse = await fetch(uploadURL, {
      method: 'PUT',
      body: buffer,
      headers: { 'Content-Type': mimeType },
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload to storage');
    }

    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    const publicUrl = `/objects${objectPath.replace('/objects', '')}`;

    await db.update(users).set({ idImageUrl: publicUrl }).where(eq(users.id, userId));

    logFromRequest(req, 'save_id_image', 'member', userId, undefined, { imageUrl: publicUrl });

    res.json({ success: true, imageUrl: publicUrl });
  } catch (error: unknown) {
    logger.error('Save ID image error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to save ID image' });
  }
});

router.get('/api/admin/member/:userId/id-image', isStaffOrAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await db.select({ idImageUrl: users.idImageUrl }).from(users).where(eq(users.id, userId as string)).limit(1);

    if (result.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ idImageUrl: result[0].idImageUrl });
  } catch (error: unknown) {
    logger.error('Get ID image error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to get ID image' });
  }
});

router.delete('/api/admin/member/:userId/id-image', isStaffOrAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    await db.update(users).set({ idImageUrl: null }).where(eq(users.id, userId as string));

    logFromRequest(req, 'delete_id_image', 'member', userId as string);

    res.json({ success: true });
  } catch (error: unknown) {
    logger.error('Delete ID image error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete ID image' });
  }
});

export default router;
