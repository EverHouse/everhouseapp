CREATE TABLE IF NOT EXISTS "dismissed_hubspot_meetings" (
  "id" serial PRIMARY KEY NOT NULL,
  "hubspot_meeting_id" varchar NOT NULL UNIQUE,
  "dismissed_by" varchar,
  "dismissed_at" timestamp DEFAULT now() NOT NULL,
  "notes" text
);
