import React from 'react';
import { Section } from './ProfileShared';
import type { AccountBalanceData } from './profileTypes';

interface AccountBalanceSectionProps {
  isDark: boolean;
  accountBalance: AccountBalanceData | undefined;
  showAddFunds: boolean;
  setShowAddFunds: (v: boolean) => void;
  handleAddFunds: (amountCents: number) => void;
  addFundsPending: boolean;
}

const AccountBalanceSection: React.FC<AccountBalanceSectionProps> = ({
  isDark,
  accountBalance,
  showAddFunds,
  setShowAddFunds,
  handleAddFunds,
  addFundsPending,
}) => {
  return (
    <Section title="Account Balance" isDark={isDark} staggerIndex={2}>
      <div className="py-3 px-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <span className={`material-symbols-outlined ${isDark ? 'opacity-70' : 'text-primary/70'}`}>account_balance_wallet</span>
            <div>
              <span className={`font-medium text-sm ${isDark ? '' : 'text-primary'}`}>Available Credit</span>
              <p className={`text-xs mt-0.5 ${isDark ? 'opacity-70' : 'text-primary/70'}`}>
                Applied to guest fees & overages
              </p>
            </div>
          </div>
          <div className="text-right">
            <span className={`text-2xl font-bold font-serif ${accountBalance && accountBalance.balanceDollars > 0 ? (isDark ? 'text-accent' : 'text-green-600') : (isDark ? 'text-white' : 'text-primary')}`}>
              ${(accountBalance?.balanceDollars || 0).toFixed(2)}
            </span>
          </div>
        </div>
        
        {showAddFunds ? (
          <div className="space-y-3">
            <p className={`text-sm ${isDark ? 'opacity-70' : 'text-primary/70'}`}>Select amount to add:</p>
            <div className="grid grid-cols-3 gap-2">
              {[2500, 5000, 10000].map(cents => (
                <button
                  key={cents}
                  onClick={() => handleAddFunds(cents)}
                  disabled={addFundsPending}
                  className={`py-3 rounded-xl font-semibold text-sm transition-colors ${
                    isDark 
                      ? 'bg-white/10 hover:bg-white/20 text-white' 
                      : 'bg-primary/10 hover:bg-primary/20 text-primary'
                  } ${addFundsPending ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  ${cents / 100}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowAddFunds(false)}
              className={`w-full py-2 text-sm ${isDark ? 'text-white/60' : 'text-primary/60'}`}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowAddFunds(true)}
            className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium text-sm transition-all duration-fast tactile-btn ${
              isDark 
                ? 'bg-accent/20 text-accent hover:bg-accent/30' 
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }`}
          >
            <span className="material-symbols-outlined text-lg">add</span>
            Add Funds
          </button>
        )}
      </div>
    </Section>
  );
};

export default AccountBalanceSection;
