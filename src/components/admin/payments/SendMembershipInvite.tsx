import React, { useState, useEffect } from 'react';

interface MembershipTier {
  id: number;
  name: string;
  price_cents: number;
  billing_interval: string;
  stripe_price_id: string | null;
  product_type: string | null;
}

interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
}

const SendMembershipInvite: React.FC<SectionProps> = ({ onClose, variant = 'modal' }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [tierId, setTierId] = useState<number | null>(null);
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      setIsLoading(true);
      try {
        const res = await fetch('/api/membership-tiers?active=true', { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to fetch tiers');
        const data: MembershipTier[] = await res.json();
        const subscriptionTiers = data.filter(
          t => t.product_type !== 'one_time' && t.stripe_price_id
        );
        setTiers(subscriptionTiers);
        if (subscriptionTiers.length > 0) {
          setTierId(subscriptionTiers[0].id);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };
    fetchTiers();
  }, []);

  const formatPrice = (cents: number, interval: string) => {
    const dollars = (cents / 100).toFixed(0);
    const suffix = interval === 'year' ? '/yr' : '/mo';
    return `$${dollars}${suffix}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !firstName || !lastName || !tierId) {
      setError('All fields are required');
      return;
    }

    setIsSending(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch('/api/stripe/staff/send-membership-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, firstName, lastName, tierId })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to send invite');
      }

      setSuccess(true);
      setFirstName('');
      setLastName('');
      setEmail('');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSending(false);
    }
  };

  const content = (
    <form onSubmit={handleSubmit} className="space-y-4">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-green-600 border-t-transparent" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="invite-first-name" className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
                First Name
              </label>
              <input
                id="invite-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3 py-2 bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 rounded-lg text-primary dark:text-white placeholder-primary/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-green-500/50"
                placeholder="John"
                required
              />
            </div>
            <div>
              <label htmlFor="invite-last-name" className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
                Last Name
              </label>
              <input
                id="invite-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3 py-2 bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 rounded-lg text-primary dark:text-white placeholder-primary/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-green-500/50"
                placeholder="Doe"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="invite-email" className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 rounded-lg text-primary dark:text-white placeholder-primary/40 dark:placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="john@example.com"
              required
            />
          </div>

          <div>
            <label htmlFor="invite-tier" className="block text-sm font-medium text-primary/70 dark:text-white/70 mb-1">
              Membership Tier
            </label>
            <select
              id="invite-tier"
              value={tierId || ''}
              onChange={(e) => setTierId(Number(e.target.value))}
              className="w-full px-3 py-2 bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 rounded-lg text-primary dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
              required
            >
              {tiers.length === 0 ? (
                <option value="">No tiers available</option>
              ) : (
                tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.name} - {formatPrice(tier.price_cents, tier.billing_interval)}
                  </option>
                ))
              )}
            </select>
          </div>

          {error && (
            <div className="p-3 bg-red-100/80 dark:bg-red-900/30 border border-red-200 dark:border-red-500/30 rounded-lg text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-100/80 dark:bg-green-900/30 border border-green-200 dark:border-green-500/30 rounded-lg text-green-700 dark:text-green-300 text-sm flex items-center gap-2">
              <span className="material-symbols-outlined text-lg">check_circle</span>
              Invite sent successfully!
            </div>
          )}

          <button
            type="submit"
            disabled={isSending || tiers.length === 0}
            className="w-full py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isSending ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                Sending...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">send</span>
                Send Invite
              </>
            )}
          </button>
        </>
      )}
    </form>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">mail</span>
          <h3 className="font-bold text-primary dark:text-white">Send Membership Invite</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">mail</span>
          <h3 className="font-bold text-primary dark:text-white">Send Membership Invite</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

export default SendMembershipInvite;
