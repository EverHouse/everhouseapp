import type { Express } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { ObjectStorageService, ObjectNotFoundError, objectStorageClient } from "./objectStorage";
import { getSessionUser } from "../../types/session";
import { logger } from "../../core/logger";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/**
 * Register object storage routes for file uploads.
 *
 * This provides example routes for the presigned URL upload flow:
 * 1. POST /api/uploads/request-url - Get a presigned URL for uploading
 * 2. The client then uploads directly to the presigned URL
 *
 * IMPORTANT: These are example routes. Customize based on your use case:
 * - Add authentication middleware for protected uploads
 * - Add file metadata storage (save to database after upload)
 * - Add ACL policies for access control
 */
export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  /**
   * Direct file upload endpoint for bug reports and other simple uploads.
   * Handles multipart form data with a 'file' field and optional 'folder' field.
   * Requires authentication and validates folder names to prevent path traversal.
   */
  app.post("/api/object-storage/upload", upload.single('file'), async (req, res) => {
    try {
      // Check authentication
      const user = getSessionUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Validate and sanitize folder name to prevent path traversal
      const allowedFolders = ['uploads', 'bug-reports', 'images'];
      let folder = (req.body.folder as string) || 'uploads';
      folder = folder.replace(/[^a-zA-Z0-9-_]/g, ''); // Remove any special characters
      if (!allowedFolders.includes(folder)) {
        folder = 'uploads';
      }

      const fileId = randomUUID();
      const ext = (req.file.originalname.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '');
      const objectName = `${folder}/${fileId}.${ext}`;
      
      const privateObjectDir = objectStorageService.getPrivateObjectDir();
      const fullPath = `${privateObjectDir}/${objectName}`;
      
      // Parse the bucket name from the path
      const pathParts = fullPath.startsWith('/') ? fullPath.slice(1).split('/') : fullPath.split('/');
      const bucketName = pathParts[0];
      const objectPath = pathParts.slice(1).join('/');
      
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectPath);
      
      await file.save(req.file.buffer, {
        contentType: req.file.mimetype,
        metadata: {
          originalName: req.file.originalname,
          uploadedBy: user.email,
        },
      });
      
      // Return the public URL path
      const url = `/objects/${objectName}`;
      
      res.json({ url, objectPath: url });
    } catch (error) {
      logger.error("Error uploading file:", { error: error as Error });
      res.status(500).json({ error: "Failed to upload file" });
    }
  });

  /**
   * Request a presigned URL for file upload.
   *
   * Request body (JSON):
   * {
   *   "name": "filename.jpg",
   *   "size": 12345,
   *   "contentType": "image/jpeg"
   * }
   *
   * Response:
   * {
   *   "uploadURL": "https://storage.googleapis.com/...",
   *   "objectPath": "/objects/uploads/uuid"
   * }
   *
   * IMPORTANT: The client should NOT send the file to this endpoint.
   * Send JSON metadata only, then upload the file directly to uploadURL.
   */
  app.post("/api/uploads/request-url", async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({
          error: "Missing required field: name",
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();

      // Extract object path from the presigned URL for later reference
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadURL,
        objectPath,
        // Echo back the metadata for client convenience
        metadata: { name, size, contentType },
      });
    } catch (error) {
      logger.error("Error generating upload URL:", { error: error as Error });
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  /**
   * Serve uploaded objects.
   *
   * This serves files from object storage. For public files, no auth needed.
   * For protected files, add authentication middleware and ACL checks.
   * Uses middleware pattern for Express 5 compatibility.
   */
  app.use("/objects", async (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path.startsWith('/objects') ? req.path : `/objects${req.path}`);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      logger.error("Error serving object:", { error: error as Error });
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      return res.status(500).json({ error: "Failed to serve object" });
    }
  });
}

