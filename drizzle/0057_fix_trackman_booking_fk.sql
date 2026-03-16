-- Clean up orphaned matched_booking_id references (FK managed by db-init.ts)
UPDATE "trackman_webhook_events" SET "matched_booking_id" = NULL
WHERE "matched_booking_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "booking_requests" WHERE "id" = "trackman_webhook_events"."matched_booking_id");
