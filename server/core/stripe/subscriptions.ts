import { getStripeClient } from './client';
import Stripe from 'stripe';

export interface CreateSubscriptionParams {
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
}

export interface SubscriptionResult {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: Date;
  clientSecret?: string;
}

export async function createSubscription(params: CreateSubscriptionParams): Promise<{
  success: boolean;
  subscription?: SubscriptionResult;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const { customerId, priceId, metadata = {} } = params;
    
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        ...metadata,
        source: 'even_house_app',
      },
    });
    
    const invoice = subscription.latest_invoice as Stripe.Invoice;
    const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent;
    
    console.log(`[Stripe Subscriptions] Created subscription ${subscription.id} for customer ${customerId}`);
    
    return {
      success: true,
      subscription: {
        subscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        clientSecret: paymentIntent?.client_secret || undefined,
      },
    };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error creating subscription:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function cancelSubscription(subscriptionId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    await stripe.subscriptions.cancel(subscriptionId);
    
    console.log(`[Stripe Subscriptions] Canceled subscription ${subscriptionId}`);
    
    return { success: true };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error canceling subscription:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function listCustomerSubscriptions(customerId: string): Promise<{
  success: boolean;
  subscriptions?: Array<{
    id: string;
    status: string;
    priceId: string;
    productId: string;
    productName: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    cancelAt: Date | null;
    isPaused: boolean;
    pausedUntil: Date | null;
    pendingUpdate: {
      newPriceId: string;
      newProductName: string;
      effectiveAt: Date;
    } | null;
  }>;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      expand: [
        'data.items.data.price.product', 
        'data.schedule',
        'data.pending_update.subscription_items.data.price.product'
      ],
    });
    
    return {
      success: true,
      subscriptions: subscriptions.data.map(sub => {
        const item = sub.items.data[0];
        const price = item?.price;
        const productRef = price?.product;
        const product = typeof productRef === 'string' ? null : (productRef as Stripe.Product);
        const productId = product?.id || (typeof productRef === 'string' ? productRef : '');
        const productName = product?.name || '';
        
        let pendingUpdate: { newPriceId: string; newProductName: string; effectiveAt: Date } | null = null;
        if (sub.pending_update?.subscription_items && sub.pending_update.subscription_items.data.length > 0) {
          const pendingItem = sub.pending_update.subscription_items.data[0];
          const pendingPriceRef = pendingItem?.price;
          const pendingPriceId = typeof pendingPriceRef === 'string' 
            ? pendingPriceRef 
            : pendingPriceRef?.id || '';
          const pendingProduct = typeof pendingPriceRef === 'string' 
            ? null 
            : (pendingPriceRef?.product as Stripe.Product | undefined);
          const effectiveTimestamp = (sub.pending_update as any).billing_cycle_anchor 
            || (sub.pending_update as any).expires_at 
            || sub.current_period_end;
            
          if (pendingPriceId && effectiveTimestamp) {
            pendingUpdate = {
              newPriceId: pendingPriceId,
              newProductName: pendingProduct?.name || '',
              effectiveAt: new Date(effectiveTimestamp * 1000),
            };
          }
        }
        
        return {
          id: sub.id,
          status: sub.status,
          priceId: price?.id || '',
          productId,
          productName,
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          isPaused: !!(sub.pause_collection && sub.pause_collection.behavior),
          pausedUntil: sub.pause_collection?.resumes_at ? new Date(sub.pause_collection.resumes_at * 1000) : null,
          pendingUpdate,
        };
      }),
    };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error listing subscriptions:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function getSubscription(subscriptionId: string): Promise<{
  success: boolean;
  subscription?: {
    id: string;
    status: string;
    customerId: string;
    priceId: string;
    productId: string;
    productName: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
  };
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product'],
    });
    
    const item = subscription.items.data[0];
    const price = item?.price;
    const product = price?.product as Stripe.Product;
    
    return {
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        customerId: subscription.customer as string,
        priceId: price?.id || '',
        productId: product?.id || '',
        productName: product?.name || '',
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      },
    };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error getting subscription:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function pauseSubscription(
  subscriptionId: string,
  pauseDurationDays: number,
  resumeAt?: Date
): Promise<{ success: boolean; resumeDate?: Date; error?: string }> {
  try {
    const stripe = await getStripeClient();
    
    const resumeDate = resumeAt || new Date(Date.now() + (pauseDurationDays * 24 * 60 * 60 * 1000));
    
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: {
        behavior: 'mark_uncollectible',
        resumes_at: Math.floor(resumeDate.getTime() / 1000),
      },
    });

    console.log(`[Stripe Subscriptions] Paused subscription ${subscriptionId} until ${resumeDate.toISOString()}`);
    return { success: true, resumeDate };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error pausing subscription:', error);
    return { success: false, error: error.message };
  }
}

export async function resumeSubscription(subscriptionId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();
    
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: null as any,
    });

    console.log(`[Stripe Subscriptions] Resumed subscription ${subscriptionId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error resuming subscription:', error);
    return { success: false, error: error.message };
  }
}

export async function changeSubscriptionTier(
  subscriptionId: string,
  newPriceId: string,
  immediate: boolean = false
): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = sub.items.data[0].id;

    if (immediate) {
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'always_invoice',
      });
      console.log(`[Stripe Subscriptions] Immediately upgraded subscription ${subscriptionId} to price ${newPriceId}`);
    } else {
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'none',
      });
      console.log(`[Stripe Subscriptions] Changed subscription ${subscriptionId} to price ${newPriceId} (next cycle)`);
    }

    return { success: true };
  } catch (error: any) {
    console.error('[Stripe Subscriptions] Error changing tier:', error);
    return { success: false, error: error.message };
  }
}
