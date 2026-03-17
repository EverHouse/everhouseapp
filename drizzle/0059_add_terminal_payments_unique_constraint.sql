DELETE FROM terminal_payments a
  USING terminal_payments b
  WHERE a.id < b.id
    AND a.stripe_payment_intent_id = b.stripe_payment_intent_id;

CREATE UNIQUE INDEX IF NOT EXISTS "terminal_payments_stripe_pi_unique" ON "terminal_payments" USING btree ("stripe_payment_intent_id");
