-- Failed side effects table for tracking and retrying cancellation failures
CREATE TABLE IF NOT EXISTS "failed_side_effects" (
  "id" serial PRIMARY KEY NOT NULL,
  "booking_id" integer NOT NULL,
  "action_type" varchar(64) NOT NULL,
  "stripe_payment_intent_id" varchar,
  "error_message" text NOT NULL,
  "context" jsonb,
  "resolved" boolean DEFAULT false NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" varchar,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_failed_side_effects_booking_id" ON "failed_side_effects" ("booking_id");
CREATE INDEX IF NOT EXISTS "idx_failed_side_effects_resolved" ON "failed_side_effects" ("resolved");
