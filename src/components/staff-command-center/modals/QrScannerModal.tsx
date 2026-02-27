import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ModalShell from '../../ModalShell';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (decodedText: string) => void;
}

const QrScannerModal: React.FC<QrScannerModalProps> = ({ isOpen, onClose, onScanSuccess }) => {
  const qrScannerRef = useRef<{ getState: () => number; stop: () => Promise<void>; start: (cameraId: Record<string, string>, config: Record<string, unknown>, onSuccess: (text: string) => void, onError: (err: unknown) => void) => Promise<void> } | null>(null);
  const hasScannedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraPermission, setCameraPermission] = useState<'idle' | 'pending' | 'granted' | 'denied'>('idle');
  
  const elementId = useMemo(() => `qr-reader-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

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

  useEffect(() => {
    if (!isOpen) {
      stopScanner();
      setError(null);
      setCameraPermission('idle');
      hasScannedRef.current = false;
      return;
    }

    const startScanner = async () => {
      await stopScanner();
      
      const containerEl = document.getElementById(elementId);
      if (!containerEl) {
        setError('Scanner container not found');
        return;
      }

      setCameraPermission('pending');
      setError(null);
      hasScannedRef.current = false;

      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) {
          setError('No cameras found.');
          setCameraPermission('denied');
          return;
        }

        const qrScanner = new Html5Qrcode(elementId);
        qrScannerRef.current = qrScanner as unknown as typeof qrScannerRef.current;
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
              onScanSuccess(decodedText);
              stopScanner().then(() => onClose());
            }
          },
          () => {}
        );
      } catch (err: unknown) {
        setError(`Error accessing camera: ${(err instanceof Error ? err.message : String(err))}`);
        setCameraPermission('denied');
      }
    };

    const timeoutId = setTimeout(startScanner, 100);
    
    return () => {
      clearTimeout(timeoutId);
    };
  }, [isOpen, elementId, onScanSuccess, onClose, stopScanner]);

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, [stopScanner]);

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Scan Member QR Code" showCloseButton={true}>
      <div className="p-4">
        <div id={elementId} className="w-full rounded-lg overflow-hidden" style={{ minHeight: 300 }} />
        {cameraPermission === 'pending' && <p className="text-center mt-2">Requesting camera permission...</p>}
        {error && <p className="text-red-500 text-center mt-2">{error}</p>}
      </div>
    </ModalShell>
  );
};

export default QrScannerModal;
