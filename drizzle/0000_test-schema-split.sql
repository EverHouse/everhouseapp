CREATE TABLE "magic_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"token" varchar NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar NOT NULL,
	"name" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"phone" varchar,
	"job_title" varchar,
	"password_hash" varchar,
	"role" varchar DEFAULT 'staff',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"created_by" varchar,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"role" varchar DEFAULT 'member',
	"tier" varchar,
	"tier_id" integer,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"phone" varchar,
	"mindbody_client_id" varchar,
	"lifetime_visits" integer DEFAULT 0,
	"linked_emails" jsonb DEFAULT '[]'::jsonb,
	"manually_linked_emails" jsonb DEFAULT '[]'::jsonb,
	"data_source" varchar,
	"hubspot_id" varchar,
	"membership_status" varchar DEFAULT 'active',
	"last_synced_at" timestamp,
	"join_date" date,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "communication_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"type" varchar NOT NULL,
	"direction" varchar,
	"subject" varchar,
	"body" text,
	"status" varchar,
	"hubspot_engagement_id" varchar,
	"hubspot_synced_at" timestamp,
	"logged_by" varchar,
	"logged_by_name" varchar,
	"occurred_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "guest_check_ins" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"guest_name" varchar NOT NULL,
	"guest_email" varchar,
	"guest_phone" varchar,
	"check_in_date" date NOT NULL,
	"check_in_time" time,
	"notes" text,
	"checked_in_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "guest_passes" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"passes_used" integer DEFAULT 0 NOT NULL,
	"passes_total" integer DEFAULT 4 NOT NULL,
	"last_reset_date" date,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "member_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_email" varchar NOT NULL,
	"content" text NOT NULL,
	"created_by" varchar NOT NULL,
	"created_by_name" varchar,
	"is_pinned" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "membership_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"price_string" varchar NOT NULL,
	"description" text,
	"button_text" varchar DEFAULT 'Apply Now',
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"is_popular" boolean DEFAULT false,
	"show_in_comparison" boolean DEFAULT true,
	"highlighted_features" jsonb DEFAULT '[]'::jsonb,
	"all_features" jsonb DEFAULT '{}'::jsonb,
	"daily_sim_minutes" integer DEFAULT 0,
	"guest_passes_per_month" integer DEFAULT 0,
	"booking_window_days" integer DEFAULT 7,
	"daily_conf_room_minutes" integer DEFAULT 0,
	"can_book_simulators" boolean DEFAULT false,
	"can_book_conference" boolean DEFAULT false,
	"can_book_wellness" boolean DEFAULT true,
	"has_group_lessons" boolean DEFAULT false,
	"has_extended_sessions" boolean DEFAULT false,
	"has_private_lesson" boolean DEFAULT false,
	"has_simulator_guest_passes" boolean DEFAULT false,
	"has_discounted_merch" boolean DEFAULT false,
	"unlimited_access" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "membership_tiers_name_unique" UNIQUE("name"),
	CONSTRAINT "membership_tiers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "availability_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"resource_id" integer,
	"block_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"block_type" varchar NOT NULL,
	"notes" text,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"closure_id" integer,
	"event_id" integer,
	"wellness_class_id" integer
);
--> statement-breakpoint
CREATE TABLE "booking_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar NOT NULL,
	"user_name" varchar,
	"resource_id" integer,
	"resource_preference" varchar,
	"request_date" date NOT NULL,
	"start_time" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"end_time" time NOT NULL,
	"notes" text,
	"status" varchar DEFAULT 'pending',
	"staff_notes" text,
	"suggested_time" time,
	"reviewed_by" varchar,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"calendar_event_id" varchar,
	"reschedule_booking_id" integer,
	"trackman_booking_id" varchar,
	"original_booked_date" timestamp,
	"guest_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "facility_closures" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar NOT NULL,
	"reason" text,
	"notice_type" varchar,
	"start_date" date NOT NULL,
	"start_time" time,
	"end_date" date NOT NULL,
	"end_time" time,
	"affected_areas" varchar,
	"notify_members" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"needs_review" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"created_by" varchar,
	"google_calendar_id" varchar,
	"conference_calendar_id" varchar,
	"internal_calendar_id" varchar
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"type" varchar NOT NULL,
	"description" text,
	"capacity" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tours" (
	"id" serial PRIMARY KEY NOT NULL,
	"google_calendar_id" varchar,
	"title" varchar NOT NULL,
	"guest_name" varchar,
	"guest_email" varchar,
	"guest_phone" varchar,
	"tour_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time,
	"notes" text,
	"status" varchar DEFAULT 'scheduled',
	"checked_in_at" timestamp,
	"checked_in_by" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "tours_google_calendar_id_unique" UNIQUE("google_calendar_id")
);
--> statement-breakpoint
CREATE TABLE "trackman_import_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" varchar NOT NULL,
	"total_rows" integer NOT NULL,
	"matched_rows" integer NOT NULL,
	"unmatched_rows" integer NOT NULL,
	"skipped_rows" integer NOT NULL,
	"imported_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trackman_unmatched_bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"trackman_booking_id" varchar NOT NULL,
	"user_name" varchar,
	"original_email" varchar,
	"booking_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"duration_minutes" integer,
	"status" varchar,
	"bay_number" varchar,
	"player_count" integer,
	"notes" text,
	"match_attempt_reason" text,
	"resolved_email" varchar,
	"resolved_at" timestamp,
	"resolved_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar NOT NULL,
	"message" text NOT NULL,
	"priority" varchar DEFAULT 'normal',
	"is_active" boolean DEFAULT true,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"closure_id" integer,
	"link_type" varchar,
	"link_target" varchar,
	"created_at" timestamp DEFAULT now(),
	"created_by" varchar
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar NOT NULL,
	"user_name" varchar,
	"user_role" varchar,
	"description" text NOT NULL,
	"screenshot_url" text,
	"page_url" varchar,
	"user_agent" text,
	"status" varchar DEFAULT 'open',
	"resolved_by" varchar,
	"resolved_at" timestamp,
	"staff_notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cafe_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" varchar NOT NULL,
	"name" varchar NOT NULL,
	"price" numeric DEFAULT '0' NOT NULL,
	"description" text,
	"icon" varchar,
	"image_url" text,
	"is_active" boolean DEFAULT true,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "event_rsvps" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer,
	"user_email" varchar NOT NULL,
	"status" varchar DEFAULT 'confirmed',
	"source" varchar DEFAULT 'local',
	"eventbrite_attendee_id" varchar,
	"matched_user_id" varchar,
	"attendee_name" varchar,
	"ticket_class" varchar,
	"checked_in" boolean DEFAULT false,
	"guest_count" integer DEFAULT 0,
	"order_date" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar NOT NULL,
	"description" text,
	"event_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time,
	"location" varchar,
	"category" varchar,
	"image_url" text,
	"max_attendees" integer,
	"created_at" timestamp DEFAULT now(),
	"eventbrite_id" varchar,
	"eventbrite_url" text,
	"external_url" text,
	"source" varchar DEFAULT 'manual',
	"visibility" varchar DEFAULT 'public',
	"google_calendar_id" varchar,
	"requires_rsvp" boolean DEFAULT false,
	"locally_edited" boolean DEFAULT false,
	"google_event_etag" varchar,
	"google_event_updated_at" timestamp,
	"app_last_modified_at" timestamp,
	"last_synced_at" timestamp,
	"block_bookings" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "faqs" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"category" varchar,
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_type" varchar NOT NULL,
	"first_name" varchar,
	"last_name" varchar,
	"email" varchar NOT NULL,
	"phone" varchar,
	"message" text,
	"metadata" jsonb,
	"status" varchar DEFAULT 'new',
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "gallery_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar,
	"description" text,
	"image_url" text NOT NULL,
	"category" varchar,
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wellness_classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar NOT NULL,
	"time" varchar NOT NULL,
	"instructor" varchar NOT NULL,
	"duration" varchar NOT NULL,
	"category" varchar NOT NULL,
	"spots" varchar NOT NULL,
	"status" varchar,
	"description" text,
	"date" date NOT NULL,
	"is_active" boolean DEFAULT true,
	"google_calendar_id" varchar,
	"image_url" text,
	"external_url" text,
	"visibility" varchar DEFAULT 'public',
	"locally_edited" boolean DEFAULT false,
	"google_event_etag" varchar,
	"google_event_updated_at" timestamp,
	"app_last_modified_at" timestamp,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"block_bookings" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "wellness_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"class_id" integer,
	"user_email" varchar NOT NULL,
	"status" varchar DEFAULT 'confirmed',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notice_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"is_preset" boolean DEFAULT false,
	"sort_order" integer DEFAULT 100,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "notice_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar NOT NULL,
	"title" varchar NOT NULL,
	"message" text NOT NULL,
	"type" varchar DEFAULT 'info',
	"related_id" integer,
	"related_type" varchar,
	"is_read" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_dismissed_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_email" varchar NOT NULL,
	"notice_type" varchar NOT NULL,
	"notice_id" integer NOT NULL,
	"dismissed_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar PRIMARY KEY NOT NULL,
	"value" varchar,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "training_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"guide_id" varchar,
	"icon" varchar NOT NULL,
	"title" varchar NOT NULL,
	"description" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_admin_only" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "training_sections_guide_id_unique" UNIQUE("guide_id")
);
--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rsvps" ADD CONSTRAINT "event_rsvps_matched_user_id_users_id_fk" FOREIGN KEY ("matched_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_blocks_resource_unique_idx" ON "availability_blocks" USING btree ("resource_id","block_date","start_time","end_time","closure_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_requests_trackman_id_idx" ON "booking_requests" USING btree ("trackman_booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_user_notice" ON "user_dismissed_notices" USING btree ("user_email","notice_type","notice_id");