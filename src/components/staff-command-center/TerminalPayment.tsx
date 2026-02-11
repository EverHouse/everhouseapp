import { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

interface TerminalReader {
  id: string;
  label: string;
  status: string;
  deviceType: string;
}

interface TerminalPaymentProps {
  amount: number;
  subscriptionId?: string | null;
  existingPaymentIntentId?: string;
  userId: string | null;
  description?: string;
  email?: string;
  paymentMetadata?: Record<string, string>;
  cartItems?: Array<{ productId: string; name: string; priceCents: number; quantity: number }>;
  mode?: 'payment' | 'save_card';
  onSuccess: (paymentIntentId: string) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}

export function TerminalPayment({ 
  amount, 
  subscriptionId,
  existingPaymentIntentId,
  userId,
  description,
  email,
  paymentMetadata,
  cartItems,
  mode = 'payment',
  onSuccess, 
  onError,
  onCancel 
}: TerminalPaymentProps) {
  const { isDark } = useTheme();
  const [readers, setReaders] = useState<TerminalReader[]>([]);
  const [selectedReader, setSelectedReader] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [creatingSimulated, setCreatingSimulated] = useState(false);

  const isSaveCard = mode === 'save_card';

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const clearPollingRef = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startTimeout = useCallback(() => {
    clearTimeoutRef();
    timeoutRef.current = setTimeout(async () => {
      clearPollingRef();
      if (selectedReader) {
        try {
          await fetch('/api/stripe/terminal/cancel-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ readerId: selectedReader })
          });
        } catch (err) {
          console.error('Error canceling on timeout:', err);
        }
      }
      setStatus('error');
      setStatusMessage('Reader timed out. No card was presented within 2 minutes.');
      setProcessing(false);
    }, 120000);
  }, [clearTimeoutRef, clearPollingRef, selectedReader]);

  const fetchReaders = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/stripe/terminal/readers', {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch readers');
      const data = await res.json();
      setReaders(data.readers || []);
      
      const onlineReaders = (data.readers || []).filter((r: TerminalReader) => r.status === 'online');
      if (onlineReaders.length === 1) {
        setSelectedReader(onlineReaders[0].id);
      }
    } catch (err: any) {
      console.error('Error fetching readers:', err);
      onError('Failed to load card readers');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    fetchReaders();
    return () => {
      clearPollingRef();
      clearTimeoutRef();
    };
  }, [fetchReaders, clearPollingRef, clearTimeoutRef]);

  const createSimulatedReader = async () => {
    try {
      setCreatingSimulated(true);
      const res = await fetch('/api/stripe/terminal/create-simulated-reader', {
        method: 'POST',
        credentials: 'include'
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create simulated reader');
      }
      await fetchReaders();
    } catch (err: any) {
      console.error('Error creating simulated reader:', err);
      onError(err.message);
    } finally {
      setCreatingSimulated(false);
    }
  };

  const pollPaymentStatus = useCallback(async (piId: string) => {
    try {
      const res = await fetch(`/api/stripe/terminal/payment-status/${piId}`, {
        credentials: 'include'
      });
      if (!res.ok) return;
      const data = await res.json();
      
      if (data.status === 'succeeded') {
        clearPollingRef();
        clearTimeoutRef();
        setStatus('success');
        setStatusMessage('Payment successful!');
        setTimeout(() => {
          onSuccess(piId);
        }, 1500);
      } else if (data.status === 'canceled' || data.status === 'requires_payment_method') {
        clearPollingRef();
        clearTimeoutRef();
        setStatus('error');
        setStatusMessage('Payment was declined or canceled');
        setProcessing(false);
      }
    } catch (err) {
      console.error('Error polling payment status:', err);
    }
  }, [onSuccess, clearPollingRef, clearTimeoutRef]);

  const pollSetupStatus = useCallback(async (siId: string) => {
    try {
      const res = await fetch(`/api/stripe/terminal/setup-status/${siId}`, {
        credentials: 'include'
      });
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'succeeded') {
        clearPollingRef();
        clearTimeoutRef();
        try {
          const confirmRes = await fetch('/api/stripe/terminal/confirm-save-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              setupIntentId: siId,
              customerId: paymentMetadata?.customerId,
              subscriptionId
            })
          });
          const confirmData = await confirmRes.json();
          if (!confirmRes.ok || !confirmData.cardSaved) {
            setStatus('error');
            setStatusMessage(confirmData.error || 'Card was read but could not be saved. Please try again.');
            setProcessing(false);
            return;
          }
        } catch (err: any) {
          console.error('Error confirming save card:', err);
          setStatus('error');
          setStatusMessage('Card was read but could not be saved. Please try again.');
          setProcessing(false);
          return;
        }
        setStatus('success');
        setStatusMessage('Card saved successfully!');
        setTimeout(() => {
          onSuccess(siId);
        }, 1500);
      } else if (data.status === 'canceled') {
        clearPollingRef();
        clearTimeoutRef();
        setStatus('error');
        setStatusMessage('Card save was canceled');
        setProcessing(false);
      }
    } catch (err) {
      console.error('Error polling setup status:', err);
    }
  }, [onSuccess, clearPollingRef, clearTimeoutRef, paymentMetadata?.customerId, subscriptionId]);

  const handleProcessPayment = async () => {
    if (!selectedReader) {
      onError('Please select a card reader');
      return;
    }

    if (isSaveCard && !paymentMetadata?.customerId) {
      onError('Customer ID is required to save a card');
      return;
    }

    setProcessing(true);
    setStatus('waiting');
    setStatusMessage(isSaveCard ? 'Present card on reader to save...' : 'Waiting for card on reader...');

    try {
      let res: Response;

      if (isSaveCard) {
        res = await fetch('/api/stripe/terminal/save-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            readerId: selectedReader,
            customerId: paymentMetadata?.customerId,
            email,
            userId
          })
        });
      } else if (existingPaymentIntentId) {
        res = await fetch('/api/stripe/terminal/process-existing-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            readerId: selectedReader,
            paymentIntentId: existingPaymentIntentId
          })
        });
      } else if (subscriptionId) {
        res = await fetch('/api/stripe/terminal/process-subscription-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            readerId: selectedReader,
            subscriptionId,
            userId,
            email
          })
        });
      } else {
        res = await fetch('/api/stripe/terminal/process-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            readerId: selectedReader,
            amount,
            currency: 'usd',
            description,
            metadata: paymentMetadata,
            cartItems
          })
        });
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || (isSaveCard ? 'Failed to save card' : 'Failed to process payment'));
      }

      const data = await res.json();

      startTimeout();

      if (isSaveCard) {
        setSetupIntentId(data.setupIntentId);
        pollingRef.current = setInterval(() => {
          pollSetupStatus(data.setupIntentId);
        }, 1500);
      } else {
        setPaymentIntentId(data.paymentIntentId);
        pollingRef.current = setInterval(() => {
          pollPaymentStatus(data.paymentIntentId);
        }, 1500);
      }

    } catch (err: any) {
      console.error('Error processing terminal payment:', err);
      setStatus('error');
      setStatusMessage(err.message);
      setProcessing(false);
    }
  };

  const handleCancelPayment = async () => {
    clearPollingRef();
    clearTimeoutRef();

    if (selectedReader && processing) {
      try {
        await fetch('/api/stripe/terminal/cancel-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ readerId: selectedReader })
        });
      } catch (err) {
        console.error('Error canceling payment:', err);
      }
    }

    setProcessing(false);
    setStatus('idle');
    setStatusMessage('');
    setPaymentIntentId(null);
    setSetupIntentId(null);
    onCancel();
  };

  const onlineReaders = readers.filter(r => r.status === 'online');
  const offlineReaders = readers.filter(r => r.status !== 'online');

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-600 border-t-transparent" />
      </div>
    );
  }

  if (readers.length === 0) {
    return (
      <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className="flex items-center gap-3 mb-3">
          <span className="material-symbols-outlined text-amber-500">warning</span>
          <p className={`${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            No card readers found
          </p>
        </div>
        <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          You need to set up a Terminal reader in your Stripe Dashboard, or create a simulated reader for testing.
        </p>
        <button
          onClick={createSimulatedReader}
          disabled={creatingSimulated}
          className={`w-full py-2 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
            isDark 
              ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          } disabled:opacity-50`}
        >
          {creatingSimulated ? (
            <>
              <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
              Creating...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-lg">add</span>
              Create Simulated Reader (Testing)
            </>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {status === 'idle' && (
        <>
          <div>
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              Select Card Reader
            </label>
            <select
              value={selectedReader}
              onChange={(e) => setSelectedReader(e.target.value)}
              className={`w-full px-3 py-2.5 rounded-lg border ${
                isDark 
                  ? 'bg-white/5 border-white/20 text-white' 
                  : 'bg-white border-gray-300 text-gray-900'
              } focus:outline-none focus:ring-1 focus:ring-emerald-500`}
            >
              <option value="">Select a reader...</option>
              {onlineReaders.length > 0 && (
                <optgroup label="Online">
                  {onlineReaders.map(reader => (
                    <option key={reader.id} value={reader.id}>
                      {reader.label} ({reader.deviceType})
                    </option>
                  ))}
                </optgroup>
              )}
              {offlineReaders.length > 0 && (
                <optgroup label="Offline">
                  {offlineReaders.map(reader => (
                    <option key={reader.id} value={reader.id} disabled>
                      {reader.label} ({reader.deviceType}) - Offline
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {onlineReaders.length === 0 && (
            <div className={`p-3 rounded-lg flex items-start gap-2 ${
              isDark ? 'bg-amber-900/20 text-amber-400' : 'bg-amber-50 text-amber-700'
            }`}>
              <span className="material-symbols-outlined text-lg mt-0.5">info</span>
              <p className="text-sm">
                All readers are offline. Make sure your reader is powered on and connected.
              </p>
            </div>
          )}

          <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <div className="flex justify-between items-center">
              <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>
                {isSaveCard ? 'Action:' : 'Amount to charge:'}
              </span>
              <span className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {isSaveCard ? 'Save Card on File' : `$${(amount / 100).toFixed(2)}`}
              </span>
            </div>
          </div>

          <button
            onClick={handleProcessPayment}
            disabled={!selectedReader}
            className={`w-full py-3 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 ${
              isDark 
                ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <span className="material-symbols-outlined">contactless</span>
            {isSaveCard ? 'Save Card on Reader' : 'Collect Payment on Reader'}
          </button>
        </>
      )}

      {status === 'waiting' && (
        <div className={`p-6 rounded-lg text-center ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <div className="flex justify-center mb-4">
            <div className="relative">
              <span className="material-symbols-outlined text-5xl text-emerald-500 animate-pulse">
                contactless
              </span>
            </div>
          </div>
          <h3 className={`text-lg font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {isSaveCard ? 'Waiting for Card' : 'Waiting for Card'}
          </h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {statusMessage}
          </p>
          {!isSaveCard && (
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              Amount: <span className="font-semibold">${(amount / 100).toFixed(2)}</span>
            </p>
          )}
          <button
            onClick={handleCancelPayment}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Cancel
          </button>
        </div>
      )}

      {status === 'success' && (
        <div className={`p-6 rounded-lg text-center ${isDark ? 'bg-emerald-900/20' : 'bg-emerald-50'}`}>
          <div className="flex justify-center mb-4">
            <span className="material-symbols-outlined text-5xl text-emerald-500">
              check_circle
            </span>
          </div>
          <h3 className={`text-lg font-medium mb-2 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
            {isSaveCard ? 'Card Saved' : 'Payment Successful'}
          </h3>
          <p className={`text-sm mb-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {statusMessage}
          </p>
          <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Closing automatically...
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className={`p-6 rounded-lg text-center ${isDark ? 'bg-red-900/20' : 'bg-red-50'}`}>
          <div className="flex justify-center mb-4">
            <span className="material-symbols-outlined text-5xl text-red-500">
              error
            </span>
          </div>
          <h3 className={`text-lg font-medium mb-2 ${isDark ? 'text-red-400' : 'text-red-700'}`}>
            {isSaveCard ? 'Card Save Failed' : 'Payment Failed'}
          </h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {statusMessage}
          </p>
          <button
            onClick={() => {
              setStatus('idle');
              setStatusMessage('');
              setPaymentIntentId(null);
              setSetupIntentId(null);
            }}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              isDark 
                ? 'bg-white/10 text-white hover:bg-white/20' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
