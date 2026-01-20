import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Footer } from '../../components/Footer';
import { usePageReady } from '../../contexts/PageReadyContext';

const DayPassSuccess: React.FC = () => {
  const navigate = useNavigate();
  const { setPageReady } = usePageReady();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');

  useEffect(() => {
    setPageReady(true);
  }, [setPageReady]);

  return (
    <div className="flex flex-col min-h-screen bg-[#F2F2EC] overflow-x-hidden">
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-black/5 max-w-md w-full text-center animate-pop-in">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-5xl text-green-600">check_circle</span>
          </div>
          
          <h1 className="text-2xl font-bold text-primary mb-3">Thank You!</h1>
          <p className="text-primary/70 mb-6">
            Your day pass purchase was successful.
          </p>

          <div className="bg-[#E8E8E0]/50 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-center gap-3 mb-3">
              <span className="material-symbols-outlined text-2xl text-primary">mail</span>
              <span className="font-bold text-primary">Check Your Email</span>
            </div>
            <p className="text-sm text-primary/70">
              We've sent a confirmation email with your QR code. Show this at the front desk when you arrive.
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => navigate('/')}
              className="w-full flex justify-center items-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-bold text-white shadow-md hover:bg-primary/90 transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">home</span>
              Back to Home
            </button>
            
            <button
              onClick={() => navigate('/day-pass')}
              className="w-full flex justify-center items-center gap-2 rounded-xl bg-white border border-primary/20 px-4 py-3.5 text-sm font-bold text-primary hover:bg-primary/5 transition-all"
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
