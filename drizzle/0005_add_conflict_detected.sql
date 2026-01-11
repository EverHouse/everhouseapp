-- Add conflict_detected column to events table
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "conflict_detected" BOOLEAN DEFAULT false;

-- Add conflict_detected column to wellness_classes table
ALTER TABLE "wellness_classes" ADD COLUMN IF NOT EXISTS "conflict_detected" BOOLEAN DEFAULT false;
