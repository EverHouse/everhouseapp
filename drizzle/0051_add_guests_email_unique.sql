-- Add unique constraint on guests.email for ON CONFLICT upsert support
-- Drop existing non-unique index first
DROP INDEX IF EXISTS "guests_email_idx";
-- Add unique constraint (NULLs are treated as distinct by PostgreSQL)
ALTER TABLE "guests" ADD CONSTRAINT "guests_email_unique" UNIQUE ("email");
