import { getStripeClient } from './client';
import Stripe from 'stripe';
import { isExpandedProduct, SubscriptionPendingUpdate } from '../../types/stripe-helpers';
import { getErrorMessage, isStripeError } from '../../utils/errorUtils';

import { logger } from '../logger';

interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  current_period_start: number;
  current_period_end: number;
}
export interface CreateSubscriptionParams {
  customerId: string;
  priceId: string;
  metadata?: Record<string, string>;
  couponId?: string;
}

export interface SubscriptionResult {
  subscriptionId: string;
  status: string;
  currentPeriodEnd: Date;
  clientSecret?: string;
  amountDue?: number;
}

export async function createSubscription(params: CreateSubscriptionParams): Promise<{
  success: boolean;
  subscription?: SubscriptionResult;
  error?: string;
}> {
  try {
    const stripe = await getStripeClient();
    const { customerId, priceId, metadata = {}, couponId } = params;
    
    const subscriptionParams: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'],
      },
      expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
      metadata: {
        ...metadata,
        source: 'even_house_app',
      },
    };
    
    if (couponId) {
      subscriptionParams.discounts = [{ coupon: couponId }];
      logger.info(`[Stripe Subscriptions] Applying coupon ${couponId} to subscription`);
    }
    
    const subscription = await stripe.subscriptions.create(subscriptionParams, {
      idempotencyKey: `sub_create_${customerId}_${priceId}_${couponId || 'none'}_${Date.now()}`
    });
    
    const invoice = subscription.latest_invoice as Stripe.Invoice;
    let paymentIntent = (invoice as unknown as Record<string, unknown>)?.payment_intent as Stripe.PaymentIntent | null;
    const pendingSetupIntent = subscription.pending_setup_intent as Stripe.SetupIntent | null;
    
    logger.info(`[Stripe Subscriptions] Created subscription ${subscription.id} for customer ${customerId}`);
    logger.info(`[Stripe Subscriptions] Invoice status: ${invoice?.status}, Invoice ID: ${invoice?.id}`);
    logger.info(`[Stripe Subscriptions] Initial payment intent: ${paymentIntent?.id || 'none'}, Setup intent: ${pendingSetupIntent?.id || 'none'}`);
    
    if (paymentIntent?.id) {
      try {
        const piMetadata: Record<string, string> = {
          ...paymentIntent.metadata,
          invoice_id: invoice?.id || '',
          subscription_id: subscription.id,
          subscriptionId: subscription.id,
          source: 'membership_invoice_payment',
        };
        if (metadata?.userId) piMetadata.userId = metadata.userId;
        if (metadata?.memberEmail) piMetadata.email = metadata.memberEmail;
        
        await stripe.paymentIntents.update(paymentIntent.id, { metadata: piMetadata });
        logger.info(`[Stripe Subscriptions] Updated invoice PI ${paymentIntent.id} with membership metadata`);
      } catch (metaErr: unknown) {
        logger.error(`[Stripe Subscriptions] Failed to update PI metadata:`, { extra: { detail: getErrorMessage(metaErr) } });
      }
    }
    
    if (!paymentIntent && invoice && invoice.amount_due > 0) {
      logger.info(`[Stripe Subscriptions] No payment intent found, creating one for invoice amount: ${invoice.amount_due}`);
      
      try {
        const tierDesc = metadata?.tierName ? ` - ${metadata.tierName}` : '';
        const newPaymentIntent = await stripe.paymentIntents.create({
          amount: invoice.amount_due,
          currency: invoice.currency || 'usd',
          customer: customerId,
          description: `Membership activation${tierDesc}`,
          setup_future_usage: 'off_session',
          metadata: {
            invoice_id: invoice.id,
            subscription_id: subscription.id,
            subscriptionId: subscription.id,
            source: 'membership_inline_payment',
            ...(metadata?.userId ? { userId: metadata.userId } : {}),
            ...(metadata?.memberEmail ? { email: metadata.memberEmail } : {}),
          },
        }, {
          idempotencyKey: `sub_pi_${subscription.id}_${invoice.id}_${invoice.amount_due}`
        });
        
        paymentIntent = newPaymentIntent;
        logger.info(`[Stripe Subscriptions] Created PaymentIntent ${newPaymentIntent.id} for invoice ${invoice.id}`);
      } catch (piError: unknown) {
        logger.error(`[Stripe Subscriptions] Failed to create PaymentIntent:`, { extra: { detail: getErrorMessage(piError) } });
      }
    }
    
    const invoiceAmountDue = invoice?.amount_due ?? 0;
    
    let clientSecret: string | undefined;
    if (invoiceAmountDue > 0) {
      clientSecret = paymentIntent?.client_secret || pendingSetupIntent?.client_secret || undefined;
    } else {
      logger.info(`[Stripe Subscriptions] Invoice amount is $0 — skipping clientSecret (no payment needed)`);
    }
    
    logger.info(`[Stripe Subscriptions] Final: clientSecret=${!!clientSecret}, amountDue=${invoiceAmountDue}`);
    
    return {
      success: true,
      subscription: {
        subscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: new Date((subscription as unknown as StripeSubscriptionWithPeriods).current_period_end * 1000),
        clientSecret,
        amountDue: invoiceAmountDue,
      },
    };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error creating subscription:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
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
    
    logger.info(`[Stripe Subscriptions] Canceled subscription ${subscriptionId}`);
    
    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error canceling subscription:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
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
    planName: string;
    planAmount: number;
    currency: string;
    interval: string;
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
    discount: {
      id: string;
      coupon: {
        id: string;
        name?: string;
        percentOff?: number;
        amountOff?: number;
      };
    } | null;
  }>;
  error?: string;
  errorCode?: 'CUSTOMER_NOT_FOUND' | string;
}> {
  try {
    const stripe = await getStripeClient();
    
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      expand: [
        'data.items.data.price', 
        'data.schedule',
      ],
    });
    
    // Fetch product details separately to avoid exceeding Stripe's 4-level expand limit
    const productIds = new Set<string>();
    for (const sub of subscriptions.data) {
      const item = sub.items.data[0];
      if (item?.price?.product && typeof item.price.product === 'string') {
        productIds.add(item.price.product);
      }
    }
    
    const productMap = new Map<string, string>();
    if (productIds.size > 0) {
      const products = await stripe.products.list({
        ids: Array.from(productIds).slice(0, 100),
        limit: 100,
      });
      for (const product of products.data) {
        productMap.set(product.id, product.name);
      }
    }
    
    return {
      success: true,
      subscriptions: subscriptions.data.map(sub => {
        const item = sub.items.data[0];
        const price = item?.price;
        const productRef = price?.product;
        // Get product ID (either from expanded object or string reference)
        const productId = typeof productRef === 'string' 
          ? productRef 
          : (productRef && isExpandedProduct(productRef) ? productRef.id : '');
        // Look up product name from our productMap (fetched separately to avoid expand depth limit)
        const productName = productMap.get(productId) || 
          (productRef && isExpandedProduct(productRef) ? productRef.name : '');
        
        let pendingUpdate: { newPriceId: string; newProductName: string; effectiveAt: Date } | null = null;
        if (sub.pending_update?.subscription_items && (sub.pending_update.subscription_items as unknown as { data: Stripe.SubscriptionItem[] }).data.length > 0) {
          const pendingItem = (sub.pending_update.subscription_items as unknown as { data: Stripe.SubscriptionItem[] }).data[0];
          const pendingPriceRef = pendingItem?.price;
          const pendingPriceId = typeof pendingPriceRef === 'string' 
            ? pendingPriceRef 
            : pendingPriceRef?.id || '';
          const pendingProductRef = typeof pendingPriceRef === 'string' ? null : pendingPriceRef?.product;
          const pendingProductId = typeof pendingProductRef === 'string' 
            ? pendingProductRef 
            : (pendingProductRef && isExpandedProduct(pendingProductRef) ? pendingProductRef.id : '');
          const pendingProductName = productMap.get(pendingProductId) || 
            (pendingProductRef && isExpandedProduct(pendingProductRef) ? pendingProductRef.name : '');
          const typedPendingUpdate = sub.pending_update as SubscriptionPendingUpdate | null;
          const effectiveTimestamp = typedPendingUpdate?.billing_cycle_anchor 
            || typedPendingUpdate?.expires_at 
            || (sub as StripeSubscriptionWithPeriods).current_period_end;
            
          if (pendingPriceId && effectiveTimestamp) {
            pendingUpdate = {
              newPriceId: pendingPriceId,
              newProductName: pendingProductName,
              effectiveAt: new Date(effectiveTimestamp * 1000),
            };
          }
        }
        
        const discountObj = sub.discount;
        const mappedDiscount = discountObj && discountObj.coupon ? {
          id: discountObj.id,
          coupon: {
            id: discountObj.coupon.id,
            name: discountObj.coupon.name || undefined,
            percentOff: discountObj.coupon.percent_off || undefined,
            amountOff: discountObj.coupon.amount_off || undefined,
          },
        } : null;

        return {
          id: sub.id,
          status: sub.status,
          priceId: price?.id || '',
          productId,
          productName,
          planName: productName,
          planAmount: price?.unit_amount || 0,
          currency: price?.currency || 'usd',
          interval: price?.recurring?.interval || 'month',
          currentPeriodStart: new Date((sub as StripeSubscriptionWithPeriods).current_period_start * 1000),
          currentPeriodEnd: new Date((sub as StripeSubscriptionWithPeriods).current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          isPaused: !!(sub.pause_collection && sub.pause_collection.behavior),
          pausedUntil: sub.pause_collection?.resumes_at ? new Date(sub.pause_collection.resumes_at * 1000) : null,
          pendingUpdate,
          discount: mappedDiscount,
        };
      }),
    };
  } catch (error: unknown) {
    const isCustomerNotFound = isStripeError(error) && error.type === 'StripeInvalidRequestError' && 
      getErrorMessage(error).includes('No such customer');
    
    if (isCustomerNotFound) {
      logger.warn(`[Stripe Subscriptions] Customer not found: ${customerId}`);
      return {
        success: false,
        error: 'Customer not found in Stripe',
        errorCode: 'CUSTOMER_NOT_FOUND',
      };
    }
    
    logger.error('[Stripe Subscriptions] Error listing subscriptions:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
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
    const productRef = price?.product;
    const product = productRef && isExpandedProduct(productRef) ? productRef : null;
    
    return {
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        customerId: subscription.customer as string,
        priceId: price?.id || '',
        productId: product?.id || '',
        productName: product?.name || '',
        currentPeriodStart: new Date((subscription as unknown as StripeSubscriptionWithPeriods).current_period_start * 1000),
        currentPeriodEnd: new Date((subscription as unknown as StripeSubscriptionWithPeriods).current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      },
    };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error getting subscription:', { error: error });
    return {
      success: false,
      error: getErrorMessage(error),
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

    logger.info(`[Stripe Subscriptions] Paused subscription ${subscriptionId} until ${resumeDate.toISOString()}`);
    return { success: true, resumeDate };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error pausing subscription:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function resumeSubscription(subscriptionId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = await getStripeClient();
    
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: null as unknown as Stripe.SubscriptionUpdateParams.PauseCollection,
    });

    logger.info(`[Stripe Subscriptions] Resumed subscription ${subscriptionId}`);
    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error resuming subscription:', { error: error });
    return { success: false, error: getErrorMessage(error) };
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
    
    // Get the customer's default payment method to ensure it's used for the proration invoice
    let defaultPaymentMethod: string | undefined;
    
    // First check if subscription has a default payment method
    if (sub.default_payment_method) {
      defaultPaymentMethod = typeof sub.default_payment_method === 'string' 
        ? sub.default_payment_method 
        : sub.default_payment_method.id;
    }
    
    // If not, get the customer's default from invoice_settings
    if (!defaultPaymentMethod) {
      const customer = await stripe.customers.retrieve(sub.customer as string) as Stripe.Customer | Stripe.DeletedCustomer;
      if (customer && !customer.deleted) {
        const invoiceSettings = (customer as Stripe.Customer).invoice_settings;
        if (invoiceSettings?.default_payment_method) {
          defaultPaymentMethod = typeof invoiceSettings.default_payment_method === 'string'
            ? invoiceSettings.default_payment_method
            : invoiceSettings.default_payment_method.id;
        }
      }
    }
    
    // If still no payment method, try to get the first attached card
    if (!defaultPaymentMethod) {
      const paymentMethods = await stripe.paymentMethods.list({
        customer: sub.customer as string,
        type: 'card',
        limit: 1,
      });
      if (paymentMethods.data.length > 0) {
        defaultPaymentMethod = paymentMethods.data[0].id;
        logger.info(`[Stripe Subscriptions] Using first attached card ${defaultPaymentMethod} for tier change`);
      }
    }

    if (immediate) {
      const updateParams: Stripe.SubscriptionUpdateParams = {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'always_invoice',
        cancel_at_period_end: false,
      };
      
      // Set the default payment method on the subscription to ensure proration invoice uses the card
      if (defaultPaymentMethod) {
        updateParams.default_payment_method = defaultPaymentMethod;
      }
      
      await stripe.subscriptions.update(subscriptionId, updateParams);
      logger.info(`[Stripe Subscriptions] Immediately upgraded subscription ${subscriptionId} to price ${newPriceId} (payment method: ${defaultPaymentMethod || 'none'})`);
    } else {
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'none',
        cancel_at_period_end: false,
      });
      logger.info(`[Stripe Subscriptions] Changed subscription ${subscriptionId} to price ${newPriceId} (next cycle)`);
    }

    return { success: true };
  } catch (error: unknown) {
    logger.error('[Stripe Subscriptions] Error changing tier:', { error: error });
    return { success: false, error: getErrorMessage(error) };
  }
}
