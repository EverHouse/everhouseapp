import { Router } from 'express';
import { db } from '../db';
import { galleryImages } from '../../shared/schema';
import { eq, asc } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';
import { logAndRespond } from '../core/logger';

const router = Router();

router.get('/api/gallery', async (req, res) => {
  try {
    const { include_inactive } = req.query;
    
    let images;
    if (include_inactive === 'true') {
      images = await db.select().from(galleryImages).orderBy(asc(galleryImages.sortOrder));
    } else {
      images = await db.select().from(galleryImages).where(eq(galleryImages.isActive, true)).orderBy(asc(galleryImages.sortOrder));
    }
    
    const formatted = images.map(img => ({
      id: img.id,
      img: img.imageUrl,
      imageUrl: img.imageUrl,
      category: img.category || 'venue',
      title: img.title,
      sortOrder: img.sortOrder,
      isActive: img.isActive
    }));
    
    res.json(formatted);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to fetch gallery', error, 'GALLERY_FETCH_ERROR');
  }
});

router.post('/api/admin/gallery', isStaffOrAdmin, async (req, res) => {
  try {
    const { title, imageUrl, category, sortOrder, isActive } = req.body;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }
    
    const [newImage] = await db.insert(galleryImages).values({
      title: title || null,
      imageUrl,
      category: category || 'venue',
      sortOrder: sortOrder || 0,
      isActive: isActive !== false
    }).returning();
    
    res.status(201).json(newImage);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to create gallery image', error, 'GALLERY_CREATE_ERROR');
  }
});

router.put('/api/admin/gallery/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, imageUrl, category, sortOrder, isActive } = req.body;
    
    const [updated] = await db.update(galleryImages)
      .set({
        title: title !== undefined ? title : undefined,
        imageUrl: imageUrl !== undefined ? imageUrl : undefined,
        category: category !== undefined ? category : undefined,
        sortOrder: sortOrder !== undefined ? sortOrder : undefined,
        isActive: isActive !== undefined ? isActive : undefined
      })
      .where(eq(galleryImages.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Gallery image not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to update gallery image', error, 'GALLERY_UPDATE_ERROR');
  }
});

router.delete('/api/admin/gallery/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [updated] = await db.update(galleryImages)
      .set({ isActive: false })
      .where(eq(galleryImages.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Gallery image not found' });
    }
    
    res.json({ success: true, archived: updated });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to archive gallery image', error, 'GALLERY_DELETE_ERROR');
  }
});

router.post('/api/admin/gallery/reorder', isStaffOrAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'Order array is required' });
    }
    
    for (const item of order) {
      if (typeof item.id !== 'number' || typeof item.sortOrder !== 'number') {
        return res.status(400).json({ error: 'Each item must have id and sortOrder as numbers' });
      }
    }
    
    await Promise.all(
      order.map(item =>
        db.update(galleryImages)
          .set({ sortOrder: item.sortOrder })
          .where(eq(galleryImages.id, item.id))
      )
    );
    
    res.json({ success: true, updated: order.length });
  } catch (error: any) {
    logAndRespond(req, res, 500, 'Failed to reorder gallery images', error, 'GALLERY_REORDER_ERROR');
  }
});

export default router;
