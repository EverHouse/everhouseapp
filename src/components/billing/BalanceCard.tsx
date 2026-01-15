import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { apiRequest } from '../../lib/apiRequest';

interface BalanceItem {
  id: number;
  sessionId: number;
  type: 'overage' | 'guest';
  description: string;
  date: string;
  amountCents: number;
}

interface BalanceData {
  totalCents: number;
  totalDollars: number;
  itemCount: number;
  breakdown: BalanceItem[];
}

interface BalanceCardProps {
  onPayNow: () => void;
  className?: string;
}

export function BalanceCard({ onPayNow, className = '' }: BalanceCardProps) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      setLoading(true);
      const { ok, data, error: apiError } = await apiRequest<BalanceData>('/api/member/balance');
      
      if (ok && data) {
        setBalance(data);
        setError(null);
      } else {
        setError(apiError || 'Failed to load balance');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load balance');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  if (loading) {
    return (
      <div className={`glass-card rounded-2xl p-4 ${className}`}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gray-200 dark:bg-white/10 animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 bg-gray-200 dark:bg-white/10 rounded animate-pulse" />
            <div className="h-3 w-16 bg-gray-200 dark:bg-white/10 rounded animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !balance) {
    return null;
  }

  const hasBalance = balance.totalCents > 0;

  if (!hasBalance) {
    return (
      <div className={`rounded-2xl p-4 border ${isDark ? 'bg-green-900/20 border-green-500/30' : 'bg-green-50 border-green-200'} ${className}`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}>
            <span className={`material-symbols-outlined text-xl ${isDark ? 'text-green-400' : 'text-green-600'}`}>check_circle</span>
          </div>
          <div className="flex-1">
            <h3 className={`text-sm font-bold ${isDark ? 'text-green-300' : 'text-green-700'}`}>My Balance</h3>
            <p className={`text-xs ${isDark ? 'text-green-400/80' : 'text-green-600/80'}`}>No outstanding balance</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border overflow-hidden ${isDark ? 'bg-amber-900/20 border-amber-500/30' : 'bg-amber-50 border-amber-200'} ${className}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
              <span className={`material-symbols-outlined text-xl ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>account_balance_wallet</span>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={`text-sm font-bold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>My Balance</h3>
              <p className={`text-2xl font-bold font-serif mt-0.5 ${isDark ? 'text-white' : 'text-primary'}`}>
                ${balance.totalDollars.toFixed(2)}
              </p>
              <p className={`text-xs mt-1 ${isDark ? 'text-amber-400/80' : 'text-amber-600/80'}`}>
                {balance.itemCount} {balance.itemCount === 1 ? 'item' : 'items'} pending
              </p>
            </div>
          </div>
          <button
            onClick={onPayNow}
            className="px-4 py-2.5 bg-primary text-white font-semibold rounded-xl hover:bg-primary/90 transition-colors text-sm flex items-center gap-1.5 flex-shrink-0"
          >
            <span className="material-symbols-outlined text-base">credit_card</span>
            Pay Now
          </button>
        </div>
      </div>

      {balance.breakdown.length > 0 && (
        <div className={`border-t ${isDark ? 'border-amber-500/20' : 'border-amber-200'}`}>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className={`w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium transition-colors ${isDark ? 'text-amber-400 hover:bg-amber-500/10' : 'text-amber-700 hover:bg-amber-100/50'}`}
          >
            <span>View breakdown</span>
            <span className={`material-symbols-outlined text-base transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
              expand_more
            </span>
          </button>

          {isExpanded && (
            <div className={`px-4 pb-4 space-y-2 animate-pop-in ${isDark ? 'bg-black/10' : 'bg-white/30'}`}>
              {balance.breakdown.map((item) => (
                <div 
                  key={item.id} 
                  className={`flex items-center justify-between py-2 px-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white/60'}`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold flex-shrink-0 ${
                      item.type === 'guest'
                        ? isDark ? 'bg-purple-500/20 text-purple-400' : 'bg-purple-100 text-purple-700'
                        : isDark ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {item.type === 'guest' ? 'G' : 'O'}
                    </span>
                    <span className={`text-xs truncate ${isDark ? 'text-white/80' : 'text-primary/80'}`}>
                      {item.description}
                    </span>
                  </div>
                  <span className={`text-xs font-medium flex-shrink-0 ml-2 ${isDark ? 'text-white' : 'text-primary'}`}>
                    ${(item.amountCents / 100).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BalanceCard;
