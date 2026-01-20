import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';
import ModalShell from '../../ModalShell';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (decodedText: string) => void;
}

const QrScannerModal: React.FC<QrScannerModalProps> = ({ isOpen, onClose, onScanSuccess }) => {
  const scannerRef = useRef<HTMLDivElement>(null);
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraPermission, setCameraPermission] = useState<'idle' | 'pending' | 'granted' | 'denied'>('idle');

  useEffect(() => {
    if (isOpen && scannerRef.current && !qrScannerRef.current) {
      const qrScanner = new Html5Qrcode(scannerRef.current.id);
      qrScannerRef.current = qrScanner;

      const startScanner = async () => {
        setCameraPermission('pending');
        try {
          const cameras = await Html5Qrcode.getCameras();
          if (cameras && cameras.length > 0) {
            setCameraPermission('granted');
            qrScanner.start(
              { facingMode: 'environment' },
              {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0,
              },
              (decodedText, _decodedResult) => {
                onScanSuccess(decodedText);
                onClose();
              },
              (_errorMessage) => {
                // handle scan error if needed
              }
            ).catch(err => {
              setError(`Failed to start scanner: ${err.message}`);
              setCameraPermission('denied');
            });
          } else {
            setError('No cameras found.');
            setCameraPermission('denied');
          }
        } catch (err: any) {
          setError(`Error accessing camera: ${err.message}`);
          setCameraPermission('denied');
        }
      };

      startScanner();
    }

    return () => {
      if (qrScannerRef.current && qrScannerRef.current.getState() === Html5QrcodeScannerState.SCANNING) {
        qrScannerRef.current.stop().catch(err => console.error("Failed to stop scanner", err));
        qrScannerRef.current = null;
      }
    };
  }, [isOpen, onScanSuccess, onClose]);

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} title="Scan Member QR Code" showCloseButton={true}>
      <div className="p-4">
        <div id="qr-reader" ref={scannerRef} className="w-full rounded-lg overflow-hidden" />
        {cameraPermission === 'pending' && <p className="text-center mt-2">Requesting camera permission...</p>}
        {error && <p className="text-red-500 text-center mt-2">{error}</p>}
      </div>
    </ModalShell>
  );
};

export default QrScannerModal;
