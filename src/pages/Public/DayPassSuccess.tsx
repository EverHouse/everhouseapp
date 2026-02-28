import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { usePageReady } from '../../contexts/PageReadyContext';
import { useNavigationLoading } from '../../contexts/NavigationLoadingContext';

const DayPassSuccess: React.FC = () => {
  const navigate = useNavigate();
  const { startNavigation } = useNavigationLoading();
  const { setPageReady } = usePageReady();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  return (
    <div className="flex flex-col min-h-screen bg-bone dark:bg-[#141414] overflow-x-hidden">
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="bg-white dark:bg-[#1a1d15] rounded-xl p-8 shadow-sm dark:shadow-none border border-black/5 dark:border-white/10 max-w-md w-full text-center animate-pop-in">
          <div className="w-20 h-20 bg-green-100 dark:bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-5xl text-green-600 dark:text-green-400">check_circle</span>
          </div>
          
          <h1 className="text-2xl text-primary dark:text-white mb-3 leading-tight" style={{ fontFamily: 'var(--font-headline)' }}>Thank You!</h1>
          <p className="text-primary/70 dark:text-white/70 mb-6">
            Your day pass purchase was successful.
          </p>

          <div className="bg-[#E8E8E0]/50 dark:bg-white/5 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-center gap-3 mb-3">
              <span className="material-symbols-outlined text-2xl text-primary dark:text-white">mail</span>
              <span className="font-bold text-primary dark:text-white">Check Your Email</span>
            </div>
            <p className="text-sm text-primary/70 dark:text-white/70">
              We've sent a confirmation email with your QR code. Show this at the front desk when you arrive.
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => { startNavigation(); navigate('/'); }}
              className="tactile-btn w-full flex justify-center items-center gap-2 rounded-[4px] bg-primary px-4 py-3.5 text-sm font-bold text-white shadow-md hover:bg-primary/90 transition-all duration-fast"
            >
              <span className="material-symbols-outlined text-[18px]">home</span>
              Back to Home
            </button>
            
            <button
              onClick={() => { startNavigation(); navigate('/day-pass'); }}
              className="tactile-btn w-full flex justify-center items-center gap-2 rounded-xl bg-white dark:bg-white/5 border border-primary/20 dark:border-white/10 px-4 py-3.5 text-sm font-bold text-primary dark:text-white hover:bg-primary/5 dark:hover:bg-white/10 transition-all duration-fast"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Buy Another Pass
            </button>
          </div>
        </div>
      </div>
      
      <Footer />
    </div>
  );
};

export default DayPassSuccess;
