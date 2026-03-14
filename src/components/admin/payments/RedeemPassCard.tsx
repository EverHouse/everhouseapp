import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ModalShell from '../../ModalShell';
import { haptic } from '../../../utils/haptics';
import { formatDatePacific, formatDateTimePacific, formatTimePacific } from '../../../utils/dateUtils';
import PassErrorState from './redeemPass/PassErrorState';
import RedemptionSuccessCard from './redeemPass/RedemptionSuccessCard';
import UnredeemedPassesList from './redeemPass/UnredeemedPassesList';
import PassSearchResults from './redeemPass/PassSearchResults';
import { formatPassType } from './redeemPass/types';
import type { SectionProps, RedemptionSuccess, DayPass, RedemptionLog, ErrorState, UnredeemedPass, DayPassUpdateEvent } from './redeemPass/types';

export type { SectionProps, RedemptionLog };
// eslint-disable-next-line react-refresh/only-export-components
export { formatPassType };

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  useEffect(() => { fetchUnredeemedPasses(); }, [fetchUnredeemedPasses]);

  useEffect(() => {
    const handleDayPassUpdate = (event: CustomEvent<DayPassUpdateEvent>) => {
      const { action, passId, purchaserEmail, purchaserName, productType, remainingUses, quantity, purchasedAt } = event.detail;
      if (action === 'day_pass_purchased') {
        const nameParts = purchaserName?.split(' ') || [];
        const newPass: UnredeemedPass = {
          id: passId, productType: productType || 'day-pass', quantity: quantity || 1,
          remainingUses: remainingUses ?? 1, purchaserEmail: purchaserEmail || '',
          purchaserFirstName: nameParts[0] || null, purchaserLastName: nameParts.slice(1).join(' ') || null,
          purchasedAt: purchasedAt || new Date().toISOString(),
        };
        setUnredeemedPasses(prev => [newPass, ...prev.filter(p => p.id !== passId)]);
      } else if (action === 'day_pass_redeemed') {
        setUnredeemedPasses(prev => {
          const updated = prev.map(pass => {
            if (pass.id === passId) {
              return { ...pass, remainingUses: remainingUses ?? pass.remainingUses - 1 };
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
    return () => { window.removeEventListener('day-pass-update', handleDayPassUpdate as EventListener); };
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
      setErrorState({ message: 'This is a member QR code, not a day pass. Please scan a day pass QR code.', errorCode: 'INVALID_QR_TYPE' });
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
      if (!containerEl) { setScannerError('Scanner container not found'); return; }
      setCameraPermission('pending');
      setScannerError(null);
      hasScannedRef.current = false;
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) { setScannerError('No cameras found.'); setCameraPermission('denied'); return; }
        const qrScanner = new Html5Qrcode(scannerElementId);
        qrScannerRef.current = qrScanner;
        setCameraPermission('granted');
        await qrScanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
          (decodedText) => {
            if (!hasScannedRef.current) {
              hasScannedRef.current = true;
              stopScanner().then(() => { setIsScanning(false); handleScanResult(decodedText); });
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
    return () => { clearTimeout(timeoutId); };
  }, [isScanning, scannerElementId, stopScanner, handleScanResult]);

  useEffect(() => { return () => { stopScanner(); }; }, [stopScanner]);

  const handleCloseScanner = () => { stopScanner(); setIsScanning(false); };

  const handleSearch = async () => {
    if (!searchEmail.trim()) return;
    setIsSearching(true);
    setErrorState(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`/api/staff/passes/search?email=${encodeURIComponent(searchEmail.trim())}`, { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to search passes');
      }
      const data = await res.json();
      setPasses(data.passes || []);
      setHasSearched(true);
    } catch (err: unknown) {
      setErrorState({ message: (err instanceof Error ? err.message : String(err)) || 'Failed to search passes', errorCode: 'SEARCH_ERROR' });
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
    const previousUnredeemed = [...unredeemedPasses];
    setUnredeemedPasses(prev => {
      const updated = prev.map(pass => pass.id === passId ? { ...pass, remainingUses: pass.remainingUses - 1 } : pass);
      return updated.filter(pass => pass.remainingUses > 0);
    });
    try {
      const res = await fetch(`/api/staff/passes/${passId}/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ force })
      });
      if (!res.ok) {
        const data = await res.json();
        setUnredeemedPasses(previousUnredeemed);
        setErrorState({ message: data.error || 'Failed to redeem pass', errorCode: data.errorCode || 'UNKNOWN_ERROR', passDetails: data.passDetails });
        setConfirmingRedeemAnyway(null);
        return;
      }
      const data = await res.json();
      haptic.success();
      if (data.passHolder) {
        const successInfo: RedemptionSuccess = { passHolder: data.passHolder, remainingUses: data.remainingUses, redeemedAt: data.redeemedAt };
        setRedemptionSuccess(successInfo);
        if (onRedemptionSuccess) {
          onRedemptionSuccess({ passHolder: data.passHolder, remainingUses: data.remainingUses, productType: data.passHolder.productType, redeemedAt: data.redeemedAt });
        }
      } else {
        setSuccessMessage(`Pass redeemed! ${data.remainingUses} uses remaining.`);
      }
      setConfirmingRedeemAnyway(null);
      if (hasSearched && searchEmail) { handleSearch(); }
    } catch (err: unknown) {
      setUnredeemedPasses(previousUnredeemed);
      setErrorState({ message: (err instanceof Error ? err.message : String(err)) || 'Failed to redeem pass', errorCode: 'NETWORK_ERROR' });
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        setUnredeemedPasses(previousUnredeemed);
        setErrorState({ message: data.error || 'Failed to refund pass', errorCode: data.errorCode || 'REFUND_ERROR' });
        return;
      }
      haptic.success();
      setSuccessMessage('Pass refunded successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: unknown) {
      setUnredeemedPasses(previousUnredeemed);
      setErrorState({ message: (err instanceof Error ? err.message : String(err)) || 'Failed to refund pass', errorCode: 'NETWORK_ERROR' });
    } finally {
      setRefundingId(null);
    }
  };

  const handleScanQR = () => { setSuccessMessage(null); setErrorState(null); setIsScanning(true); };

  const handleManualPassIdSubmit = () => {
    if (manualPassId.trim()) {
      setShowEmailSearch(false);
      setShowPassIdInput(false);
      handleRedeem(manualPassId.trim());
      setManualPassId('');
    }
  };

  const handleViewHistory = async (passId: string) => {
    if (expandedPassId === passId) { setExpandedPassId(null); return; }
    const cached = historyData.find(h => h.passId === passId);
    if (cached) { setExpandedPassId(passId); return; }
    setLoadingHistoryId(passId);
    try {
      const res = await fetch(`/api/staff/passes/${passId}/history`, { credentials: 'include' });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Failed to fetch history'); }
      const data = await res.json();
      setHistoryData(prev => [...prev, { passId, logs: data.logs || [] }]);
      setExpandedPassId(passId);
    } catch (err: unknown) {
      setErrorState({ message: (err instanceof Error ? err.message : String(err)) || 'Failed to fetch history', errorCode: 'HISTORY_ERROR' });
    } finally {
      setLoadingHistoryId(null);
    }
  };

  const formatDate = formatDatePacific;
  const formatDateTime = formatDateTimePacific;
  const formatTime = formatTimePacific;
  const getPassHistory = (passId: string) => historyData.find(h => h.passId === passId)?.logs || [];
  const handleSearchByEmail = () => { setShowEmailSearch(true); setErrorState(null); };
  const handleSellNewPass = () => {
    const email = errorState?.passDetails?.email || searchEmail;
    window.open(`/checkout${email ? `?email=${encodeURIComponent(email)}` : ''}`, '_blank');
  };
  const handleProceedAnyway = (passId: string) => { setConfirmingRedeemAnyway(passId); };
  const clearErrorAndReset = () => { setErrorState(null); setShowEmailSearch(true); setConfirmingRedeemAnyway(null); };
  const handleRedemptionSuccessReset = () => {
    setRedemptionSuccess(null); setSuccessMessage(null); setSearchEmail(''); setPasses([]); setHasSearched(false);
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
              onClick={() => { handleCloseScanner(); setShowPassIdInput(true); }}
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
            aria-label="Search visitor"
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
            aria-label="Scan QR code"
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
              aria-label="Submit pass ID"
              className="tactile-btn px-4 py-3 rounded-xl bg-teal-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {redeemingId !== null ? (
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              ) : (
                <span className="material-symbols-outlined text-lg">check</span>
              )}
            </button>
            <button
              onClick={() => { setShowPassIdInput(false); setManualPassId(''); }}
              className="tactile-btn px-4 py-3 rounded-xl bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-semibold hover:bg-primary/20 dark:hover:bg-white/20 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </div>
      )}

      {errorState && (
        <PassErrorState
          errorState={errorState}
          confirmingRedeemAnyway={confirmingRedeemAnyway}
          forceRedeeming={forceRedeeming}
          lastAttemptedPassId={lastAttemptedPassId}
          formatDateTime={formatDateTime}
          formatTime={formatTime}
          handleSearchByEmail={handleSearchByEmail}
          handleSellNewPass={handleSellNewPass}
          handleProceedAnyway={handleProceedAnyway}
          clearErrorAndReset={clearErrorAndReset}
          handleRedeem={handleRedeem}
          setConfirmingRedeemAnyway={setConfirmingRedeemAnyway}
        />
      )}

      {successMessage && !redemptionSuccess && (
        <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 flex items-center gap-2">
          <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
          <p className="text-sm text-green-700 dark:text-green-400">{successMessage}</p>
        </div>
      )}

      {redemptionSuccess && (
        <RedemptionSuccessCard
          redemptionSuccess={redemptionSuccess}
          onBookGuest={onBookGuest}
          onClose={onClose}
          onReset={handleRedemptionSuccessReset}
        />
      )}

      <PassSearchResults
        passes={passes}
        hasSearched={hasSearched}
        searchEmail={searchEmail}
        redeemingId={redeemingId}
        expandedPassId={expandedPassId}
        loadingHistoryId={loadingHistoryId}
        errorState={!!errorState}
        formatDate={formatDate}
        formatDateTime={formatDateTime}
        handleRedeem={handleRedeem}
        handleViewHistory={handleViewHistory}
        handleSellNewPass={handleSellNewPass}
        getPassHistory={getPassHistory}
        onClearSearch={() => { setSearchEmail(''); setHasSearched(false); setPasses([]); }}
      />

      <UnredeemedPassesList
        unredeemedPasses={unredeemedPasses}
        isLoadingUnredeemed={isLoadingUnredeemed}
        showUnredeemedSection={showUnredeemedSection}
        confirmingRefundId={confirmingRefundId}
        refundingId={refundingId}
        redeemingId={redeemingId}
        formatDate={formatDate}
        handleRedeem={handleRedeem}
        handleRefund={handleRefund}
        setConfirmingRefundId={setConfirmingRefundId}
        setShowUnredeemedSection={setShowUnredeemedSection}
      />
    </div>
  );

  if (variant === 'card') {
    return (
      <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-5 shadow-liquid dark:shadow-liquid-dark overflow-hidden">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className="bg-white/40 dark:bg-white/[0.08] backdrop-blur-xl border border-white/60 dark:border-white/[0.12] rounded-xl p-4 shadow-liquid dark:shadow-liquid-dark">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-teal-600 dark:text-teal-400">qr_code_scanner</span>
          <h3 className="font-bold text-primary dark:text-white">Redeem Day Pass</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-primary/10 dark:hover:bg-white/10 rounded-full" aria-label="Close">
          <span className="material-symbols-outlined text-primary/60 dark:text-white/60">close</span>
        </button>
      </div>
      {content}
    </div>
  );
};

export default RedeemDayPassSection;
