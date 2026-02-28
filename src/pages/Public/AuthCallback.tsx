import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSupabase } from '../../lib/supabase';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';
import WalkingGolferSpinner from '../../components/WalkingGolferSpinner';

const AuthCallback: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const supabase = getSupabase();
        if (!supabase) {
          setError('Supabase is not configured');
          return;
        }
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          setError(error.message);
          return;
        }
        
        if (session) {
          try {
            const res = await fetch(`/api/auth/check-staff-admin?email=${encodeURIComponent(session.user.email || '')}`);
            if (res.ok) {
              const contentType = res.headers.get('Content-Type') || '';
              if (contentType.includes('application/json')) {
                try {
                  const data = await res.json();
                  if (data.isStaffOrAdmin) {
                    startNavigation();
                    navigate('/admin');
                    return;
                  }
                } catch (parseErr: unknown) {
                  console.error('Failed to parse staff/admin response');
                }
              }
            }
          } catch (err: unknown) {
            console.error('Failed to check staff/admin status');
          }
          const nfcRedirect = sessionStorage.getItem('nfc_checkin_redirect');
          if (nfcRedirect) {
            sessionStorage.removeItem('nfc_checkin_redirect');
            startNavigation();
            navigate('/nfc-checkin');
            return;
          }
          startNavigation();
          navigate('/dashboard');
        } else {
          startNavigation();
          navigate('/login');
        }
      } catch (err: unknown) {
        setError((err instanceof Error ? err.message : String(err)) || 'Authentication failed');
      }
    };

    handleCallback();
  }, [navigate]);

  if (error) {
    return (
      <div className="flex flex-col min-h-screen bg-bone dark:bg-[#293515] items-center justify-center">
        <div className="bg-white dark:bg-[#1a1d15] p-8 rounded-xl shadow-sm dark:shadow-none border border-black/5 dark:border-white/10 max-w-sm w-full mx-4">
          <div className="text-center">
            <span className="material-symbols-outlined text-red-500 text-4xl mb-4">error</span>
            <h2 className="text-2xl text-primary dark:text-white mb-2 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Authentication Failed</h2>
            <p className="text-primary/60 dark:text-white/60 mb-4">{error}</p>
            <button
              onClick={() => { startNavigation(); navigate('/login'); }}
              className="w-full py-3 px-4 bg-primary text-white rounded-[4px] font-bold hover:bg-primary/90 transition-all duration-fast"
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-bone dark:bg-[#293515] items-center justify-center">
      <div className="bg-white dark:bg-[#1a1d15] p-8 rounded-xl shadow-sm dark:shadow-none border border-black/5 dark:border-white/10 max-w-sm w-full mx-4">
        <div className="text-center">
          <WalkingGolferSpinner size="md" className="mx-auto mb-4" />
          <h2 className="text-2xl text-primary dark:text-white leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Signing you in...</h2>
          <p className="text-primary/60 dark:text-white/60 mt-2">Please wait</p>
        </div>
      </div>
    </div>
  );
};

export default AuthCallback;
