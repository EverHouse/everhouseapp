import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface IdScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanComplete: (data: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    streetAddress: string;
    city: string;
    state: string;
    zipCode: string;
    imageBase64: string;
    imageMimeType: string;
  }) => void;
  isDark: boolean;
}

type ScannerState = 'choose' | 'camera' | 'review' | 'scanning' | 'results';

interface ScanResult {
  data: {
    firstName: string | null;
    lastName: string | null;
    dateOfBirth: string | null;
    streetAddress: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
  };
  quality: {
    isReadable: boolean;
    qualityIssues: string[];
  };
}

const QUALITY_ISSUE_LABELS: Record<string, string> = {
  too_blurry: 'Image is too blurry',
  too_dark: 'Image is too dark',
  too_far: 'ID is too far from camera',
  glare: 'Glare detected on the ID',
  partially_obscured: 'Part of the ID is obscured',
};

const IdScannerModal: React.FC<IdScannerModalProps> = ({ isOpen, onClose, onScanComplete, isDark }) => {
  const [state, setState] = useState<ScannerState>('choose');
  const [imageBase64, setImageBase64] = useState<string>('');
  const [imageMimeType, setImageMimeType] = useState<string>('image/jpeg');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [editedData, setEditedData] = useState<ScanResult['data']>({
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    streetAddress: null,
    city: null,
    state: null,
    zipCode: null,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const resetState = useCallback(() => {
    stopCamera();
    setState('choose');
    setImageBase64('');
    setImageMimeType('image/jpeg');
    setScanResult(null);
    setError(null);
    setCameraError(null);
  }, [stopCamera]);

  useEffect(() => {
    if (!isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const startCamera = useCallback(async () => {
    setState('camera');
    setCameraError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraError('Camera permission was denied. Please allow camera access in your browser settings and try again.');
      } else if (err.name === 'NotFoundError') {
        setCameraError('No camera found on this device.');
      } else {
        setCameraError(`Could not access camera: ${err.message}`);
      }
    }
  }, []);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];

    stopCamera();
    setImageBase64(base64);
    setImageMimeType('image/jpeg');
    setState('review');
  }, [stopCamera]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';

      setImageBase64(base64);
      setImageMimeType(mime);
      setState('review');
    };
    reader.readAsDataURL(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleScanId = useCallback(async () => {
    setState('scanning');
    setError(null);

    try {
      const res = await fetch('/api/admin/scan-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image: imageBase64, mimeType: imageMimeType }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to scan ID');
      }

      const result = await res.json();
      setScanResult(result);
      setEditedData(result.data);
      setState('results');
    } catch (err: any) {
      setError(err.message || 'Failed to scan ID');
      setState('review');
    }
  }, [imageBase64, imageMimeType]);

  const handleRetake = useCallback(() => {
    setImageBase64('');
    setScanResult(null);
    setError(null);
    setState('choose');
  }, []);

  const handleUseInfo = useCallback(() => {
    if (!editedData) return;

    onScanComplete({
      firstName: editedData.firstName || '',
      lastName: editedData.lastName || '',
      dateOfBirth: editedData.dateOfBirth || '',
      streetAddress: editedData.streetAddress || '',
      city: editedData.city || '',
      state: editedData.state || '',
      zipCode: editedData.zipCode || '',
      imageBase64,
      imageMimeType,
    });
  }, [editedData, imageBase64, imageMimeType, onScanComplete]);

  const handleClose = useCallback(() => {
    stopCamera();
    onClose();
  }, [stopCamera, onClose]);

  if (!isOpen) return null;

  const bgClass = isDark ? 'bg-[#1a1d15]' : 'bg-white';
  const textClass = isDark ? 'text-white' : 'text-gray-900';
  const subtextClass = isDark ? 'text-gray-400' : 'text-gray-500';
  const borderClass = isDark ? 'border-white/10' : 'border-gray-200';
  const cardClass = isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200';

  const modalContent = (
    <div
      className={`fixed inset-0 ${isDark ? 'dark' : ''}`}
      style={{ zIndex: 10050, overscrollBehavior: 'contain', touchAction: 'none' }}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
        onClick={handleClose}
      />

      <div className="fixed inset-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex min-h-full items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="ID Scanner"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-lg ${bgClass} rounded-2xl shadow-2xl border ${borderClass}`}
          >
            <div className={`flex items-center justify-between p-4 border-b ${borderClass}`}>
              <h3 className={`text-xl font-bold ${textClass}`}>
                <span className="material-symbols-outlined text-emerald-600 mr-2 align-middle">badge</span>
                Scan ID
              </h3>
              <button
                onClick={handleClose}
                className={`p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition-colors ${
                  isDark ? 'hover:bg-white/10 text-gray-300' : 'hover:bg-gray-100 text-gray-600'
                }`}
                aria-label="Close modal"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <div className="p-4 overflow-y-auto max-h-[80dvh]" style={{ WebkitOverflowScrolling: 'touch' }}>
              {state === 'choose' && (
                <div className="space-y-3">
                  <p className={`text-sm ${subtextClass} text-center mb-4`}>
                    Scan a driver's license or ID card to auto-fill member information.
                  </p>
                  <button
                    onClick={startCamera}
                    className={`w-full flex items-center gap-3 p-4 rounded-xl border transition-colors ${
                      isDark
                        ? 'border-white/10 hover:bg-white/5'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="w-12 h-12 rounded-full bg-emerald-600/10 flex items-center justify-center">
                      <span className="material-symbols-outlined text-emerald-600 text-2xl">photo_camera</span>
                    </div>
                    <div className="text-left">
                      <div className={`font-medium ${textClass}`}>Use Camera</div>
                      <div className={`text-sm ${subtextClass}`}>Take a photo of the ID</div>
                    </div>
                    <span className={`material-symbols-outlined ml-auto ${subtextClass}`}>chevron_right</span>
                  </button>

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={`w-full flex items-center gap-3 p-4 rounded-xl border transition-colors ${
                      isDark
                        ? 'border-white/10 hover:bg-white/5'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="w-12 h-12 rounded-full bg-emerald-600/10 flex items-center justify-center">
                      <span className="material-symbols-outlined text-emerald-600 text-2xl">upload_file</span>
                    </div>
                    <div className="text-left">
                      <div className={`font-medium ${textClass}`}>Upload Photo</div>
                      <div className={`text-sm ${subtextClass}`}>Select an image from your device</div>
                    </div>
                    <span className={`material-symbols-outlined ml-auto ${subtextClass}`}>chevron_right</span>
                  </button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </div>
              )}

              {state === 'camera' && (
                <div className="space-y-4">
                  {cameraError ? (
                    <div className={`p-4 rounded-xl border ${isDark ? 'bg-red-900/20 border-red-700 text-red-400' : 'bg-red-50 border-red-200 text-red-700'}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="material-symbols-outlined">videocam_off</span>
                        <span className="font-medium">Camera Unavailable</span>
                      </div>
                      <p className="text-sm">{cameraError}</p>
                    </div>
                  ) : (
                    <div className="relative rounded-xl overflow-hidden bg-black">
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full"
                        style={{ minHeight: 280 }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div
                          className="border-2 border-dashed border-white/70 rounded-lg"
                          style={{
                            width: '80%',
                            aspectRatio: '1.586 / 1',
                            maxHeight: '70%',
                            boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
                          }}
                        />
                      </div>
                      <div className="absolute bottom-16 left-0 right-0 text-center">
                        <span className="text-white/80 text-sm font-medium bg-black/40 px-3 py-1 rounded-full">
                          Position ID within frame
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-center gap-4">
                    <button
                      onClick={() => { stopCamera(); setState('choose'); }}
                      className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        isDark
                          ? 'bg-white/10 hover:bg-white/15 text-white'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      }`}
                    >
                      Cancel
                    </button>
                    {!cameraError && (
                      <button
                        onClick={capturePhoto}
                        className="w-16 h-16 rounded-full border-4 border-white bg-white/20 hover:bg-white/30 transition-colors flex items-center justify-center shadow-lg"
                        aria-label="Capture photo"
                      >
                        <div className="w-12 h-12 rounded-full bg-white" />
                      </button>
                    )}
                  </div>
                </div>
              )}

              {state === 'review' && (
                <div className="space-y-4">
                  <div className="rounded-xl overflow-hidden border border-white/10">
                    <img
                      src={`data:${imageMimeType};base64,${imageBase64}`}
                      alt="Captured ID"
                      className="w-full object-contain max-h-64"
                    />
                  </div>

                  {error && (
                    <div className={`p-3 rounded-lg ${isDark ? 'bg-red-900/20 border border-red-700 text-red-400' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-lg">error</span>
                        <span className="text-sm">{error}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      onClick={handleRetake}
                      className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition-colors ${
                        isDark
                          ? 'bg-white/10 hover:bg-white/15 text-white'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm mr-1 align-middle">refresh</span>
                      Retake
                    </button>
                    <button
                      onClick={handleScanId}
                      className="flex-1 py-2.5 px-4 rounded-xl text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm mr-1 align-middle">document_scanner</span>
                      Scan ID
                    </button>
                  </div>
                </div>
              )}

              {state === 'scanning' && (
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <div className="w-12 h-12 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                  <p className={`text-sm font-medium ${textClass}`}>Scanning ID document...</p>
                  <p className={`text-xs ${subtextClass}`}>This may take a few seconds</p>
                </div>
              )}

              {state === 'results' && scanResult && (
                <div className="space-y-4">
                  {!scanResult.quality.isReadable && (
                    <div className={`p-4 rounded-xl border ${isDark ? 'bg-amber-900/20 border-amber-700' : 'bg-amber-50 border-amber-200'}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`material-symbols-outlined ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>warning</span>
                        <span className={`font-medium text-sm ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>Quality Issues Detected</span>
                      </div>
                      <ul className={`text-sm space-y-1 ml-7 ${isDark ? 'text-amber-300/80' : 'text-amber-600'}`}>
                        {scanResult.quality.qualityIssues.map((issue) => (
                          <li key={issue}>{QUALITY_ISSUE_LABELS[issue] || issue}</li>
                        ))}
                      </ul>
                      <button
                        onClick={handleRetake}
                        className={`mt-3 w-full py-2 rounded-lg text-sm font-medium transition-colors ${
                          isDark
                            ? 'bg-amber-600 hover:bg-amber-500 text-white'
                            : 'bg-amber-500 hover:bg-amber-600 text-white'
                        }`}
                      >
                        <span className="material-symbols-outlined text-sm mr-1 align-middle">refresh</span>
                        Retake Photo
                      </button>
                    </div>
                  )}

                  <div className={`rounded-xl border p-4 space-y-4 ${cardClass}`}>
                    <h4 className={`font-medium text-sm ${textClass} flex items-center gap-2`}>
                      <span className="material-symbols-outlined text-emerald-600 text-lg">person</span>
                      Extracted Information
                    </h4>
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        {[
                          { label: 'First Name', key: 'firstName' },
                          { label: 'Last Name', key: 'lastName' },
                          { label: 'Date of Birth', key: 'dateOfBirth' },
                          { label: 'State', key: 'state' },
                        ].map(({ label, key }) => (
                          <div key={key}>
                            <label className={`text-xs ${subtextClass} block mb-1.5`}>{label}</label>
                            <input
                              type="text"
                              value={editedData[key as keyof ScanResult['data']] || ''}
                              onChange={(e) => setEditedData({
                                ...editedData,
                                [key]: e.target.value || null,
                              })}
                              className={`w-full px-2.5 py-2 rounded-lg border text-sm transition-colors ${
                                isDark
                                  ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-white/20 focus:outline-none'
                                  : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-300 focus:outline-none'
                              }`}
                              placeholder="Not detected"
                            />
                          </div>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <div>
                          <label className={`text-xs ${subtextClass} block mb-1.5`}>Street Address</label>
                          <input
                            type="text"
                            value={editedData.streetAddress || ''}
                            onChange={(e) => setEditedData({
                              ...editedData,
                              streetAddress: e.target.value || null,
                            })}
                            className={`w-full px-2.5 py-2 rounded-lg border text-sm transition-colors ${
                              isDark
                                ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-white/20 focus:outline-none'
                                : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-300 focus:outline-none'
                            }`}
                            placeholder="Not detected"
                          />
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          {[
                            { label: 'City', key: 'city' },
                            { label: 'State', key: 'state' },
                            { label: 'Zip Code', key: 'zipCode' },
                          ].map(({ label, key }) => (
                            <div key={key}>
                              <label className={`text-xs ${subtextClass} block mb-1.5`}>{label}</label>
                              <input
                                type="text"
                                value={editedData[key as keyof ScanResult['data']] || ''}
                                onChange={(e) => setEditedData({
                                  ...editedData,
                                  [key]: e.target.value || null,
                                })}
                                className={`w-full px-2.5 py-2 rounded-lg border text-sm transition-colors ${
                                  isDark
                                    ? 'bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-white/20 focus:outline-none'
                                    : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-300 focus:outline-none'
                                }`}
                                placeholder="Not detected"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={handleRetake}
                      className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition-colors ${
                        isDark
                          ? 'bg-white/10 hover:bg-white/15 text-white'
                          : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      }`}
                    >
                      Retake
                    </button>
                    <button
                      onClick={handleUseInfo}
                      className="flex-1 py-2.5 px-4 rounded-xl text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm mr-1 align-middle">check</span>
                      Use This Info
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default IdScannerModal;
