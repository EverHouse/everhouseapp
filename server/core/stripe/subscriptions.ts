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
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  }>;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      expand: ['data.items.data.price'],
    });
    
    return {
      success: true,
      subscriptions: subscriptions.data.map(sub => {
        const item = sub.items.data[0];
        const price = item?.price;
        const productRef = price?.product;
        const productId = typeof productRef === 'string' ? productRef : (productRef as Stripe.Product)?.id || '';
        
        return {
          id: sub.id,
          status: sub.status,
          priceId: price?.id || '',
          productId,
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
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
