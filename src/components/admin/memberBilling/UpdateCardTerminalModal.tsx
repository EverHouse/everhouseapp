import React from 'react';
import { ModalShell } from '../../ModalShell';
import { TerminalPayment } from '../../staff-command-center/TerminalPayment';
import type { BillingInfo } from './types';

export function UpdateCardTerminalModal({
  isOpen,
  onClose,
  billingInfo,
  memberId,
  memberEmail,
  onSuccess,
  onError,
  isDark,
}: {
  isOpen: boolean;
  onClose: () => void;
  billingInfo: BillingInfo;
  memberId?: string;
  memberEmail: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
  isDark: boolean;
}) {
  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Update Payment Method"
      size="md"
    >
      <div className="p-4 space-y-4">
        <div className={`p-3 rounded-lg ${isDark ? 'bg-blue-500/10 border border-blue-500/30' : 'bg-blue-50 border border-blue-200'}`}>
          <div className="flex items-center gap-2">
            <span className={`material-symbols-outlined ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>info</span>
            <span className={`text-sm ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
              Tap or insert a card on the reader to update this member's payment method on file. No charge will be made.
            </span>
          </div>
        </div>

        <TerminalPayment
          amount={0}
          mode="save_card"
          userId={memberId || null}
          email={memberEmail}
          description="Update payment method on file"
          paymentMetadata={{
            customerId: billingInfo.stripeCustomerId!,
            source: 'member_profile',
            ...(memberEmail ? { ownerEmail: memberEmail } : {}),
          }}
          subscriptionId={billingInfo.activeSubscription?.id || null}
          onSuccess={onSuccess}
          onError={onError}
          onCancel={onClose}
        />
      </div>
    </ModalShell>
  );
}
