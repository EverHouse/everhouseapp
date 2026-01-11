CREATE TABLE "integrity_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_key" text NOT NULL,
	"action" text NOT NULL,
	"action_by" text NOT NULL,
	"action_at" timestamp DEFAULT now() NOT NULL,
	"resolution_method" text,
	"notes" text
);
