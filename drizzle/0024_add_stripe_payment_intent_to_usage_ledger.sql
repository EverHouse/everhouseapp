-- Add stripe_payment_intent_id column to usage_ledger for audit trail linking
ALTER TABLE "usage_ledger" ADD COLUMN "stripe_payment_intent_id" varchar;

-- Create index for efficient lookup by payment intent
CREATE INDEX "usage_ledger_stripe_payment_intent_idx" ON "usage_ledger" ("stripe_payment_intent_id");
