import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { isStaffOrAdmin } from '../core/middleware';
import { ObjectStorageService } from '../replit_integrations/object_storage';
import { logger } from '../core/logger';

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const objectStorageService = new ObjectStorageService();

router.post('/api/admin/upload-image', isStaffOrAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const originalName = req.file.originalname.replace(/\.[^/.]+$/, '');
    const timestamp = Date.now();
    const filename = `${originalName}-${timestamp}.webp`;

    const webpBuffer = await sharp(req.file.buffer)
      .webp({ quality: 80 })
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    
    const uploadResponse = await fetch(uploadURL, {
      method: 'PUT',
      body: webpBuffer,
      headers: { 'Content-Type': 'image/webp' },
    });

    if (!uploadResponse.ok) {
      throw new Error('Failed to upload to storage');
    }

    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    const publicUrl = `/objects${objectPath.replace('/objects', '')}`;

    res.json({ 
      success: true, 
      imageUrl: publicUrl,
      objectPath,
      filename,
      originalSize: req.file.size,
      optimizedSize: webpBuffer.length
    });
  } catch (error: unknown) {
    logger.error('Image upload error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to upload and convert image' });
  }
});

export default router;
