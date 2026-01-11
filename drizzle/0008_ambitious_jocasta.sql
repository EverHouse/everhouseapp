CREATE TABLE "integrity_ignores" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_key" text NOT NULL,
	"ignored_by" text NOT NULL,
	"ignored_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"reason" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "integrity_ignores_issue_key_unique" UNIQUE("issue_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "integrity_ignores_issue_key_idx" ON "integrity_ignores" USING btree ("issue_key");