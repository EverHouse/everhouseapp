import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthData } from '../../contexts/DataContext';
import { parseQrCode } from '../../utils/qrCodeParser';
import Icon from '../../components/icons/Icon';

interface Html5QrcodeInstance {
  getState(): number;
  stop(): Promise<void>;
  start(
    camera: { facingMode: string },
    config: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number },
    onSuccess: (decodedText: string) => void,
    onFailure: () => void
  ): Promise<null | void>;
}

type KioskState = 'scanning' | 'processing' | 'success' | 'already_checked_in' | 'error' | 'exiting';

interface CheckinResult {
  memberName: string;
  tier: string | null;
  lifetimeVisits: number;
}

const RESET_DELAY_SUCCESS = 4000;
const RESET_DELAY_ERROR = 3000;
const EXIT_HOLD_DURATION = 3000;

const KioskCheckin: React.FC = () => {
  const { actualUser, sessionChecked } = useAuthData();
  const navigate = useNavigate();
  const [state, setState] = useState<KioskState>('scanning');
  const [checkinResult, setCheckinResult] = useState<CheckinResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [exitProgress, setExitProgress] = useState(0);

  const qrScannerRef = useRef<Html5QrcodeInstance | null>(null);
  const hasScannedRef = useRef(false);
  const exitIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const elementId = useMemo(() => `kiosk-qr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

  const isStaff = actualUser?.role === 'admin' || actualUser?.role === 'staff';

  const stopScanner = useCallback(async () => {
    if (qrScannerRef.current) {
      try {
        const { Html5QrcodeScannerState } = await import('html5-qrcode');
        const scannerState = qrScannerRef.current.getState();
        if (scannerState === Html5QrcodeScannerState.SCANNING || scannerState === Html5QrcodeScannerState.PAUSED) {
          await qrScannerRef.current.stop();
        }
      } catch (err: unknown) {
        console.error("[Kiosk] Failed to stop scanner:", err);
      } finally {
        qrScannerRef.current = null;
      }
    }
  }, []);

  const startScanner = useCallback(async () => {
    await stopScanner();
    hasScannedRef.current = false;
    setCameraError(null);

    const containerEl = document.getElementById(elementId);
    if (!containerEl) return;

    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) {
        setCameraError('No cameras found. Please connect a camera.');
        return;
      }

      const qrScanner = new Html5Qrcode(elementId);
      qrScannerRef.current = qrScanner;

      await qrScanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 280, height: 280 },
          aspectRatio: 1.0,
        },
        (decodedText) => {
          if (!hasScannedRef.current) {
            hasScannedRef.current = true;
            handleScan(decodedText);
          }
        },
        () => {}
      );
    } catch (err: unknown) {
      setCameraError(`Camera error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [elementId, stopScanner]);

  const handleScan = useCallback(async (decodedText: string) => {
    const parsed = parseQrCode(decodedText);
    if (parsed.type !== 'member' || !parsed.memberId) {
      setErrorMessage('Invalid QR code. Please use your membership card QR code.');
      setState('error');
      return;
    }

    setState('processing');

    try {
      const res = await fetch('/api/kiosk/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ memberId: parsed.memberId })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setCheckinResult({
          memberName: data.memberName,
          tier: data.tier,
          lifetimeVisits: data.lifetimeVisits
        });
        setState('success');
      } else if (data.alreadyCheckedIn) {
        setCheckinResult({
          memberName: data.memberName || '',
          tier: data.tier || null,
          lifetimeVisits: 0
        });
        setState('already_checked_in');
      } else if (res.status === 401 || res.status === 403) {
        stopScanner();
        navigate('/login', { replace: true });
        return;
      } else {
        setErrorMessage(data.error || 'Check-in failed. Please ask staff for help.');
        setState('error');
      }
    } catch {
      setErrorMessage('Connection error. Please try again.');
      setState('error');
    }
  }, [navigate, stopScanner]);

  const resetToScanning = useCallback(() => {
    setState('scanning');
    setCheckinResult(null);
    setErrorMessage('');
    hasScannedRef.current = false;
    setTimeout(() => startScanner(), 300);
  }, [startScanner]);

  useEffect(() => {
    if (state === 'success' || state === 'already_checked_in') {
      stopScanner();
      resetTimerRef.current = setTimeout(resetToScanning, RESET_DELAY_SUCCESS);
    } else if (state === 'error') {
      stopScanner();
      resetTimerRef.current = setTimeout(resetToScanning, RESET_DELAY_ERROR);
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [state, stopScanner, resetToScanning]);

  const verifyStaffSession = useCallback(async () => {
    try {
      const res = await fetch('/api/kiosk/verify-staff', { credentials: 'include' });
      if (!res.ok) {
        stopScanner();
        navigate('/login', { replace: true });
      }
    } catch {
      stopScanner();
      navigate('/login', { replace: true });
    }
  }, [navigate, stopScanner]);

  useEffect(() => {
    if (!sessionChecked) return;
    if (!isStaff) {
      navigate('/login', { replace: true });
      return;
    }
    verifyStaffSession();
    verifyIntervalRef.current = setInterval(verifyStaffSession, 5 * 60 * 1000);
    if (state === 'scanning') {
      const timer = setTimeout(() => startScanner(), 500);
      return () => {
        clearTimeout(timer);
        if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current);
      };
    }
    return () => {
      if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current);
    };
  }, [sessionChecked, isStaff, navigate, verifyStaffSession]);

  useEffect(() => {
    return () => {
      stopScanner();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (exitIntervalRef.current) clearInterval(exitIntervalRef.current);
      if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current);
    };
  }, [stopScanner]);

  const handleExitStart = useCallback(() => {
    setExitProgress(0);
    const startTime = Date.now();
    exitIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / EXIT_HOLD_DURATION, 1);
      setExitProgress(progress);
      if (progress >= 1) {
        if (exitIntervalRef.current) clearInterval(exitIntervalRef.current);
        setState('exiting');
        stopScanner().then(() => navigate('/admin', { replace: true }));
      }
    }, 50);
  }, [navigate, stopScanner]);

  const handleExitEnd = useCallback(() => {
    if (exitIntervalRef.current) {
      clearInterval(exitIntervalRef.current);
      exitIntervalRef.current = null;
    }
    setExitProgress(0);
  }, []);

  if (!sessionChecked) {
    return (
      <div className="fixed inset-0 bg-gray-950 flex items-center justify-center">
        <div className="w-12 h-12 rounded-full border-4 border-white/20 border-t-white animate-spin" />
      </div>
    );
  }

  if (!isStaff) return null;

  return (
    <div className="fixed inset-0 bg-gray-950 flex flex-col select-none" style={{ touchAction: 'none' }}>
      <div className="absolute top-4 right-4 z-50">
        <button
          onMouseDown={handleExitStart}
          onMouseUp={handleExitEnd}
          onMouseLeave={handleExitEnd}
          onTouchStart={handleExitStart}
          onTouchEnd={handleExitEnd}
          onTouchCancel={handleExitEnd}
          className="relative w-12 h-12 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          aria-label="Hold to exit kiosk mode"
        >
          <Icon name="close" className="text-white/30 text-lg" />
          {exitProgress > 0 && (
            <svg className="absolute inset-0 w-12 h-12 -rotate-90" viewBox="0 0 48 48">
              <circle
                cx="24" cy="24" r="20"
                fill="none"
                stroke="rgba(255,255,255,0.6)"
                strokeWidth="3"
                strokeDasharray={`${exitProgress * 125.6} 125.6`}
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {state === 'scanning' && (
          <div className="w-full max-w-md flex flex-col items-center animate-in fade-in duration-300">
            <div className="mb-8 text-center">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 flex items-center justify-center mx-auto mb-4">
                <Icon name="qr_code_scanner" className="text-5xl text-emerald-400" />
              </div>
              <h1 className="text-3xl font-bold text-white tracking-tight">Welcome</h1>
              <p className="text-white/50 mt-2 text-lg">Scan your membership QR code to check in</p>
            </div>

            <div className="w-full max-w-sm relative rounded-2xl overflow-hidden bg-black/50 border border-white/10">
              <div id={elementId} className="w-full" style={{ minHeight: 350 }} />
              {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
                  <div className="text-center">
                    <Icon name="photo_camera" className="text-4xl text-red-400 mb-3" />
                    <p className="text-red-300 text-sm">{cameraError}</p>
                    <button
                      onClick={() => startScanner()}
                      className="mt-4 px-4 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>

            <p className="text-white/30 text-xs mt-6">Open your membership card and hold the QR code up to the camera</p>
          </div>
        )}

        {state === 'processing' && (
          <div className="text-center animate-in fade-in duration-200">
            <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-6">
              <div className="w-10 h-10 rounded-full border-4 border-white/20 border-t-emerald-400 animate-spin" />
            </div>
            <h2 className="text-2xl font-bold text-white">Checking you in...</h2>
            <p className="text-white/40 mt-2">Just a moment</p>
          </div>
        )}

        {state === 'success' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="w-24 h-24 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="check_circle" className="text-6xl text-emerald-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2">Welcome back!</h2>
            <p className="text-emerald-400 text-2xl font-semibold">{checkinResult.memberName}</p>
            {checkinResult.tier && (
              <span className="inline-block mt-3 px-4 py-1.5 rounded-full bg-white/10 text-white/70 text-sm font-medium">
                {checkinResult.tier}
              </span>
            )}
            {checkinResult.lifetimeVisits > 0 && (
              <p className="text-white/40 text-sm mt-4">
                Visit #{checkinResult.lifetimeVisits}
              </p>
            )}
          </div>
        )}

        {state === 'already_checked_in' && checkinResult && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="w-24 h-24 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="check_circle" className="text-6xl text-amber-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2">Already Checked In</h2>
            {checkinResult.memberName && (
              <p className="text-amber-400 text-2xl font-semibold">{checkinResult.memberName}</p>
            )}
            <p className="text-white/40 text-sm mt-4">You were recently checked in</p>
          </div>
        )}

        {state === 'error' && (
          <div className="text-center animate-in fade-in zoom-in-95 duration-300">
            <div className="w-24 h-24 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-6">
              <Icon name="warning" className="text-6xl text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Check-In Issue</h2>
            <p className="text-red-300 text-lg">{errorMessage}</p>
            <p className="text-white/30 text-sm mt-4">Please ask staff for assistance</p>
          </div>
        )}

        {state === 'exiting' && (
          <div className="text-center animate-in fade-in duration-200">
            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-4">
              <div className="w-8 h-8 rounded-full border-3 border-white/20 border-t-white animate-spin" />
            </div>
            <p className="text-white/60">Exiting kiosk mode...</p>
          </div>
        )}
      </div>

      <div className="pb-6 text-center">
        <p className="text-white/20 text-xs">Kiosk Self-Service Check-In</p>
      </div>
    </div>
  );
};

export default KioskCheckin;
