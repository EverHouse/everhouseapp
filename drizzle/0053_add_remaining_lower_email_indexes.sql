-- Add remaining LOWER(email) functional indexes missed in migration 0052
-- These tables are queried with LOWER() in admin-actions, user merge, and visitor cleanup

-- bug_reports.user_email — queried in user merge + admin delete
CREATE INDEX IF NOT EXISTS "idx_bug_reports_lower_user_email" ON "bug_reports" (LOWER("user_email"));

-- data_export_requests.user_email — queried in user merge + admin delete
CREATE INDEX IF NOT EXISTS "idx_data_export_requests_lower_user_email" ON "data_export_requests" (LOWER("user_email"));

-- email_events.recipient_email — queried in admin delete + visitor cleanup
CREATE INDEX IF NOT EXISTS "idx_email_events_lower_recipient_email" ON "email_events" (LOWER("recipient_email"));

-- guest_pass_holds.member_email — queried in integrity checks + subscription delete + admin delete
CREATE INDEX IF NOT EXISTS "idx_guest_pass_holds_lower_member_email" ON "guest_pass_holds" (LOWER("member_email"));

-- magic_links.email — queried in admin delete + visitor cleanup
CREATE INDEX IF NOT EXISTS "idx_magic_links_lower_email" ON "magic_links" (LOWER("email"));

-- tours.guest_email — queried in admin delete + visitor cleanup
CREATE INDEX IF NOT EXISTS "idx_tours_lower_guest_email" ON "tours" (LOWER("guest_email"));
