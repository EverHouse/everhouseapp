-- Add new values to trackman_webhook_event_type enum
ALTER TYPE "public"."trackman_webhook_event_type" ADD VALUE IF NOT EXISTS 'booking.created';
ALTER TYPE "public"."trackman_webhook_event_type" ADD VALUE IF NOT EXISTS 'booking.updated';
ALTER TYPE "public"."trackman_webhook_event_type" ADD VALUE IF NOT EXISTS 'booking.cancelled';
ALTER TYPE "public"."trackman_webhook_event_type" ADD VALUE IF NOT EXISTS 'booking.deleted';
