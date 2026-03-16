-- Clean up orphaned matched_booking_id references before adding FK constraint
UPDATE "trackman_webhook_events" SET "matched_booking_id" = NULL
WHERE "matched_booking_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "booking_requests" WHERE "id" = "trackman_webhook_events"."matched_booking_id");
--> statement-breakpoint
ALTER TABLE "trackman_webhook_events" DROP CONSTRAINT IF EXISTS "trackman_webhook_events_matched_booking_id_booking_requests_id_";
--> statement-breakpoint
ALTER TABLE "trackman_webhook_events" ADD CONSTRAINT "trackman_webhook_events_matched_booking_id_booking_requests_id_" FOREIGN KEY ("matched_booking_id") REFERENCES "public"."booking_requests"("id") ON DELETE set null ON UPDATE no action;
