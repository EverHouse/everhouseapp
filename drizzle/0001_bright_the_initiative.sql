CREATE TABLE "booking_guests" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"guest_name" varchar,
	"guest_email" varchar,
	"slot_number" integer NOT NULL,
	"trackman_booking_id" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "booking_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"user_email" varchar,
	"slot_number" integer NOT NULL,
	"is_primary" boolean DEFAULT false,
	"trackman_booking_id" varchar,
	"linked_at" timestamp,
	"linked_by" varchar,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "closure_reasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(255) NOT NULL,
	"sort_order" integer DEFAULT 100,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "closure_reasons_label_unique" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "wellness_classes" ADD COLUMN "waitlist_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "wellness_enrollments" ADD COLUMN "is_waitlisted" boolean DEFAULT false;--> statement-breakpoint
CREATE INDEX "booking_guests_booking_id_idx" ON "booking_guests" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_members_booking_id_idx" ON "booking_members" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_members_user_email_idx" ON "booking_members" USING btree ("user_email");