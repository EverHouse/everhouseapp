import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ModalShell from '../../ModalShell';
import WalkingGolferSpinner from '../../WalkingGolferSpinner';

export interface SectionProps {
  onClose?: () => void;
  variant?: 'modal' | 'card';
  onBookGuest?: (guestInfo: { email: string; firstName: string; lastName: string }) => void;
  onRedemptionSuccess?: (redemption: { passHolder: PassHolder; remainingUses: number; productType: string; redeemedAt: string }) => void;
}

interface PassHolder {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  productType: string;
  totalUses: number;
}

interface RedemptionSuccess {
  passHolder: PassHolder;
  remainingUses: number;
  redeemedAt: string;
}

interface DayPass {
  id: string;
  productType: string;
  quantity: number;
  remainingUses: number;
  purchaserEmail: string;
  purchaserFirstName: string | null;
  purchaserLastName: string | null;
  purchasedAt: string;
}

export interface RedemptionLog {
  redeemedAt: string;
  redeemedBy: string;
  location: string | null;
}

interface PassDetails {
  email: string;
  name: string;
  productType: string;
  totalUses?: number;
  usedCount?: number;
  remainingUses?: number;
  lastRedemption?: string;
  redeemedTodayAt?: string;
  history?: RedemptionLog[];
}

interface ErrorState {
  message: string;
  errorCode: string;
  passDetails?: PassDetails;
}

export const formatPassType = (productType: string): string => {
  return productType
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace('Day Pass', 'Day Pass -');
};

interface UnredeemedPass {
  id: string;
  productType: string;
  quantity: number;
  remainingUses: number;
  purchaserEmail: string;
  purchaserFirstName: string | null;
  purchaserLastName: string | null;
  purchasedAt: string;
}

interface DayPassUpdateEvent {
  type: 'day_pass_update';
  action: 'day_pass_purchased' | 'day_pass_redeemed' | 'day_pass_refunded';
  passId: string;
  purchaserEmail?: string;
  purchaserName?: string;
  productType?: string;
  remainingUses?: number;
  quantity?: number;
  purchasedAt?: string;
}

const RedeemDayPassSection: React.FC<SectionProps> = ({ onClose, variant = 'modal', onBookGuest, onRedemptionSuccess }) => {
  const [searchEmail, setSearchEmail] = useState('');
  const [passes, setPasses] = useState<DayPass[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [redemptionSuccess, setRedemptionSuccess] = useState<RedemptionSuccess | null>(null);
  const [expandedPassId, setExpandedPassId] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<{ passId: string; logs: RedemptionLog[] }[]>([]);
  const [loadingHistoryId, setLoadingHistoryId] = useState<string | null>(null);
  const [showEmailSearch, setShowEmailSearch] = useState(true);
  const [confirmingRedeemAnyway, setConfirmingRedeemAnyway] = useState<string | null>(null);
  const [forceRedeeming, setForceRedeeming] = useState(false);
  const [manualPassId, setManualPassId] = useState('');
  const [showPassIdInput, setShowPassIdInput] = useState(false);
  const [lastAttemptedPassId, setLastAttemptedPassId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [cameraPermission, setCameraPermission] = useState<'idle' | 'pending' | 'granted' | 'denied'>('idle');
  const qrScannerRef = useRef<any>(null);
  const hasScannedRef = useRef(false);
  
  const [unredeemedPasses, setUnredeemedPasses] = useState<UnredeemedPass[]>([]);
  const [isLoadingUnredeemed, setIsLoadingUnredeemed] = useState(false);
  const [showUnredeemedSection, setShowUnredeemedSection] = useState(true);
  const previousPassesRef = useRef<UnredeemedPass[]>([]);
  const [confirmingRefundId, setConfirmingRefundId] = useState<string | null>(null);
  const [refundingId, setRefundingId] = useState<string | null>(null);
  
  const scannerElementId = useMemo(() => `qr-pass-reader-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

  const fetchUnredeemedPasses = useCallback(async () => {
    setIsLoadingUnredeemed(true);
    try {
      const res = await fetch('/api/staff/passes/unredeemed', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUnredeemedPasses(data.passes || []);
        previousPassesRef.current = data.passes || [];
      }
    } catch (err: unknown) {
      console.error('[RedeemPassCard] Error fetching unredeemed passes:', err);
    } finally {
      setIsLoadingUnredeemed(false);
    }
  }, []);

  useEffect(() => {
    fetchUnredeemedPasses();
  }, [fetchUnredeemedPasses]);

  useEffect(() => {
    const handleDayPassUpdate = (event: CustomEvent<DayPassUpdateEvent>) => {
      const { action, passId, purchaserEmail, purchaserName, productType, remainingUses, quantity, purchasedAt } = event.detail;
      
      if (action === 'day_pass_purchased') {
        const nameParts = purchaserName?.split(' ') || [];
        const newPass: UnredeemedPass = {
          id: passId,
          productType: productType || 'day-pass',
          quantity: quantity || 1,
          remainingUses: remainingUses ?? 1,
          purchaserEmail: purchaserEmail || '',
          purchaserFirstName: nameParts[0] || null,
          purchaserLastName: nameParts.slice(1).join(' ') || null,
          purchasedAt: purchasedAt || new Date().toISOString(),
        };
        setUnredeemedPasses(prev => [newPass, ...prev.filter(p => p.id !== passId)]);
      } else if (action === 'day_pass_redeemed') {
        setUnredeemedPasses(prev => {
          const updated = prev.map(pass => {
            if (pass.id === passId) {
              const newRemaining = remainingUses ?? pass.remainingUses - 1;
              return { ...pass, remainingUses: newRemaining };
            }
            return pass;
          });
          return updated.filter(pass => pass.remainingUses > 0);
        });
      } else if (action === 'day_pass_refunded') {
        setUnredeemedPasses(prev => prev.filter(pass => pass.id !== passId));
      }
    };

    window.addEventListener('day-pass-update', handleDayPassUpdate as EventListener);
    return () => {
      window.removeEventListener('day-pass-update', handleDayPassUpdate as EventListener);
    };
  }, []);

  const stopScanner = useCallback(async () => {
    if (qrScannerRef.current) {
      try {
        const { Html5QrcodeScannerState } = await import('html5-qrcode');
        const state = qrScannerRef.current.getState();
        if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
          await qrScannerRef.current.stop();
        }
      } catch (err: unknown) {
        console.error("[QrScanner] Failed to stop scanner:", err);
      } finally {
        qrScannerRef.current = null;
      }
    }
  }, []);

  const handleScanResult = useCallback((decodedText: string) => {
    let passId = decodedText.trim();
    if (passId.startsWith('PASS:')) {
      passId = passId.replace('PASS:', '');
    } else if (passId.startsWith('MEMBER:')) {
      setErrorState({
        message: 'This is a member QR code, not a day pass. Please scan a day pass QR code.',
        errorCode: 'INVALID_QR_TYPE'
      });
      return;
    }
    
    if (passId) {
      setShowEmailSearch(false);
      handleRedeem(passId);
    }
  }, []);

  useEffect(() => {
    if (!isScanning) {
      stopScanner();
      setScannerError(null);
      setCameraPermission('idle');
      hasScannedRef.current = false;
      return;
    }

    const startScanner = async () => {
      await stopScanner();
      
      const containerEl = document.getElementById(scannerElementId);
      if (!containerEl) {
        setScannerError('Scanner container not found');
        return;
      }

      setCameraPermission('pending');
      setScannerError(null);
      hasScannedRef.current = false;

      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) {
          setScannerError('No cameras found.');
          setCameraPermission('denied');
          return;
        }

        const qrScanner = new Html5Qrcode(scannerElementId);
        qrScannerRef.current = qrScanner;
        setCameraPermission('granted');

        await qrScanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            if (!hasScannedRef.current) {
              hasScannedRef.current = true;
              stopScanner().then(() => {
                setIsScanning(false);
                handleScanResult(decodedText);
              });
            }
          },
          () => {}
        );
      } catch (err: unknown) {
        setScannerError(`Error accessing camera: ${(err instanceof Error ? err.message : String(err))}`);
        setCameraPermission('denied');
      }
    };

    const timeoutId = setTimeout(startScanner, 100);
    
    return () => {
      clearTimeout(timeoutId);
    };
  }, [isScanning, scannerElementId, stopScanner, handleScanResult]);

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, [stopScanner]);

  const handleCloseScanner = () => {
    stopScanner();
    setIsScanning(false);
  };

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    
    setIsSearching(true);
    setErrorState(null);
    setSuccessMessage(null);
    
    try {
      const res = await fetch(`/api/staff/passes/search?email=${encodeURIComponent(searchEmail.trim())}`, {
        credentials: 'include'
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to search passes');
      }
      
      const data = await res.json();
      setPasses(data.passes || []);
      setHasSearched(true);
    } catch (err: unknown) {
      setErrorState({
        message: (err instanceof Error ? err.message : String(err)) || 'Failed to search passes',
        errorCode: 'SEARCH_ERROR'
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleRedeem = async (passId: string, force: boolean = false) => {
    setRedeemingId(passId);
    setErrorState(null);
    setSuccessMessage(null);
    setRedemptionSuccess(null);
    setLastAttemptedPassId(passId);
    if (force) setForceRedeeming(true);
    
    // Optimistic UI: save previous state and decrement immediately
    const previousUnredeemed = [...unredeemedPasses];
    setUnredeemedPasses(prev => {
      const updated = prev.map(pass => {
        if (pass.id === passId) {
          return { ...pass, remainingUses: pass.remainingUses - 1 };
        }
        return pass;
      });
      return updated.filter(pass => pass.remainingUses > 0);
    });
    
    try {
      const res = await fetch(`/api/staff/passes/${passId}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ force })
      });
      
      if (!res.ok) {
        const data = await res.json();
        // Rollback optimistic update on error
        setUnredeemedPasses(previousUnredeemed);
        setErrorState({
          message: data.error || 'Failed to redeem pass',
          errorCode: data.errorCode || 'UNKNOWN_ERROR',
          passDetails: data.passDetails
        });
        setConfirmingRedeemAnyway(null);
        return;
      }
      
      const data = await res.json();
      
      if (data.passHolder) {
        const successInfo: RedemptionSuccess = {
          passHolder: data.passHolder,
          remainingUses: data.remainingUses,
          redeemedAt: data.redeemedAt,
        };
        setRedemptionSuccess(successInfo);
        
        if (onRedemptionSuccess) {
          onRedemptionSuccess({
            passHolder: data.passHolder,
            remainingUses: data.remainingUses,
            productType: data.passHolder.productType,
            redeemedAt: data.redeemedAt,
          });
        }
      } else {
        setSuccessMessage(`Pass redeemed! ${data.remainingUses} uses remaining.`);
      }
      setConfirmingRedeemAnyway(null);
      
      if (hasSearched && searchEmail) {
        handleSearch();
      }
    } catch (err: unknown) {
      // Rollback optimistic update on network error
      setUnredeemedPasses(previousUnredeemed);
      setErrorState({
        message: (err instanceof Error ? err.message : String(err)) || 'Failed to redeem pass',
        errorCode: 'NETWORK_ERROR'
      });
    } finally {
      setRedeemingId(null);
      setForceRedeeming(false);
    }
  };

  const handleRefund = async (passId: string) => {
    setRefundingId(passId);
    setErrorState(null);
    
    const previousUnredeemed = [...unredeemedPasses];
    setUnredeemedPasses(prev => prev.filter(pass => pass.id !== passId));
    setConfirmingRefundId(null);
    
    try {
      const res = await fetch(`/api/staff/passes/${passId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      if (!res.ok) {
        const data = await res.json();
        setUnredeemedPasses(previousUnredeemed);
        setErrorState({
          message: data.error || 'Failed to refund pass',
          errorCode: data.errorCode || 'REFUND_ERROR',
        });
        return;
      }
      
      setSuccessMessage('Pass refunded successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: unknown) {
      setUnredeemedPasses(previousUnredeemed);
      setErrorState({
        message: (err instanceof Error ? err.message : String(err)) || 'Failed to refund pass',
        errorCode: 'NETWORK_ERROR'
      });
    } finally {
      setRefundingId(null);
    }
  };

  const handleScanQR = () => {
    setSuccessMessage(null);
    setErrorState(null);
    setIsScanning(true);
  };

  const handleManualPassIdSubmit = () => {
    if (manualPassId.trim()) {
      setShowEmailSearch(false);
      setShowPassIdInput(false);
      handleRedeem(manualPassId.trim());
      setManualPassId('');
    }
  };

  const handleViewHistory = async (passId: string) => {
    if (expandedPassId === passId) {
      setExpandedPassId(null);
      return;
    }

    const cached = historyData.find(h => h.passId === passId);
    if (cached) {
      setExpandedPassId(passId);
      return;
    }

    setLoadingHistoryId(passId);
    try {
      const res = await fetch(`/api/staff/passes/${passId}/history`, {
        credentials: 'include'
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch history');
      }
      
      const data = await res.json();
      setHistoryData(prev => [...prev, { passId, logs: data.logs || [] }]);
      setExpandedPassId(passId);
    } catch (err: unknown) {
      setErrorState({
        message: (err instanceof Error ? err.message : String(err)) || 'Failed to fetch history',
        errorCode: 'HISTORY_ERROR'
      });
    } finally {
      setLoadingHistoryId(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  };

  const formatDateTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles'
    });
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles'
    });
  };

  const getPassHistory = (passId: string) => {
    return historyData.find(h => h.passId === passId)?.logs || [];
  };

  const handleSearchByEmail = () => {
    setShowEmailSearch(true);
    setErrorState(null);
  };

  const handleSellNewPass = () => {
    const email = errorState?.passDetails?.email || searchEmail;
    window.open(`/#/buy-day-pass${email ? `?email=${encodeURIComponent(email)}` : ''}`, '_blank');
  };

  const handleProceedAnyway = (passId: string) => {
    setConfirmingRedeemAnyway(passId);
  };

  const clearErrorAndReset = () => {
    setErrorState(null);
    setShowEmailSearch(true);
    setConfirmingRedeemAnyway(null);
  };

  const renderErrorState = () => {
    if (!errorState) return null;

    const { errorCode, passDetails } = errorState;

    if (errorCode === 'PASS_NOT_FOUND') {
      return (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">search_off</span>
            <div className="flex-1">
              <p className="font-semibold text-amber-900 dark:text-amber-100">Pass not found or invalid</p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                The scanned QR code doesn't match any active day pass in our system.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={handleSearchByEmail}
              className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">mail</span>
              Search by email
            </button>
            <button
              onClick={handleSellNewPass}
              className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
              Sell new pass
            </button>
          </div>
        </div>
      );
    }

    if (errorCode === 'PASS_EXHAUSTED') {
      return (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">check_circle</span>
            <div className="flex-1">
              <p className="font-semibold text-amber-900 dark:text-amber-100">This pass has been fully redeemed</p>
              {passDetails && (
                <div className="mt-2 space-y-1">
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    <span className="font-medium">{passDetails.name || passDetails.email}</span>
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Used {passDetails.usedCount} of {passDetails.totalUses} times
                  </p>
                  {passDetails.lastRedemption && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Last used: {formatDateTime(passDetails.lastRedemption)}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={handleSellNewPass}
              className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
              Charge for new pass
            </button>
            <button
              onClick={clearErrorAndReset}
              className="tactile-btn px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">refresh</span>
              Start over
            </button>
          </div>
        </div>
      );
    }

    if (errorCode === 'ALREADY_REDEEMED_TODAY') {
      const confirmingThis = confirmingRedeemAnyway === 'current';
      return (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">schedule</span>
            <div className="flex-1">
              <p className="font-semibold text-amber-900 dark:text-amber-100">Already checked in today</p>
              {passDetails && (
                <div className="mt-2 space-y-1">
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    <span className="font-medium">{passDetails.name || passDetails.email}</span>
                  </p>
                  {passDetails.redeemedTodayAt && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Checked in at {formatTime(passDetails.redeemedTodayAt)}
                    </p>
                  )}
                  {passDetails.remainingUses !== undefined && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {passDetails.remainingUses} uses remaining on this pass
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          
          {!confirmingThis ? (
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={() => handleProceedAnyway('current')}
                className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg">warning</span>
                Redeem anyway
              </button>
              <button
                onClick={clearErrorAndReset}
                className="tactile-btn px-4 py-2.5 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-sm hover:bg-primary/20 dark:hover:bg-white/20 transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg">close</span>
                Cancel
              </button>
            </div>
          ) : (
            <div className="pt-2 space-y-3">
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800/40">
                <p className="text-sm text-red-800 dark:text-red-200 font-medium">
                  Are you sure? This will use another redemption from this pass.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (lastAttemptedPassId) handleRedeem(lastAttemptedPassId, true);
                  }}
                  disabled={forceRedeeming || !lastAttemptedPassId}
                  className="tactile-btn flex-1 px-4 py-2.5 rounded-lg bg-red-500 text-white font-medium text-sm hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {forceRedeeming ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  ) : (
                    <span className="material-symbols-outlined text-lg">check</span>
                  )}
                  Yes, redeem again
                </button>
                <button
                  onClick={() => setConfirmingRedeemAnyway(null)}
                  className="tactile-btn px-4 py-2.5 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-sm hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (errorCode === 'PASS_NOT_ACTIVE') {
      return (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 space-y-3">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl text-red-600 dark:text-red-400">block</span>
            <div className="flex-1">
              <p className="font-semibold text-red-900 dark:text-red-100">Pass is no longer active</p>
              {passDetails && (
                <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                  This pass for {passDetails.name || passDetails.email} has been deactivated.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={handleSellNewPass}
              className="tactile-btn flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
              Sell new pass
            </button>
            <button
              onClick={clearErrorAndReset}
              className="tactile-btn px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-800/40 text-red-900 dark:text-red-100 font-medium text-sm hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">refresh</span>
              Start over
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 space-y-3">
        <div className="flex items-start gap-2">
          <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
          <p className="text-sm text-red-700 dark:text-red-400">{errorState.message}</p>
        </div>
        <button
          onClick={clearErrorAndReset}
          className="tactile-btn w-full px-4 py-2 rounded-lg bg-red-100 dark:bg-red-800/40 text-red-900 dark:text-red-100 font-medium text-sm hover:bg-red-200 dark:hover:bg-red-800/60 transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-lg">refresh</span>
          Try again
        </button>
      </div>
    );
  };

  const content = (
    <div className="space-y-4">
      {isScanning && (
        <ModalShell isOpen={isScanning} title="Scan Guest Pass" onClose={handleCloseScanner} showCloseButton={true}>
          <div className="p-4">
            <div id={scannerElementId} className="w-full rounded-lg overflow-hidden" style={{ minHeight: 300 }} />
            {cameraPermission === 'pending' && (
              <p className="text-center text-sm text-primary/60 dark:text-white/60 mt-4">Requesting camera permission...</p>
            )}
            {scannerError && (
              <p className="text-red-500 text-center mt-2">{scannerError}</p>
            )}
            {cameraPermission === 'granted' && (
              <p className="text-center text-sm text-primary/60 dark:text-white/60 mt-4">
                Center the QR code within the frame to scan
              </p>
            )}
            <button
              onClick={() => {
                handleCloseScanner();
                setShowPassIdInput(true);
              }}
              className="tactile-btn w-full mt-4 py-3 rounded-xl bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium hover:bg-primary/20 dark:hover:bg-white/20 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">keyboard</span>
              Enter Pass ID manually
            </button>
          </div>
        </ModalShell>
      )}

      {showEmailSearch && !showPassIdInput && (
        <div className="flex gap-2 w-full min-w-0">
          <input
            type="email"
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Enter visitor email..."
            className="min-w-0 flex-1 px-3 py-3 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          />
          <button
            onClick={handleSearch}
            disabled={!searchEmail.trim() || isSearching}
            className="tactile-btn shrink-0 px-3 py-3 rounded-xl bg-teal-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSearching ? (
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
            ) : (
              <span className="material-symbols-outlined text-lg">search</span>
            )}
          </button>
          <button
            onClick={handleScanQR}
            className="tactile-btn shrink-0 px-3 py-3 rounded-xl bg-teal-600 text-white font-semibold flex items-center gap-2 hover:bg-teal-700 transition-colors"
            title="Scan QR / Enter Pass ID"
          >
            <span className="material-symbols-outlined text-lg">qr_code_scanner</span>
          </button>
        </div>
      )}

      {showPassIdInput && (
        <div className="p-4 rounded-xl bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-800/30 space-y-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
            <p className="font-medium text-teal-900 dark:text-teal-100">Enter Pass ID</p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={manualPassId}
              onChange={(e) => setManualPassId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManualPassIdSubmit()}
              placeholder="Enter or scan Pass ID..."
              className="flex-1 px-4 py-3 rounded-xl bg-white dark:bg-black/20 border border-teal-200 dark:border-teal-700 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-teal-400"
              autoFocus
            />
            <button
              onClick={handleManualPassIdSubmit}
              disabled={!manualPassId.trim() || redeemingId !== null}
              className="tactile-btn px-4 py-3 rounded-xl bg-teal-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {redeemingId !== null ? (
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              ) : (
                <span className="material-symbols-outlined text-lg">check</span>
              )}
            </button>
            <button
              onClick={() => {
                setShowPassIdInput(false);
                setManualPassId('');
              }}
              className="tactile-btn px-4 py-3 rounded-xl bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-semibold hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </div>
      )}

      {renderErrorState()}

      {successMessage && !redemptionSuccess && (
        <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 flex items-center gap-2">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
          <p className="text-sm text-green-700 dark:text-green-400">{successMessage}</p>
        </div>
      )}

      {redemptionSuccess && (
        <div className="p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 space-y-4 animate-modal-slide-up">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-12 h-12 rounded-full bg-green-100 dark:bg-green-800/40 flex items-center justify-center">
              <span className="material-symbols-outlined text-2xl text-green-600 dark:text-green-400">check_circle</span>
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-green-900 dark:text-green-100 text-lg">Guest Checked In!</h3>
              <p className="text-sm text-green-700 dark:text-green-300 mt-0.5">
                Confirmation email sent with WiFi details
              </p>
            </div>
          </div>
          
          <div className="bg-white dark:bg-black/20 rounded-xl p-4 border border-green-200 dark:border-green-700/30">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary dark:text-white">person</span>
              </div>
              <div>
                <p className="font-medium text-primary dark:text-white">{redemptionSuccess.passHolder.name || 'Guest'}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{redemptionSuccess.passHolder.email}</p>
              </div>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">{formatPassType(redemptionSuccess.passHolder.productType)}</span>
              <span className="font-medium text-primary dark:text-white">
                {redemptionSuccess.remainingUses} {redemptionSuccess.remainingUses === 1 ? 'use' : 'uses'} remaining
              </span>
            </div>
          </div>
          
          <div className="flex gap-2">
            {onBookGuest && (
              <button
                onClick={() => {
                  onBookGuest({
                    email: redemptionSuccess.passHolder.email,
                    firstName: redemptionSuccess.passHolder.firstName,
                    lastName: redemptionSuccess.passHolder.lastName,
                  });
                  setRedemptionSuccess(null);
                  if (onClose) onClose();
                }}
                className="flex-1 py-3 px-4 rounded-xl bg-primary text-white font-medium hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-lg">golf_course</span>
                Book Golf for Guest
              </button>
            )}
            <button
              onClick={() => {
                setRedemptionSuccess(null);
                setSuccessMessage(null);
                setSearchEmail('');
                setPasses([]);
                setHasSearched(false);
              }}
              className={`${onBookGuest ? 'px-4' : 'flex-1'} py-3 rounded-xl bg-green-100 dark:bg-green-800/40 text-green-900 dark:text-green-100 font-medium hover:bg-green-200 dark:hover:bg-green-800/60 transition-colors flex items-center justify-center gap-2`}
            >
              <span className="material-symbols-outlined text-lg">done</span>
              Done
            </button>
          </div>
        </div>
      )}

      {!errorState && !hasSearched ? (
        <div className="text-center py-8">
          <span className="material-symbols-outlined text-4xl text-primary/30 dark:text-white/30 mb-2">qr_code_scanner</span>
          <p className="text-sm text-primary/60 dark:text-white/60">Search by email or scan QR to find passes</p>
        </div>
      ) : !errorState && passes.length === 0 && hasSearched ? (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 space-y-3">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-2xl text-amber-600 dark:text-amber-400">search_off</span>
            <div className="flex-1">
              <p className="font-semibold text-amber-900 dark:text-amber-100">No active passes found</p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                No passes with remaining uses found for {searchEmail}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={handleSellNewPass}
              className="flex-1 min-w-[140px] px-4 py-2.5 rounded-lg bg-teal-500 text-white font-medium text-sm hover:bg-teal-600 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">add_shopping_cart</span>
              Sell new pass
            </button>
            <button
              onClick={() => {
                setSearchEmail('');
                setHasSearched(false);
                setPasses([]);
              }}
              className="px-4 py-2.5 rounded-lg bg-amber-100 dark:bg-amber-800/40 text-amber-900 dark:text-amber-100 font-medium text-sm hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-lg">refresh</span>
              Search again
            </button>
          </div>
        </div>
      ) : !errorState && passes.length > 0 ? (
        <div className="space-y-3 max-h-[350px] overflow-y-auto">
          {passes.map(pass => (
            <div
              key={pass.id}
              className="p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-primary dark:text-white">
                    {formatPassType(pass.productType)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 text-xs font-medium bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 rounded-full">
                      {pass.remainingUses} {pass.remainingUses === 1 ? 'use' : 'uses'} remaining
                    </span>
                  </div>
                  <p className="text-xs text-primary/60 dark:text-white/60 mt-2">
                    Purchased: {formatDate(pass.purchasedAt)}
                  </p>
                  {(pass.purchaserFirstName || pass.purchaserLastName) && (
                    <p className="text-xs text-primary/60 dark:text-white/60">
                      {[pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' ')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleViewHistory(pass.id)}
                    disabled={loadingHistoryId === pass.id}
                    className="px-3 py-2 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium text-sm hover:bg-primary/20 dark:hover:bg-white/20 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {loadingHistoryId === pass.id ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary dark:border-white border-t-transparent" />
                    ) : (
                      <span className="material-symbols-outlined text-base">
                        {expandedPassId === pass.id ? 'expand_less' : 'history'}
                      </span>
                    )}
                    History
                  </button>
                  <button
                    onClick={() => handleRedeem(pass.id)}
                    disabled={redeemingId === pass.id}
                    className="px-4 py-2 rounded-lg bg-teal-500 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {redeemingId === pass.id ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    ) : (
                      <span className="material-symbols-outlined text-base">check</span>
                    )}
                    Redeem
                  </button>
                </div>
              </div>
              
              {expandedPassId === pass.id && (
                <div className="mt-3 pt-3 border-t border-primary/10 dark:border-white/10">
                  {getPassHistory(pass.id).length === 0 ? (
                    <p className="text-sm text-primary/50 dark:text-white/50 text-center py-2">
                      No redemptions yet
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {getPassHistory(pass.id).map((log, idx) => (
                        <div 
                          key={idx} 
                          className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-primary/5 dark:bg-white/5"
                        >
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-sm text-primary/60 dark:text-white/60">schedule</span>
                            <span className="text-xs text-primary dark:text-white">
                              {formatDateTime(log.redeemedAt)}
                            </span>
                          </div>
                          <span className="text-xs text-primary/70 dark:text-white/70">
                            {log.redeemedBy}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      
      {/* Unredeemed Passes Section */}
      {showUnredeemedSection && (
        <div className="mt-6 pt-4 border-t border-primary/10 dark:border-white/10">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">local_activity</span>
              <h4 className="font-semibold text-primary dark:text-white">Recent Unredeemed Passes</h4>
              {unredeemedPasses.length > 0 && (
                <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded-full">
                  {unredeemedPasses.length}
                </span>
              )}
            </div>
            <button
              onClick={() => setShowUnredeemedSection(false)}
              className="p-1.5 hover:bg-primary/10 dark:hover:bg-white/10 rounded-lg transition-colors"
              title="Hide section"
            >
              <span className="material-symbols-outlined text-sm text-primary/40 dark:text-white/40">close</span>
            </button>
          </div>
          
          {isLoadingUnredeemed ? (
            <div className="flex items-center justify-center py-6">
              <WalkingGolferSpinner size="sm" variant="dark" />
            </div>
          ) : unredeemedPasses.length === 0 ? (
            <div className="text-center py-6">
              <span className="material-symbols-outlined text-3xl text-primary/20 dark:text-white/20 mb-2">local_activity</span>
              <p className="text-sm text-primary/50 dark:text-white/50">No unredeemed passes</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {unredeemedPasses.map(pass => {
                const guestName = [pass.purchaserFirstName, pass.purchaserLastName].filter(Boolean).join(' ');
                return (
                  <div
                    key={pass.id}
                    className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-primary/10 dark:border-white/10 flex items-center justify-between gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm text-primary dark:text-white truncate">
                          {guestName || pass.purchaserEmail}
                        </p>
                        <span className="px-2 py-0.5 text-xs font-medium bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300 rounded-full flex-shrink-0">
                          {pass.remainingUses} left
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                          {formatPassType(pass.productType)}
                        </p>
                        <span className="text-xs text-primary/40 dark:text-white/40">•</span>
                        <p className="text-xs text-primary/40 dark:text-white/40 flex-shrink-0">
                          {formatDate(pass.purchasedAt)}
                        </p>
                      </div>
                      {guestName && (
                        <p className="text-xs text-primary/40 dark:text-white/40 truncate">{pass.purchaserEmail}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {confirmingRefundId === pass.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleRefund(pass.id)}
                            disabled={refundingId === pass.id}
                            className="px-2 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                          >
                            {refundingId === pass.id ? (
                              <div className="animate-spin rounded-full h-3 w-3 border-2 border-white border-t-transparent" />
                            ) : (
                              <span className="material-symbols-outlined text-sm">check</span>
                            )}
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmingRefundId(null)}
                            className="px-2 py-1.5 rounded-lg bg-primary/10 dark:bg-white/10 text-primary dark:text-white text-xs font-medium"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => setConfirmingRefundId(pass.id)}
                            disabled={redeemingId === pass.id || refundingId === pass.id}
                            className="px-2 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                            title="Refund this pass"
                          >
                            <span className="material-symbols-outlined text-sm">undo</span>
                            Refund
                          </button>
                          <button
                            onClick={() => handleRedeem(pass.id)}
                            disabled={redeemingId === pass.id}
                            className="px-3 py-1.5 rounded-lg bg-teal-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                          >
                            {redeemingId === pass.id ? (
                              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                            ) : (
                              <span className="material-symbols-outlined text-base">check</span>
                            )}
                            Redeem
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-2xl p-5 shadow-liquid dark:shadow-liquid-dark overflow-hidden">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-2xl p-4 shadow-liquid dark:shadow-liquid-dark">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

export default RedeemDayPassSection;
