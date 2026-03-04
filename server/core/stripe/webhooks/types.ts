import Stripe from 'stripe';

export type DeferredAction = () => Promise<void>;

export type StripeProductWithMarketingFeatures = Stripe.Product & {
  marketing_features?: Array<{ name: string }>;
};

export type InvoiceWithLegacyFields = Stripe.Invoice & {
  payment_intent?: string | Stripe.PaymentIntent | null;
  subscription?: string | Stripe.Subscription | null;
};

export interface SubscriptionPreviousAttributes {
  items?: { data: Array<{ id: string; metadata?: Record<string, string> }> };
  status?: string;
  cancel_at_period_end?: boolean;
  [key: string]: unknown;
}

export interface WebhookProcessingResult {
  processed: boolean;
  reason?: 'duplicate' | 'out_of_order' | 'error';
  deferredActions: DeferredAction[];
}

export interface StripeEventObject {
  id?: string;
  customer?: string;
  subscription?: string;
  invoice?: string;
  payment_intent?: string;
  [key: string]: unknown;
}

export interface CacheTransactionParams {
  stripeId: string;
  objectType: 'payment_intent' | 'charge' | 'invoice' | 'refund';
  amountCents: number;
  currency?: string;
  status: string;
  createdAt: Date;
  customerId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  description?: string | null;
  metadata?: Record<string, string> | null;
  source?: 'webhook' | 'backfill';
  paymentIntentId?: string | null;
  chargeId?: string | null;
  invoiceId?: string | null;
}
