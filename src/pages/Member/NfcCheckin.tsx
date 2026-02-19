import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../../contexts/DataContext';
import { playSound } from '../../utils/sounds';

type CheckinState = 'loading' | 'checking_in' | 'success' | 'already_checked_in' | 'not_logged_in' | 'error';

const NfcCheckin: React.FC = () => {
  const { user, sessionChecked } = useData();
  const navigate = useNavigate();
  const [state, setState] = useState<CheckinState>('loading');
  const [memberName, setMemberName] = useState('');
  const [tier, setTier] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const checkinAttemptedRef = useRef(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!sessionChecked) return;

    if (!user) {
      setState('not_logged_in');
      return;
    }

    if (checkinAttemptedRef.current) return;
    checkinAttemptedRef.current = true;

    setState('checking_in');

    fetch('/api/member/nfc-checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    })
      .then(async (res) => {
        const data = await res.json();
        if (res.ok && data.success) {
          setMemberName(data.memberName);
          setTier(data.tier);
          setState('success');
          playSound('checkinSuccess');
        } else if (data.alreadyCheckedIn) {
          setMemberName(data.memberName || user.firstName || '');
          setState('already_checked_in');
          playSound('tap');
        } else {
          setErrorMessage(data.error || 'Check-in failed');
          setState('error');
        }
      })
      .catch(() => {
        setErrorMessage('Unable to connect. Please try again.');
        setState('error');
      });
  }, [sessionChecked, user, retryCount]);

  const handleLoginRedirect = () => {
    const currentPath = window.location.pathname + window.location.search;
    sessionStorage.setItem('nfc_checkin_redirect', currentPath);
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {state === 'loading' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
              <span className="material-symbols-outlined text-4xl text-white/60">nfc</span>
            </div>
            <p className="text-white/60 text-sm">Loading...</p>
          </div>
        )}

        {state === 'checking_in' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
              <span className="material-symbols-outlined text-4xl text-white/60">nfc</span>
            </div>
            <p className="text-white/80 text-lg font-medium">Checking you in...</p>
            <p className="text-white/40 text-sm mt-1">Just a moment</p>
          </div>
        )}

        {state === 'success' && (
          <div className="rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-gradient-to-br from-primary via-primary/95 to-primary/85 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
                <span className="material-symbols-outlined text-4xl text-white">check_circle</span>
              </div>
              <h1 className="text-2xl font-bold text-white mb-1">Welcome, {memberName}!</h1>
              <p className="text-white/80 text-sm font-medium">You're checked in</p>
              {tier && (
                <div className="mt-3 inline-flex items-center px-3 py-1 rounded-full bg-white/15 text-white/90 text-xs font-semibold uppercase tracking-wider">
                  {tier}
                </div>
              )}
            </div>
            <div className="bg-white p-4 text-center">
              <p className="text-gray-500 text-sm">Enjoy your visit!</p>
            </div>
          </div>
        )}

        {state === 'already_checked_in' && (
          <div className="rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-gradient-to-br from-blue-600 via-blue-500 to-blue-700 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
                <span className="material-symbols-outlined text-4xl text-white">info</span>
              </div>
              <h1 className="text-2xl font-bold text-white mb-1">Already Checked In</h1>
              <p className="text-white/80 text-sm font-medium">
                {memberName ? `${memberName}, you` : 'You'} were already checked in just now
              </p>
            </div>
            <div className="bg-white p-4 text-center">
              <p className="text-gray-500 text-sm">No need to tap again</p>
            </div>
          </div>
        )}

        {state === 'not_logged_in' && (
          <div className="rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-gradient-to-br from-gray-700 via-gray-600 to-gray-800 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
                <span className="material-symbols-outlined text-4xl text-white">login</span>
              </div>
              <h1 className="text-xl font-bold text-white mb-2">Sign In to Check In</h1>
              <p className="text-white/70 text-sm mb-6">
                Please sign in to your account to complete NFC check-in
              </p>
              <button
                onClick={handleLoginRedirect}
                className="w-full py-3 px-6 rounded-xl bg-white text-gray-900 font-semibold text-sm hover:bg-white/90 transition-colors"
              >
                Sign In
              </button>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-gradient-to-br from-red-700 via-red-600 to-red-800 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4">
                <span className="material-symbols-outlined text-4xl text-yellow-300">warning</span>
              </div>
              <h1 className="text-xl font-bold text-white mb-2">Check-In Failed</h1>
              <p className="text-white/80 text-sm">{errorMessage}</p>
            </div>
            <div className="bg-white p-4 text-center">
              <button
                onClick={() => { checkinAttemptedRef.current = false; setState('loading'); setRetryCount(c => c + 1); }}
                className="text-primary font-medium text-sm hover:underline"
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NfcCheckin;
