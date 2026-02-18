import type { GuestPassInfo, GuestCheckInItem } from './memberProfileTypes';
import React from 'react';
import MemberBillingTab from '../admin/MemberBillingTab';
import type { GuestVisit } from './memberProfileTypes';

interface BillingTabProps {
  memberEmail: string;
  memberId: string | number;
  displayedTier: string;
  onTierUpdate: (newTier: string) => void;
  guestPassInfo: GuestPassInfo | null;
  guestHistory: GuestVisit[];
  guestCheckInsHistory: GuestCheckInItem[];
  purchases: Array<{ id: number | string; description?: string; amount?: number; date?: string; status?: string; type?: string; product_name?: string; quantity?: number; created_at?: string }>;
}

const BillingTab: React.FC<BillingTabProps> = ({
  memberEmail,
  memberId,
  displayedTier,
  onTierUpdate,
  guestPassInfo,
  guestHistory,
  guestCheckInsHistory,
  purchases,
}) => {
  return (
    <div className="space-y-4">
      <div 
        className="animate-slide-up-stagger"
        style={{ '--stagger-index': 0 } as React.CSSProperties}
      >
        <MemberBillingTab 
          memberEmail={memberEmail} 
          memberId={memberId} 
          currentTier={displayedTier}
          onTierUpdate={onTierUpdate}
          guestPassInfo={guestPassInfo}
          guestHistory={guestHistory}
          guestCheckInsHistory={guestCheckInsHistory}
          purchases={purchases}
        />
      </div>
    </div>
  );
};

export default BillingTab;
