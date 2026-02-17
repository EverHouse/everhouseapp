import { Router } from 'express';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import { isStaffOrAdmin } from '../../core/middleware';
import { importTrackmanBookings, getImportRuns, rescanUnmatchedBookings } from '../../core/trackmanImport';
import { logFromRequest } from '../../core/auditLog';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../core/logger';

const router = Router();

const uploadDir = path.join(process.cwd(), 'uploads', 'trackman');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    cb(null, `trackman_${timestamp}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

router.get('/api/admin/trackman/import-runs', isStaffOrAdmin, async (req, res) => {
  try {
    const runs = await getImportRuns();
    res.json(runs);
  } catch (error: unknown) {
    logger.error('Error fetching import runs', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: 'Failed to fetch import runs' });
  }
});

router.post('/api/admin/trackman/import', isStaffOrAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    const user = (req as any).session?.user?.email || 'admin';
    
    const safeFilename = path.basename(filename || 'trackman_bookings_1767009308200.csv');
    if (!safeFilename.endsWith('.csv') || !/^[a-zA-Z0-9_\-\.]+$/.test(safeFilename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }
    
    const csvPath = path.join(process.cwd(), 'attached_assets', safeFilename);
    
    const result = await importTrackmanBookings(csvPath, user);
    
    logFromRequest(req, 'import_trackman', 'trackman', undefined, 'Trackman CSV Import', {
      filename: safeFilename,
      bookingsImported: (result as any).bookingsCreated || 0,
      sessionsCreated: (result as any).sessionsCreated || 0
    });
    
    res.json({
      success: true,
      ...result
    });
  } catch (error: unknown) {
    logger.error('Import error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to import bookings' });
  }
});

router.post('/api/admin/trackman/upload', isStaffOrAdmin, upload.single('file'), async (req, res) => {
  let csvPath: string | undefined;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const user = (req as any).session?.user?.email || 'admin';
    csvPath = req.file.path;
    
    const result = await importTrackmanBookings(csvPath, user);
    
    res.json({
      success: true,
      filename: req.file.filename,
      ...result
    });
  } catch (error: unknown) {
    logger.error('Upload/Import error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to upload and import bookings' });
  } finally {
    if (csvPath && fs.existsSync(csvPath)) {
      try {
        fs.unlinkSync(csvPath);
      } catch (cleanupErr) {
        logger.error('Failed to cleanup uploaded file', { extra: { error: cleanupErr } });
      }
    }
  }
});

router.post('/api/admin/trackman/rescan', isStaffOrAdmin, async (req, res) => {
  try {
    const user = (req as any).session?.user?.email || 'admin';
    const result = await rescanUnmatchedBookings(user);
    
    await logFromRequest(req, {
      action: 'trackman_rescan' as any,
      resourceType: 'trackman_booking',
      resourceName: 'Unmatched Bookings Rescan',
      details: { matched: result.matched, lessonsConverted: result.lessonsConverted, scanned: result.scanned }
    });
    
    // Build message based on what happened
    const parts: string[] = [];
    if (result.matched > 0) parts.push(`Matched ${result.matched} booking(s) to members`);
    if (result.lessonsConverted > 0) parts.push(`Converted ${result.lessonsConverted} lesson(s) to availability blocks`);
    const message = parts.length > 0 ? parts.join('. ') : 'No new matches or lessons found';
    
    res.json({
      success: true,
      message,
      ...result
    });
  } catch (error: unknown) {
    logger.error('Rescan error', { error: error instanceof Error ? error : new Error(String(error)) });
    res.status(500).json({ error: getErrorMessage(error) || 'Failed to rescan unmatched bookings' });
  }
});

export default router;
