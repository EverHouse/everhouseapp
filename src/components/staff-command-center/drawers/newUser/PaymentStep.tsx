import React from 'react';
import type { Stripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { SimpleCheckoutForm } from '../../../stripe/StripePaymentForm';
import { TerminalPayment } from '../../TerminalPayment';
import {
  MemberFormData,
  MembershipTier,
  MemberStep,
} from './newUserTypes';
import { postWithCredentials, deleteWithCredentials } from '../../../../hooks/queries/useFetch';
import WalkingGolferSpinner from '../../../WalkingGolferSpinner';

interface PaymentStepProps {
  form: MemberFormData;
  tiers: MembershipTier[];
  discounts: { id: string; code: string; percentOff: number; stripeCouponId?: string }[];
  selectedTier: MembershipTier | undefined;
  isDark: boolean;
  isLoading: boolean;
  stripeInstance: Stripe | null;
  clientSecret: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  createdUserId: string | null;
  stripeLoading: boolean;
  stripeError: string | null;
  paymentMethod: 'card' | 'terminal';
  paymentPath: 'choose' | 'card_or_terminal' | 'link';
  activationUrl: string | null;
  linkSending: boolean;
  scannedIdImage: { base64: string; mimeType: string } | null;
  subMemberScannedIds: Record<number, { base64: string; mimeType: string }>;
  setPaymentMethod: (method: 'card' | 'terminal') => void;
  setPaymentPath: (path: 'choose' | 'card_or_terminal' | 'link') => void;
  resetPayment: () => void;
  initializePayment: () => void;
  handlePaymentSuccess: (paymentIntentId?: string) => Promise<void>;
  handleSendActivationLink: () => Promise<void>;
  handleCopyActivationLink: () => Promise<void>;
  setStripeError: (error: string | null) => void;
  setStep: (step: MemberStep) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  onSuccess: (user: { id: string; email: string; name: string }) => void;
}

export function PaymentStep({
  form,
  tiers,
  discounts,
  selectedTier,
  isDark,
  isLoading,
  stripeInstance,
  clientSecret,
  paymentIntentId,
  subscriptionId,
  createdUserId,
  stripeLoading,
  stripeError,
  paymentMethod,
  paymentPath,
  activationUrl,
  linkSending,
  scannedIdImage,
  subMemberScannedIds,
  setPaymentMethod,
  setPaymentPath,
  resetPayment,
  initializePayment,
  handlePaymentSuccess,
  handleSendActivationLink,
  handleCopyActivationLink,
  setStripeError,
  setStep,
  showToast,
  onSuccess,
}: PaymentStepProps) {
  const discount = discounts.find(d => d.code === form.discountCode);
  const tierPrice = selectedTier?.priceCents || 0;
  const discountPercent = discount?.percentOff || 0;
  const primaryPrice = form.joinExistingGroup 
    ? Math.round(tierPrice * 0.8)
    : Math.round(tierPrice * (1 - discountPercent / 100));
  
  const groupMembersTotal = form.groupMembers.reduce((sum, member) => {
    const memberTier = tiers.find(t => t.id === member.tierId) || selectedTier;
    const memberTierPrice = memberTier?.priceCents || tierPrice;
    return sum + Math.round(memberTierPrice * 0.8);
  }, 0);
  
  const totalPrice = primaryPrice + groupMembersTotal;

  const stripeOptions = (clientSecret ? {
    clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#059669',
        colorBackground: isDark ? '#1a1d12' : '#ffffff',
        colorText: isDark ? '#ffffff' : '#31543C',
        colorDanger: '#df1b41',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
      },
    },
  } : undefined) as import('@stripe/stripe-js').StripeElementsOptions | undefined;

  return (
    <div className="space-y-4">
      <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
        Payment
      </h3>

      <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex justify-between items-center mb-2">
          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {selectedTier?.name} Membership
          </span>
          <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            ${(totalPrice / 100).toFixed(2)}
          </span>
        </div>
        <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
          for {form.firstName} {form.lastName}
        </p>
      </div>

      {paymentPath === 'choose' && (
        <>
          <div className="grid grid-cols-1 gap-3">
            <button
              onClick={() => setPaymentPath('card_or_terminal')}
              className={`p-4 rounded-lg border-2 text-left transition-colors tactile-btn ${
                isDark
                  ? 'border-white/10 hover:border-emerald-500/50 hover:bg-white/5'
                  : 'border-gray-200 hover:border-emerald-500/50 hover:bg-emerald-50/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  isDark ? 'bg-emerald-600/20' : 'bg-emerald-100'
                }`}>
                  <span className="material-symbols-outlined text-emerald-600">credit_card</span>
                </div>
                <div>
                  <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Collect Payment Now
                  </p>
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    Process card payment in person
                  </p>
                </div>
              </div>
            </button>

            {(!form.joinExistingGroup && (!form.addGroupMembers || form.groupMembers.length === 0)) && (
              <button
                onClick={() => setPaymentPath('link')}
                className={`p-4 rounded-lg border-2 text-left transition-colors tactile-btn ${
                  isDark
                    ? 'border-white/10 hover:border-emerald-500/50 hover:bg-white/5'
                    : 'border-gray-200 hover:border-emerald-500/50 hover:bg-emerald-50/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    isDark ? 'bg-blue-600/20' : 'bg-blue-100'
                  }`}>
                    <span className="material-symbols-outlined text-blue-600">link</span>
                  </div>
                  <div>
                    <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      Send Payment Link
                    </p>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Email a checkout link to the member
                    </p>
                  </div>
                </div>
              </button>
            )}

            {(form.joinExistingGroup || (form.addGroupMembers && form.groupMembers.length > 0)) && (
              <div className={`p-3 rounded-lg text-sm text-center ${isDark ? 'bg-white/5 text-gray-400' : 'bg-emerald-50/50 text-gray-600 border border-gray-200'}`}>
                <span className="material-symbols-outlined text-sm align-middle mr-1">info</span>
                Payment links are for individual memberships. To process a group membership, please use "Collect Payment Now".
              </div>
            )}
          </div>

          <button
            onClick={() => {
              resetPayment();
              setPaymentPath('choose');
              setStep('preview');
            }}
            className={`w-full py-2.5 mt-2 text-sm tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
          >
            Back to Review
          </button>
        </>
      )}

      {paymentPath === 'card_or_terminal' && (
        <>
          <div className="flex gap-2 p-1 rounded-lg bg-gray-100 dark:bg-white/5">
            <button
              onClick={() => setPaymentMethod('card')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 tactile-btn ${
                paymentMethod === 'card'
                  ? 'bg-white dark:bg-white/10 shadow-sm text-emerald-600 dark:text-emerald-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-lg">credit_card</span>
              Enter Card
            </button>
            <button
              onClick={() => setPaymentMethod('terminal')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 tactile-btn ${
                paymentMethod === 'terminal'
                  ? 'bg-white dark:bg-white/10 shadow-sm text-emerald-600 dark:text-emerald-400'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <span className="material-symbols-outlined text-lg">contactless</span>
              Card Reader
            </button>
          </div>

          {paymentMethod === 'card' && (
            <>
              {stripeLoading && (
                <div className="flex items-center justify-center py-8">
                  <WalkingGolferSpinner size="sm" variant="auto" />
                </div>
              )}

              {stripeError && (
                <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                  <p className="text-sm">{stripeError}</p>
                  <button
                    onClick={() => {
                      resetPayment();
                      initializePayment();
                    }}
                    className="text-sm underline mt-2 tactile-btn"
                  >
                    Try Again
                  </button>
                </div>
              )}

              {clientSecret && stripeInstance && stripeOptions && (
                <Elements stripe={stripeInstance} options={stripeOptions}>
                  <SimpleCheckoutForm
                    onSuccess={handlePaymentSuccess}
                    onError={(msg) => setStripeError(msg)}
                    submitLabel={`Charge $${(totalPrice / 100).toFixed(2)}`}
                  />
                </Elements>
              )}

              {!stripeLoading && !stripeError && !clientSecret && (
                <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                  {subscriptionId ? (
                    <div className="text-center">
                      <p className={`text-sm mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        Card entry not available for this subscription.
                      </p>
                      <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                        Use the Card Reader option above, or go back and send an activation link.
                      </p>
                    </div>
                  ) : (
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      Initializing payment...
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {paymentMethod === 'terminal' && (
            <>
              {stripeError && !subscriptionId ? (
                <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                  <p className="text-sm">{stripeError}</p>
                  <button
                    onClick={() => {
                      resetPayment();
                      initializePayment();
                    }}
                    className="text-sm underline mt-2"
                  >
                    Try Again
                  </button>
                </div>
              ) : (
                <TerminalPayment
                  amount={totalPrice}
                  subscriptionId={form.joinExistingGroup ? null : subscriptionId}
                  existingPaymentIntentId={paymentIntentId || undefined}
                  userId={createdUserId}
                  description={form.joinExistingGroup ? `${selectedTier?.name || 'Membership'} (Group Add-on)` : undefined}
                  onSuccess={async (piId) => {
                    if (form.joinExistingGroup) {
                      await handlePaymentSuccess(piId);
                    } else {
                      try {
                        const confirmRes = await fetch('/api/stripe/terminal/confirm-subscription-payment', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({
                            paymentIntentId: piId,
                            subscriptionId,
                            userId: createdUserId,
                            invoiceId: null
                          })
                        });
                        if (!confirmRes.ok) {
                          const data = await confirmRes.json();
                          if (!data.autoRefunded) {
                            try {
                              await fetch('/api/stripe/terminal/refund-payment', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                credentials: 'include',
                                body: JSON.stringify({ paymentIntentId: piId })
                              });
                              showToast('Payment activation failed. The charge has been automatically refunded.', 'error');
                            } catch (refundErr) {
                              console.error('Auto-refund attempt failed:', refundErr);
                              showToast(`Payment activation failed: ${data.error}. Please refund manually in Stripe.`, 'error');
                            }
                          } else {
                            showToast('Member account not found. Payment has been automatically refunded.', 'error');
                          }
                          setStripeError(data.error || 'Failed to confirm payment');
                          return;
                        }
                        const confirmData = await confirmRes.json();
                        if (confirmData.cardSaveWarning) {
                          showToast(`Payment received! Membership activated. Note: ${confirmData.cardSaveWarning}`, 'warning');
                        } else {
                          showToast('Payment received! Membership activated.', 'success');
                        }

                        if (form.addGroupMembers && form.groupMembers.length > 0) {
                          try {
                            const groupCreateRes = await fetch('/api/family-billing/groups', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              credentials: 'include',
                              body: JSON.stringify({
                                primaryEmail: form.email,
                                groupName: `${form.firstName} ${form.lastName} Family`
                              })
                            });

                            if (!groupCreateRes.ok) {
                              const groupCreateData = await groupCreateRes.json();
                              console.error('Failed to create family billing group:', groupCreateData.error);
                              showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
                            } else {
                              const groupCreateData = await groupCreateRes.json();
                              const groupId = groupCreateData.groupId;
                              let addedCount = 0;
                              let failedCount = 0;

                              for (let i = 0; i < form.groupMembers.length; i++) {
                                const member = form.groupMembers[i];
                                try {
                                  const memberTierSlug = tiers.find(t => t.id === member.tierId)?.slug || selectedTier?.slug;
                                  const addMemberRes = await fetch(`/api/family-billing/groups/${groupId}/members`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    credentials: 'include',
                                    body: JSON.stringify({
                                      memberEmail: member.email,
                                      memberTier: memberTierSlug,
                                      relationship: 'family',
                                      firstName: member.firstName,
                                      lastName: member.lastName,
                                      phone: member.phone,
                                      dob: member.dob,
                                      streetAddress: member.streetAddress || undefined,
                                      city: member.city || undefined,
                                      state: member.state || undefined,
                                      zipCode: member.zipCode || undefined,
                                    })
                                  });

                                  if (addMemberRes.ok) {
                                    addedCount++;
                                    const addData = await addMemberRes.json();
                                    if (subMemberScannedIds[i] && addData.memberId) {
                                      fetch('/api/admin/save-id-image', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        credentials: 'include',
                                        body: JSON.stringify({
                                          userId: addData.memberId,
                                          image: subMemberScannedIds[i].base64,
                                          mimeType: subMemberScannedIds[i].mimeType,
                                        }),
                                      }).catch(err => console.error('Failed to save sub-member ID image:', err));
                                    }
                                  } else {
                                    failedCount++;
                                    const addData = await addMemberRes.json();
                                    console.error(`Failed to add group member ${member.email}:`, addData.error);
                                  }
                                } catch (memberErr) {
                                  failedCount++;
                                  console.error(`Error adding group member ${member.email}:`, memberErr);
                                }
                              }

                              if (failedCount === 0) {
                                showToast(`Family group created with ${addedCount} member${addedCount !== 1 ? 's' : ''}.`, 'success');
                              } else if (addedCount > 0) {
                                showToast(`Family group created. ${addedCount} added, ${failedCount} failed. Check group billing to fix.`, 'warning');
                              } else {
                                showToast('Family group created but failed to add members. You can add them manually.', 'warning');
                              }
                            }
                          } catch (groupErr) {
                            console.error('Error creating family group:', groupErr);
                            showToast('Membership activated but failed to create family group. You can set this up manually.', 'warning');
                          }
                        }

                        if (scannedIdImage && createdUserId) {
                          fetch('/api/admin/save-id-image', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({
                              userId: createdUserId,
                              image: scannedIdImage.base64,
                              mimeType: scannedIdImage.mimeType,
                            }),
                          }).catch(err => console.error('Failed to save ID image:', err));
                        }

                        onSuccess({
                          id: createdUserId || 'member-' + Date.now(),
                          email: form.email,
                          name: `${form.firstName} ${form.lastName}`
                        });
                      } catch (err: unknown) {
                        setStripeError((err instanceof Error ? err.message : String(err)) || 'Failed to activate membership');
                      }
                    }
                  }}
                  onError={(msg) => setStripeError(msg)}
                  onCancel={async () => {
                    if (createdUserId && subscriptionId) {
                      try {
                        await deleteWithCredentials(`/api/stripe/subscriptions/cleanup-pending/${createdUserId}`);
                        showToast('Signup cancelled. No charges were made.', 'info');
                      } catch (err: unknown) {
                        console.error('Failed to cleanup pending signup:', err);
                        showToast('Signup cancelled but cleanup failed. Use the cleanup button to remove the pending account.', 'warning');
                      }
                    }
                  }}
                />
              )}
            </>
          )}

          <button
            onClick={() => {
              resetPayment();
              setPaymentPath('choose');
            }}
            className={`w-full py-2.5 mt-2 text-sm tactile-btn ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
          >
            Back
          </button>
        </>
      )}

      {paymentPath === 'link' && (
        <>
          <div className="flex gap-2">
            <button
              onClick={handleSendActivationLink}
              disabled={isLoading || linkSending}
              className={`flex-1 py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 tactile-btn ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {linkSending && !activationUrl ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                  Sending...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm">mail</span>
                  Send Link
                </>
              )}
            </button>
            <button
              onClick={handleCopyActivationLink}
              disabled={isLoading || linkSending}
              className={`py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 tactile-btn ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title="Copy activation link to clipboard"
            >
              {linkSending && !activationUrl ? (
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-sm">content_copy</span>
              )}
              Copy Link
            </button>
          </div>
          <p className={`text-xs text-center mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
            Member will complete payment via link
          </p>

          {activationUrl && (
            <div className={`p-3 rounded-lg ${isDark ? 'bg-emerald-900/20 border border-emerald-700' : 'bg-emerald-50 border border-emerald-200'}`}>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-600">check_circle</span>
                <p className={`text-sm font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                  Payment link generated
                </p>
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setPaymentPath('choose');
            }}
            className={`w-full py-2.5 mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}
          >
            Back
          </button>
        </>
      )}
    </div>
  );
}
