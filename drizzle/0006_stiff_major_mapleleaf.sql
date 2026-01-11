CREATE TABLE "dismissed_hubspot_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"hubspot_meeting_id" varchar NOT NULL,
	"dismissed_by" varchar,
	"dismissed_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "dismissed_hubspot_meetings_hubspot_meeting_id_unique" UNIQUE("hubspot_meeting_id")
);
--> statement-breakpoint
CREATE TABLE "integrity_check_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"total_issues" integer DEFAULT 0 NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"high_count" integer DEFAULT 0 NOT NULL,
	"medium_count" integer DEFAULT 0 NOT NULL,
	"low_count" integer DEFAULT 0 NOT NULL,
	"results_json" jsonb,
	"triggered_by" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrity_issues_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_key" text NOT NULL,
	"first_detected_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"check_name" text NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "integrity_issues_tracking_issue_key_unique" UNIQUE("issue_key")
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "needs_review" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "reviewed_by" varchar;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "review_dismissed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "conflict_detected" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "needs_review" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "reviewed_by" varchar;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "review_dismissed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "conflict_detected" boolean DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_issues_tracking_issue_key_idx" ON "integrity_issues_tracking" USING btree ("issue_key");