import { logger } from '../core/logger';
import { Router } from 'express';
import { db } from '../db';
import { trainingSections } from '../../shared/schema';
import { eq, asc, max } from 'drizzle-orm';
import { isStaffOrAdmin, isAdmin } from '../core/middleware';
import { getSessionUser } from '../types/session';
import { logFromRequest } from '../core/auditLog';
import { TRAINING_SEED_DATA } from '../data/trainingSeedData';

const router = Router();

interface _TrainingStep {
  title: string;
  content: string;
  imageUrl?: string;
  pageIcon?: string;
}

// Function to seed training sections with upsert logic (exported for use in startup)
// Updates existing guides by guideId, inserts new ones, preserves custom guides
// Also handles migration of old records without guideIds by matching title
export async function seedTrainingSections() {
  const existing = await db.select().from(trainingSections);
  
  // Build maps for matching: by guideId (preferred) and by title (fallback for migration)
  const existingByGuideId = new Map(
    existing.filter(s => s.guideId).map(s => [s.guideId, s])
  );
  const existingByTitle = new Map(
    existing.filter(s => !s.guideId).map(s => [s.title, s])
  );
  
  let updated = 0;
  let inserted = 0;
  let migrated = 0;
  
  for (const seedData of TRAINING_SEED_DATA) {
    // First try to find by guideId
    let existingSection = existingByGuideId.get(seedData.guideId);
    
    // Fallback: if no guideId match, try matching by title (for migration)
    if (!existingSection) {
      existingSection = existingByTitle.get(seedData.title);
    }
    
    if (existingSection) {
      // Check if we need to add guideId (migration case)
      const needsGuideId = !existingSection.guideId;
      
      // Check if content differs
      const needsContentUpdate = 
        existingSection.icon !== seedData.icon ||
        existingSection.title !== seedData.title ||
        existingSection.description !== seedData.description ||
        existingSection.sortOrder !== seedData.sortOrder ||
        existingSection.isAdminOnly !== seedData.isAdminOnly ||
        JSON.stringify(existingSection.steps) !== JSON.stringify(seedData.steps);
      
      if (needsGuideId || needsContentUpdate) {
        await db.update(trainingSections)
          .set({
            guideId: seedData.guideId,
            icon: seedData.icon,
            title: seedData.title,
            description: seedData.description,
            steps: seedData.steps,
            sortOrder: seedData.sortOrder,
            isAdminOnly: seedData.isAdminOnly,
            updatedAt: new Date(),
          })
          .where(eq(trainingSections.id, existingSection.id));
        if (needsGuideId) migrated++;
        else updated++;
      }
    } else {
      // Insert new section
      await db.insert(trainingSections).values(seedData);
      inserted++;
    }
  }
  
  logger.info('[Training] Seed complete: updated, inserted, migrated', { extra: { updated, inserted, migrated } });
}

router.get('/api/training-sections', isStaffOrAdmin, async (req, res) => {
  try {
    const userRole = getSessionUser(req)?.role;
    const isAdminUser = userRole === 'admin';
    
    let result;
    if (isAdminUser) {
      result = await db.select().from(trainingSections)
        .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    } else {
      result = await db.select().from(trainingSections)
        .where(eq(trainingSections.isAdminOnly, false))
        .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    }
    
    if (result.length === 0) {
      logger.info('[Training] No sections found, auto-seeding...');
      try {
        await seedTrainingSections();
        if (isAdminUser) {
          result = await db.select().from(trainingSections)
            .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
        } else {
          result = await db.select().from(trainingSections)
            .where(eq(trainingSections.isAdminOnly, false))
            .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
        }
        logger.info('[Training] Auto-seeded sections', { extra: { resultLength: result.length } });
      } catch (seedError) {
        logger.error('[Training] Auto-seed failed', { extra: { seedError } });
      }
    }
    
    const [{ lastUpdated }] = await db
      .select({ lastUpdated: max(trainingSections.updatedAt) })
      .from(trainingSections);
    
    res.json({ sections: result, lastUpdated: lastUpdated?.toISOString() ?? null });
  } catch (error: unknown) {
    logger.error('Training sections fetch error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch training sections' });
  }
});

router.post('/api/admin/training-sections', isAdmin, async (req, res) => {
  try {
    const { icon, title, description, steps, isAdminOnly, sortOrder } = req.body;
    
    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }
    
    const [newSection] = await db.insert(trainingSections).values({
      icon: icon || 'help_outline',
      title,
      description,
      steps: steps || [],
      isAdminOnly: isAdminOnly ?? false,
      sortOrder: sortOrder ?? 0,
    }).returning();
    
    logFromRequest(req, 'create_training', 'training', String(newSection.id), newSection.title, {});
    res.status(201).json(newSection);
  } catch (error: unknown) {
    logger.error('Training section creation error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to create training section' });
  }
});

router.put('/api/admin/training-sections/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const sectionId = parseInt(id as string, 10);
    if (isNaN(sectionId)) return res.status(400).json({ error: 'Invalid section ID' });
    const { icon, title, description, steps, isAdminOnly, sortOrder } = req.body;
    
    const [updated] = await db.update(trainingSections)
      .set({
        ...(icon !== undefined && { icon }),
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(steps !== undefined && { steps }),
        ...(isAdminOnly !== undefined && { isAdminOnly }),
        ...(sortOrder !== undefined && { sortOrder }),
        updatedAt: new Date(),
      })
      .where(eq(trainingSections.id, sectionId))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'Training section not found' });
    }
    
    logFromRequest(req, 'update_training', 'training', String(id), title, {});
    res.json(updated);
  } catch (error: unknown) {
    logger.error('Training section update error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to update training section' });
  }
});

router.delete('/api/admin/training-sections/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const sectionId = parseInt(id as string, 10);
    if (isNaN(sectionId)) return res.status(400).json({ error: 'Invalid section ID' });
    
    const [deleted] = await db.delete(trainingSections)
      .where(eq(trainingSections.id, sectionId))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'Training section not found' });
    }
    
    logFromRequest(req, 'delete_training', 'training', String(id), undefined, {});
    res.json({ success: true, deleted });
  } catch (error: unknown) {
    logger.error('Training section deletion error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to delete training section' });
  }
});

// Seed training content (uses shared TRAINING_SEED_DATA constant)
router.post('/api/admin/training-sections/seed', isAdmin, async (req, res) => {
  try {
    await seedTrainingSections();
    
    const insertedSections = await db.select().from(trainingSections)
      .orderBy(asc(trainingSections.sortOrder), asc(trainingSections.id));
    
    logFromRequest(req, 'seed_training', 'training', undefined, 'Training Seed', {});
    res.status(201).json({ 
      success: true, 
      message: `Seeded ${insertedSections.length} training sections`,
      sections: insertedSections 
    });
  } catch (error: unknown) {
    logger.error('Training seed error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to seed training sections' });
  }
});

export default router;
