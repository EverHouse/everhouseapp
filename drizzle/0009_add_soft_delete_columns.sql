-- Add soft delete columns for archiving instead of permanent deletion
-- This allows records to be recovered and maintains audit trail

-- Add archived columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_by VARCHAR(255);

-- Add archived columns to booking_requests table  
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS archived_by VARCHAR(255);

-- Add archived columns to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_by VARCHAR(255);

-- Add archived columns to wellness_classes table
ALTER TABLE wellness_classes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE wellness_classes ADD COLUMN IF NOT EXISTS archived_by VARCHAR(255);

-- Create indexes for efficient filtering of non-archived records
CREATE INDEX IF NOT EXISTS idx_users_archived_at ON users(archived_at);
CREATE INDEX IF NOT EXISTS idx_booking_requests_archived_at ON booking_requests(archived_at);
CREATE INDEX IF NOT EXISTS idx_events_archived_at ON events(archived_at);
CREATE INDEX IF NOT EXISTS idx_wellness_classes_archived_at ON wellness_classes(archived_at);
