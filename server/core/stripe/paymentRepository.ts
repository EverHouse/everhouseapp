import { db } from '../../db';
import { stripePaymentIntents, users } from '../../../shared/schema';
import { eq, and, gte, inArray, sql, desc } from 'drizzle-orm';

export interface PaymentWithMember {
  id: number;
  paymentIntentId: string;
  memberEmail: string | null;
  memberName: string;
  amount: number;
  description: string | null;
  status: string;
  createdAt: Date | null;
}

export interface RefundablePayment extends PaymentWithMember {}

export interface FailedPayment extends PaymentWithMember {
  failureReason: string | null;
  retryCount: number;
  lastRetryAt: Date | null;
  requiresCardUpdate: boolean;
  dunningNotifiedAt: Date | null;
}

export interface PendingAuthorization extends PaymentWithMember {
  expiresAt: string;
}

export async function getRefundablePayments(): Promise<RefundablePayment[]> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const results = await db
    .select({
      id: stripePaymentIntents.id,
      paymentIntentId: stripePaymentIntents.stripePaymentIntentId,
      memberEmail: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      amount: stripePaymentIntents.amountCents,
      description: stripePaymentIntents.description,
      status: stripePaymentIntents.status,
      createdAt: stripePaymentIntents.createdAt,
    })
    .from(stripePaymentIntents)
    .leftJoin(users, eq(users.id, stripePaymentIntents.userId))
    .where(
      and(
        eq(stripePaymentIntents.status, 'succeeded'),
        gte(stripePaymentIntents.createdAt, thirtyDaysAgo)
      )
    )
    .orderBy(desc(stripePaymentIntents.createdAt));

  return results.map(row => ({
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    memberEmail: row.memberEmail,
    memberName: formatMemberName(row.firstName, row.lastName, row.memberEmail),
    amount: row.amount,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export async function getFailedPayments(limit = 50): Promise<FailedPayment[]> {
  const failedStatuses = ['failed', 'canceled', 'requires_action', 'requires_payment_method'];
  
  const results = await db
    .select({
      id: stripePaymentIntents.id,
      paymentIntentId: stripePaymentIntents.stripePaymentIntentId,
      memberEmail: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      amount: stripePaymentIntents.amountCents,
      description: stripePaymentIntents.description,
      status: stripePaymentIntents.status,
      createdAt: stripePaymentIntents.createdAt,
      failureReason: stripePaymentIntents.failureReason,
      retryCount: stripePaymentIntents.retryCount,
      lastRetryAt: stripePaymentIntents.lastRetryAt,
      requiresCardUpdate: stripePaymentIntents.requiresCardUpdate,
      dunningNotifiedAt: stripePaymentIntents.dunningNotifiedAt,
    })
    .from(stripePaymentIntents)
    .leftJoin(users, eq(users.id, stripePaymentIntents.userId))
    .where(inArray(stripePaymentIntents.status, failedStatuses))
    .orderBy(desc(stripePaymentIntents.createdAt))
    .limit(limit);

  return results.map(row => ({
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    memberEmail: row.memberEmail || 'unknown',
    memberName: formatMemberName(row.firstName, row.lastName, 'Unknown'),
    amount: row.amount,
    description: row.description,
    status: row.status,
    failureReason: row.failureReason,
    retryCount: row.retryCount || 0,
    lastRetryAt: row.lastRetryAt,
    requiresCardUpdate: row.requiresCardUpdate || false,
    dunningNotifiedAt: row.dunningNotifiedAt,
    createdAt: row.createdAt,
  }));
}

export async function getPendingAuthorizations(): Promise<PendingAuthorization[]> {
  // Include requires_capture (pre-authorized) and requires_payment_method/requires_action (incomplete payments like overage fees)
  const pendingStatuses = ['requires_capture', 'requires_payment_method', 'requires_action', 'requires_confirmation'];
  
  const results = await db
    .select({
      id: stripePaymentIntents.id,
      paymentIntentId: stripePaymentIntents.stripePaymentIntentId,
      memberEmail: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      amount: stripePaymentIntents.amountCents,
      description: stripePaymentIntents.description,
      status: stripePaymentIntents.status,
      createdAt: stripePaymentIntents.createdAt,
    })
    .from(stripePaymentIntents)
    .leftJoin(users, eq(users.id, stripePaymentIntents.userId))
    .where(inArray(stripePaymentIntents.status, pendingStatuses))
    .orderBy(desc(stripePaymentIntents.createdAt));

  return results.map(row => ({
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    memberEmail: row.memberEmail,
    memberName: formatMemberName(row.firstName, row.lastName, row.description),
    amount: row.amount,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: new Date(new Date(row.createdAt!).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }));
}

export async function getPaymentByIntentId(paymentIntentId: string) {
  const results = await db
    .select({
      id: stripePaymentIntents.id,
      userId: stripePaymentIntents.userId,
      stripePaymentIntentId: stripePaymentIntents.stripePaymentIntentId,
      stripeCustomerId: stripePaymentIntents.stripeCustomerId,
      amountCents: stripePaymentIntents.amountCents,
      purpose: stripePaymentIntents.purpose,
      bookingId: stripePaymentIntents.bookingId,
      sessionId: stripePaymentIntents.sessionId,
      description: stripePaymentIntents.description,
      status: stripePaymentIntents.status,
      createdAt: stripePaymentIntents.createdAt,
      memberEmail: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(stripePaymentIntents)
    .leftJoin(users, eq(users.id, stripePaymentIntents.userId))
    .where(eq(stripePaymentIntents.stripePaymentIntentId, paymentIntentId))
    .limit(1);

  if (results.length === 0) {
    return null;
  }

  const row = results[0];
  return {
    ...row,
    member_email: row.memberEmail,
    member_name: formatMemberName(row.firstName, row.lastName, null),
    amount_cents: row.amountCents,
  };
}

export async function updatePaymentStatus(paymentIntentId: string, status: string) {
  await db
    .update(stripePaymentIntents)
    .set({ status, updatedAt: new Date() })
    .where(eq(stripePaymentIntents.stripePaymentIntentId, paymentIntentId));
}

export async function updatePaymentStatusAndAmount(paymentIntentId: string, status: string, amountCents: number) {
  await db
    .update(stripePaymentIntents)
    .set({ status, amountCents, updatedAt: new Date() })
    .where(eq(stripePaymentIntents.stripePaymentIntentId, paymentIntentId));
}

function formatMemberName(firstName: string | null, lastName: string | null, fallback: string | null): string {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  return name || fallback || 'Unknown';
}
