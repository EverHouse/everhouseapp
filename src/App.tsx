
import React, { useState, useEffect, ErrorInfo, useMemo, useRef, lazy, Suspense, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { BrowserRouter, Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { QueryClientProvider, useQueryClient, useQuery } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { DataProvider, useAuthData, useAnnouncementData } from './contexts/DataContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import DirectionalPageTransition, { TransitionContext, PageExitContext } from './components/motion/DirectionalPageTransition';
import Logo from './components/Logo';
import MenuOverlay from './components/MenuOverlay';
import MemberMenuOverlay from './components/MemberMenuOverlay';
const ViewAsBanner = lazy(() => import('./components/ViewAsBanner'));
import PageErrorBoundary from './components/PageErrorBoundary';
import Avatar from './components/Avatar';
import { ToastProvider } from './components/Toast';
import OfflineBanner from './components/OfflineBanner';
import { NotificationContext } from './contexts/NotificationContext';
import { BottomSentinel } from './components/layout/BottomSentinel';
import MemberBottomNav from './components/MemberBottomNav';
import { useNavigationLoading } from './stores/navigationLoadingStore';
import WalkingGolferLoader from './components/WalkingGolferLoader';
import { useNotificationSounds } from './hooks/useNotificationSounds';
import { useNotificationStore } from './stores/notificationStore';
import { useKeyboardDetection } from './hooks/useKeyboardDetection';
import { useWebSocket } from './hooks/useWebSocket';
import { useSupabaseRealtime } from './hooks/useSupabaseRealtime';
import UpdateNotification from './components/UpdateNotification';
import WaiverModal from './components/WaiverModal';
import { fetchWithCredentials } from './hooks/queries/useFetch';
import PullToRefresh from './components/PullToRefresh';

const MINIMUM_LOADER_DISPLAY_MS = 2000;

const isInitialLandingLoad = () => {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === '/';
};

const InitialLoadingScreen: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [shouldShowLoader] = React.useState(() => {
    if (typeof window !== 'undefined') {
      const ptrFlag = sessionStorage.getItem('ptr-reload');
      if (ptrFlag) {
        return true;
      }
    }
    return isInitialLandingLoad();
  });

  React.useEffect(() => {
    if (shouldShowLoader) {
      sessionStorage.removeItem('ptr-reload');
    }
  }, []);
  const [showLoader, setShowLoader] = React.useState(shouldShowLoader);
  const [hasHiddenLoader, setHasHiddenLoader] = React.useState(!shouldShowLoader);

  React.useEffect(() => {
    if (!shouldShowLoader) return;

    const minTimer = setTimeout(() => {
      setShowLoader(false);
    }, MINIMUM_LOADER_DISPLAY_MS);

    return () => clearTimeout(minTimer);
  }, [shouldShowLoader]);

  const handleFadeComplete = () => {
    setHasHiddenLoader(true);
  };

  return (
    <>
      {!hasHiddenLoader && (
        <WalkingGolferLoader 
          isVisible={showLoader} 
          onFadeComplete={handleFadeComplete} 
        />
      )}
      {children}
    </>
  );
};

const PageSkeleton: React.FC = () => (
  <div className="px-6 pt-4 animate-pulse min-h-screen bg-[#F2F2EC] dark:bg-[#293515]">
    <div className="h-8 w-48 bg-white/10 rounded-lg mb-2" />
    <div className="h-4 w-32 bg-white/5 rounded mb-6" />
    <div className="space-y-4">
      <div className="h-24 bg-white/5 rounded-xl" />
      <div className="h-24 bg-white/5 rounded-xl" />
      <div className="h-24 bg-white/5 rounded-xl" />
    </div>
  </div>
);

const lazyWithPrefetch = (importFn: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) => {
  const Component = lazy(importFn);
  (Component as unknown as { prefetch: typeof importFn }).prefetch = importFn;
  return Component;
};

const Dashboard = lazy(() => import('./pages/Member/Dashboard'));
const BookGolf = lazyWithPrefetch(() => import('./pages/Member/BookGolf'));
const MemberEvents = lazyWithPrefetch(() => import('./pages/Member/Events'));
const MemberWellness = lazyWithPrefetch(() => import('./pages/Member/Wellness'));
const Profile = lazyWithPrefetch(() => import('./pages/Member/Profile'));
const MemberUpdates = lazyWithPrefetch(() => import('./pages/Member/Updates'));
const MemberHistory = lazyWithPrefetch(() => import('./pages/Member/History'));
const NfcCheckin = lazy(() => import('./pages/Member/NfcCheckin'));
const KioskCheckin = lazy(() => import('./pages/Staff/KioskCheckin'));
const Landing = lazy(() => import('./pages/Public/Landing'));
const Membership = lazy(() => import('./pages/Public/Membership'));
const Contact = lazy(() => import('./pages/Public/Contact'));
const Gallery = lazy(() => import('./pages/Public/Gallery'));
const WhatsOn = lazy(() => import('./pages/Public/WhatsOn'));
const PrivateHire = lazy(() => import('./pages/Public/PrivateHire'));
const PrivateHireInquire = lazy(() => import('./pages/Public/PrivateHireInquire'));
const MembershipApply = lazy(() => import('./pages/Public/MembershipApply'));
const PublicCafe = lazy(() => import('./pages/Public/Cafe'));
const FAQ = lazy(() => import('./pages/Public/FAQ'));
const About = lazy(() => import('./pages/Public/About'));
const BuyDayPass = lazy(() => import('./pages/Public/BuyDayPass'));
const DayPassSuccess = lazy(() => import('./pages/Public/DayPassSuccess'));
const BookTour = lazy(() => import('./pages/Public/BookTour'));
const PrivacyPolicy = lazy(() => import('./pages/Public/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/Public/TermsOfService'));
const Login = lazy(() => import('./pages/Public/Login'));
const AuthCallback = lazy(() => import('./pages/Public/AuthCallback'));
const AdminDashboard = lazy(() => import('./pages/Admin/AdminDashboard'));
const DataIntegrity = lazy(() => import('./pages/Admin/DataIntegrity'));
const Checkout = lazy(() => import('./pages/Checkout'));

const StaffCommandCenter = lazy(() => import('./components/staff-command-center/StaffCommandCenter'));
const StaffBookingToast = lazy(() => import('./components/StaffBookingToast').then(m => ({ default: m.StaffBookingToast })));
const StaffWebSocketProvider = lazy(() => import('./contexts/StaffWebSocketContext').then(m => ({ default: m.StaffWebSocketProvider })));
const StaffMobileSidebar = lazy(() => import('./components/StaffMobileSidebar').then(m => ({ default: m.StaffMobileSidebar })));
const SimulatorTab = lazy(() => import('./pages/Admin/tabs/SimulatorTab'));
const DirectoryTab = lazy(() => import('./pages/Admin/tabs/DirectoryTab'));
const EventsTab = lazy(() => import('./pages/Admin/tabs/EventsTab'));
const BlocksTab = lazy(() => import('./pages/Admin/tabs/BlocksTab'));
const UpdatesTab = lazy(() => import('./pages/Admin/tabs/UpdatesTab'));
const AnnouncementsTab = lazy(() => import('./pages/Admin/tabs/AnnouncementsTab'));
const TeamTab = lazy(() => import('./pages/Admin/tabs/TeamTab'));
const TiersTab = lazy(() => import('./pages/Admin/tabs/TiersTab'));
const TrackmanTab = lazy(() => import('./pages/Admin/tabs/TrackmanTab'));
const DataIntegrityTab = lazy(() => import('./pages/Admin/tabs/DataIntegrityTab'));
const FinancialsTab = lazy(() => import('./pages/Admin/tabs/FinancialsTab'));
const GalleryAdmin = lazy(() => import('./pages/Admin/GalleryAdmin'));
const FaqsAdmin = lazy(() => import('./pages/Admin/FaqsAdmin'));
const InquiriesAdmin = lazy(() => import('./pages/Admin/InquiriesAdmin'));
const ApplicationPipeline = lazy(() => import('./pages/Admin/ApplicationPipeline'));
const BugReportsAdmin = lazy(() => import('./pages/Admin/BugReportsAdmin'));
const SettingsTab = lazy(() => import('./pages/Admin/tabs/SettingsTab'));
const ChangelogTab = lazy(() => import('./pages/Admin/tabs/ChangelogTab'));
const ToursTab = lazy(() => import('./pages/Admin/tabs/ToursTab'));
const EmailTemplatesTab = lazy(() => import('./pages/Admin/tabs/EmailTemplatesTab'));
const AnalyticsTab = lazy(() => import('./pages/Admin/tabs/AnalyticsTab'));

import { prefetchOnIdle, resetPrefetchState } from './lib/prefetch';
import Icon from './components/icons/Icon';

const useDebugLayout = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const debugMode = params.get('debugLayout') === '1';
    
    if (debugMode) {
      document.documentElement.classList.add('debug-layout');
      
      const checkOverflow = () => {
        const existing = document.querySelector('.debug-overflow-warning');
        if (document.documentElement.scrollWidth > window.innerWidth) {
          if (!existing) {
            const warning = document.createElement('div');
            warning.className = 'debug-overflow-warning';
            warning.textContent = `Overflow! ${document.documentElement.scrollWidth}px > ${window.innerWidth}px`;
            document.body.appendChild(warning);
          }
        } else if (existing) {
          existing.remove();
        }
      };
      
      checkOverflow();
      window.addEventListener('resize', checkOverflow);
      
      return () => {
        window.removeEventListener('resize', checkOverflow);
        document.documentElement.classList.remove('debug-layout');
        const warning = document.querySelector('.debug-overflow-warning');
        if (warning) warning.remove();
      };
    }
    
    return undefined;
  }, []);
};

interface ErrorBoundaryProps {
  children?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  handleRetry = () => {
    try {
      localStorage.removeItem('sync_events');
      localStorage.removeItem('sync_cafe_menu');
    } catch (e) {
      console.warn('LocalStorage access denied', e);
    }
    
    this.setState(prev => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1
    }));
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const errorMessage = this.state.error?.message?.toLowerCase() || '';
      const isNetworkError = errorMessage.includes('fetch') ||
                              errorMessage.includes('network') ||
                              errorMessage.includes('load failed');
      return (
        <div className="flex items-center justify-center h-screen bg-[#141414] text-white p-6">
          <div className="glass-card rounded-xl p-8 max-w-md text-center">
            <Icon name={isNetworkError ? 'wifi_off' : 'error'} className="text-6xl text-red-400 mb-4" />
            <h2 className="text-2xl font-bold mb-2">
              {isNetworkError ? 'Connection Issue' : 'Something went wrong'}
            </h2>
            <p className="text-white/70 mb-6">
              {isNetworkError 
                ? 'Please check your internet connection and try again.'
                : 'We\'re sorry for the inconvenience.'}
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={this.handleRetry}
                className="px-6 py-3 bg-accent rounded-xl font-semibold hover:opacity-90 transition-opacity text-brand-green"
              >
                Try Again
              </button>
              <a
                href="sms:9495455855"
                className="px-6 py-3 bg-white/10 text-white rounded-xl font-semibold hover:opacity-90 transition-opacity text-center"
              >
                Contact Support
              </a>
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryCount}>{this.props.children}</React.Fragment>;
  }
}



// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, sessionChecked } = useAuthData();
  if (!sessionChecked) return <PageSkeleton />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

const WaiverGate: React.FC = () => {
  const { user } = useAuthData();
  const [showWaiverModal, setShowWaiverModal] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('1.0');
  const queryClient = useQueryClient();

  const { data: waiverStatus, isError, isLoading } = useQuery<{ needsWaiverUpdate?: boolean; currentVersion?: string }>({
    queryKey: ['waiverStatus'],
    queryFn: () => fetchWithCredentials<{ needsWaiverUpdate?: boolean; currentVersion?: string }>('/api/waivers/status'),
    enabled: !!user?.email,
    staleTime: 5 * 60 * 1000,
    retry: 3,
  });

  useEffect(() => {
    if (waiverStatus?.needsWaiverUpdate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentVersion(waiverStatus.currentVersion || '1.0');
      setShowWaiverModal(true);
    } else {
      setShowWaiverModal(false);
    }
  }, [waiverStatus]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white dark:bg-surface-dark-200 rounded-xl p-6 max-w-sm mx-4 text-center shadow-xl">
          <p className="text-sm text-neutral-500">Verifying waiver status...</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-white dark:bg-surface-dark-200 rounded-xl p-6 max-w-sm mx-4 text-center shadow-xl">
          <p className="text-lg font-semibold mb-2">Unable to verify waiver status</p>
          <p className="text-sm text-neutral-500 mb-4">Please check your connection and try again.</p>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['waiverStatus'] })}
            className="px-4 py-2 bg-primary text-white rounded-[4px] font-medium"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!showWaiverModal) return null;

  return (
    <WaiverModal
      isOpen={showWaiverModal}
      onComplete={() => {
        setShowWaiverModal(false);
        queryClient.invalidateQueries({ queryKey: ['waiverStatus'] });
      }}
      currentVersion={currentVersion}
    />
  );
};

// Members Portal route guard - redirects staff/admin to Staff Portal (unless viewing as member or on profile page)
const MemberPortalRoute: React.FC<{ children: React.ReactNode; allowStaffAccess?: boolean }> = ({ children, allowStaffAccess }) => {
  const { user, actualUser, isViewingAs, sessionChecked } = useAuthData();
  if (!sessionChecked) return <PageSkeleton />;
  if (!user) return <Navigate to="/login" replace />;
  
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  if (isStaffOrAdmin && !isViewingAs && !allowStaffAccess) {
    return <Navigate to="/admin" replace />;
  }
  
  return <>{children}</>;
};

const AdminProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { actualUser, sessionChecked } = useAuthData();
  if (!sessionChecked) return <PageSkeleton />;
  if (!actualUser) return <Navigate to="/login" replace />;
  if (actualUser.role !== 'admin' && actualUser.role !== 'staff') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
};

const ROUTE_INDICES: Record<string, number> = {
  '/dashboard': 0,
  '/book': 1,
  '/wellness': 2,
  '/events': 3,
  '/history': 4,
  '/updates': 5,
  '/profile': 6,
};

const PAGE_EXIT_DURATION = 150;

const useViewTransitionLocation = () => {
  const location = useLocation();
  const [displayLocation, setDisplayLocation] = useState(location);
  const [isExiting, setIsExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);
  const latestLocationRef = useRef(location);
  latestLocationRef.current = location;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      setDisplayLocation(location);
      return;
    }

    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (location.pathname === displayLocation.pathname && location.search === displayLocation.search) {
      setIsExiting(false);
      setDisplayLocation(location);
      return;
    }

    setIsExiting(true);

    exitTimerRef.current = setTimeout(() => {
      const latest = latestLocationRef.current;
      setIsExiting(false);
      setDisplayLocation(latest);
      exitTimerRef.current = null;
    }, PAGE_EXIT_DURATION);

    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [location]);

  return { displayLocation, isExiting };
};

const AnimatedRoutes: React.FC = () => {
  const { displayLocation, isExiting } = useViewTransitionLocation();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  const { user } = useAuthData();
  const prevEmailRef = useRef(user?.email);

  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
  }, []);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
  }, [displayLocation.pathname]);
  
  useEffect(() => {
    if (prevEmailRef.current && prevEmailRef.current !== user?.email) {
      resetPrefetchState();
    }
    prevEmailRef.current = user?.email;
  }, [user?.email]);
  
  useEffect(() => {
    if (!user?.email) return;
    const cancel = prefetchOnIdle();
    return cancel;
  }, [user?.email]);
  
  const transitionState = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    const prevPath = prevPathRef.current;
    const currentPath = location.pathname;
    
    const getRouteIndex = (path: string) => {
      const entry = Object.entries(ROUTE_INDICES).find(([key]) => path === key || path.startsWith(key + '/'));
      return entry ? entry[1] : -1;
    };
    const prevIndex = getRouteIndex(prevPath);
    const currentIndex = getRouteIndex(currentPath);
    
    if (prevIndex >= 0 && currentIndex >= 0 && prevPath !== currentPath) {
      const direction = currentIndex > prevIndex ? 1 : -1;
      const distance = Math.abs(currentIndex - prevIndex);
      return { direction, distance: Math.max(0.1, distance) };
    }
    return { direction: 1, distance: 1 };
  }, [location.pathname]);
  
  useEffect(() => {
    prevPathRef.current = location.pathname;
  }, [location.pathname]);

  return (
    <TransitionContext.Provider value={transitionState}>
      <PageExitContext.Provider value={isExiting}>
          <Routes location={displayLocation}>
            <Route path="/" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Landing"><Landing /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/membership/apply" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="MembershipApply"><MembershipApply /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/membership/*" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Membership"><Membership /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/contact" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Contact"><Contact /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/gallery" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Gallery"><Gallery /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/whats-on" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="WhatsOn"><WhatsOn /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/private-hire" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="PrivateHire"><PrivateHire /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/private-hire/inquire" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="PrivateHireInquire"><PrivateHireInquire /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/menu" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Cafe"><PublicCafe /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/faq" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="FAQ"><FAQ /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/about" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="About"><About /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/tour" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="BookTour"><BookTour /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/day-pass" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="BuyDayPass"><BuyDayPass /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/day-pass/success" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="DayPassSuccess"><DayPassSuccess /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/privacy" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Privacy"><PrivacyPolicy /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/terms" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Terms"><TermsOfService /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/login" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Login"><Login /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/auth/callback" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="AuthCallback"><AuthCallback /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/reset-password" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="ResetPassword"><Login /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/nfc-checkin" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="NfcCheckin"><NfcCheckin /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />
            <Route path="/kiosk" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="KioskCheckin"><KioskCheckin /></PageErrorBoundary></Suspense>} />
            <Route path="/checkout/*" element={<DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Checkout"><Checkout /></PageErrorBoundary></Suspense></DirectionalPageTransition>} />

            <Route path="/admin" element={
              <AdminProtectedRoute>
                <Suspense fallback={null}>
                  <StaffWebSocketProvider>
                    <DirectionalPageTransition><PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary></DirectionalPageTransition>
                  </StaffWebSocketProvider>
                </Suspense>
              </AdminProtectedRoute>
            }>
              <Route index element={<PageErrorBoundary pageName="StaffCommandCenter"><StaffCommandCenter /></PageErrorBoundary>} />
              <Route path="bookings" element={<PageErrorBoundary pageName="Bookings"><SimulatorTab /></PageErrorBoundary>} />
              <Route path="directory" element={<PageErrorBoundary pageName="Directory"><DirectoryTab /></PageErrorBoundary>} />
              <Route path="calendar" element={<PageErrorBoundary pageName="Calendar"><EventsTab /></PageErrorBoundary>} />
              <Route path="notices" element={<PageErrorBoundary pageName="Notices"><BlocksTab /></PageErrorBoundary>} />
              <Route path="updates" element={<PageErrorBoundary pageName="Updates"><UpdatesTab /></PageErrorBoundary>} />
              <Route path="news" element={<PageErrorBoundary pageName="News"><AnnouncementsTab /></PageErrorBoundary>} />
              <Route path="team" element={<PageErrorBoundary pageName="Team"><TeamTab /></PageErrorBoundary>} />
              <Route path="tiers" element={<PageErrorBoundary pageName="Tiers"><TiersTab /></PageErrorBoundary>} />
              <Route path="trackman" element={<PageErrorBoundary pageName="Trackman"><TrackmanTab /></PageErrorBoundary>} />
              <Route path="data-integrity" element={<PageErrorBoundary pageName="DataIntegrity"><DataIntegrityTab /></PageErrorBoundary>} />
              <Route path="financials" element={<PageErrorBoundary pageName="Financials"><FinancialsTab /></PageErrorBoundary>} />
              <Route path="gallery" element={<PageErrorBoundary pageName="Gallery"><GalleryAdmin /></PageErrorBoundary>} />
              <Route path="faqs" element={<PageErrorBoundary pageName="FAQs"><FaqsAdmin /></PageErrorBoundary>} />
              <Route path="inquiries" element={<PageErrorBoundary pageName="Inquiries"><InquiriesAdmin /></PageErrorBoundary>} />
              <Route path="applications" element={<PageErrorBoundary pageName="ApplicationPipeline"><ApplicationPipeline /></PageErrorBoundary>} />
              <Route path="bugs" element={<PageErrorBoundary pageName="BugReports"><BugReportsAdmin /></PageErrorBoundary>} />
              <Route path="settings" element={<PageErrorBoundary pageName="Settings"><SettingsTab /></PageErrorBoundary>} />
              <Route path="changelog" element={<PageErrorBoundary pageName="Changelog"><ChangelogTab /></PageErrorBoundary>} />
              <Route path="tours" element={<PageErrorBoundary pageName="Tours"><ToursTab /></PageErrorBoundary>} />
              <Route path="email-templates" element={<PageErrorBoundary pageName="EmailTemplates"><EmailTemplatesTab /></PageErrorBoundary>} />
              <Route path="analytics" element={<PageErrorBoundary pageName="Analytics"><AnalyticsTab /></PageErrorBoundary>} />
              <Route path="training" element={null} />
            </Route>
            <Route path="/admin/data-integrity-legacy" element={
              <AdminProtectedRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="DataIntegrity"><DataIntegrity /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </AdminProtectedRoute>
            } />

            <Route path="/dashboard" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/book" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/events" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/wellness" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/member-events" element={<Navigate to="/events" replace />} />
            <Route path="/member-wellness" element={<Navigate to="/wellness" replace />} />
            <Route path="/profile" element={
              <MemberPortalRoute allowStaffAccess>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/updates" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/history" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary></Suspense></DirectionalPageTransition>
              </MemberPortalRoute>
            } />

            {/* Dev preview routes - ONLY available in development, disabled in production */}
            {import.meta.env.DEV && (
              <>
                {/* Light mode (default) */}
                <Route path="/dev-preview/test" element={<div className="min-h-screen flex items-center justify-center bg-brand-green text-white text-4xl">DEV PREVIEW WORKS</div>} />
                <Route path="/dev-preview/dashboard" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/book" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/history" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/wellness" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/events" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/profile" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/updates" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary></Suspense>} />
                {/* Dark mode variants - append -dark to route */}
                <Route path="/dev-preview/dashboard-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/book-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/history-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/wellness-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/events-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/profile-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary></Suspense>} />
                <Route path="/dev-preview/updates-dark" element={<Suspense fallback={<PageSkeleton />}><PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary></Suspense>} />
                {/* Staff/Admin portal dev preview routes */}
                <Route path="/dev-preview/admin" element={<Suspense fallback={null}><StaffWebSocketProvider><PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary></StaffWebSocketProvider></Suspense>} />
                <Route path="/dev-preview/admin-dark" element={<Suspense fallback={null}><StaffWebSocketProvider><PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary></StaffWebSocketProvider></Suspense>} />
              </>
            )}
            
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
      </PageExitContext.Provider>
    </TransitionContext.Provider>
  );
};

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, actualUser, isViewingAs } = useAuthData();
  const { announcements: _announcements } = useAnnouncementData();
  const { effectiveTheme } = useTheme();
  const { isNavigating, startNavigation, endNavigation } = useNavigationLoading();
  const { processNotifications: _processNotifications } = useNotificationSounds(false, user?.email);
  const layoutQueryClient = useQueryClient();
  const handleLayoutRefresh = useCallback(async () => {
    window.dispatchEvent(new Event('app-refresh'));
    await layoutQueryClient.refetchQueries({ type: 'active' });
    window.scrollTo({ top: 0 });
  }, [layoutQueryClient]);
  
  // End navigation loading when route changes
  useEffect(() => {
    endNavigation();
  }, [location.pathname, location.search, endNavigation]);
  
  // Check if actual user is staff/admin (for header logic)
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMemberMenuOpen, setIsMemberMenuOpen] = useState(false);
  const [isStaffMenuOpen, setIsStaffMenuOpen] = useState(false);
  const unreadCount = useNotificationStore(state => state.unreadCount);
  useWebSocket({ effectiveEmail: user?.email });
  useSupabaseRealtime({ userEmail: user?.email });
  const [hasScrolledPastHero, setHasScrolledPastHero] = useState(false);
  
  useDebugLayout();
  useKeyboardDetection();

  // Route classification (used by layout)
  const isMemberRoute = ['/dashboard', '/book', '/events', '/wellness', '/profile', '/updates', '/history'].some(path => location.pathname.startsWith(path));
  const isAdminRoute = location.pathname.startsWith('/admin');


  useEffect(() => {
    // Track scroll position for landing page hero effects
    if (location.pathname === '/') {
      const handleScroll = () => {
        const heroThreshold = window.innerHeight * 0.6;
        const scrolledPast = window.scrollY > heroThreshold;
        setHasScrolledPastHero(scrolledPast);
      };
      
      handleScroll();
      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => window.removeEventListener('scroll', handleScroll);
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasScrolledPastHero(false);
    }
  }, [location.pathname]);
  
  const isLandingPage = location.pathname === '/';
  const isFullBleedHeroPage = isLandingPage || location.pathname === '/private-hire';
  const isDarkTheme = (isAdminRoute || isMemberRoute) && effectiveTheme === 'dark';
  const showHeader = !isAdminRoute;

  // Determine if current page is a public page (not member/staff portal)
  const isPublicPage = !isMemberRoute && !isAdminRoute;
  
  useEffect(() => {
    const html = document.documentElement;
    
    html.classList.remove('page-public', 'page-dark', 'page-light');
    
    if (isPublicPage) {
      html.classList.add('page-public');
      html.classList.remove('dark');
    } else if (isDarkTheme) {
      html.classList.add('page-dark');
      html.classList.add('dark');
    } else {
      html.classList.add('page-light');
      html.classList.remove('dark');
    }
  }, [isPublicPage, isDarkTheme]);

  const handleTopLeftClick = () => {
    setIsMenuOpen(true);
  };

  const isProfilePage = location.pathname === '/profile';
  
  const handleTopRightClick = () => {
    if (user) {
        // On profile page, do nothing - already on settings
        if (isProfilePage) {
            return;
        }
        // Start navigation loading indicator
        startNavigation();
        // For staff/admin (not viewing as member), go to Staff Portal
        if (isStaffOrAdmin && !isViewingAs) {
            navigate('/admin');
        } else if (isMemberRoute) {
            navigate('/profile');
        } else {
            // On public pages, staff/admin go to Staff Portal, members go to dashboard
            if (isStaffOrAdmin && !isViewingAs) {
                navigate('/admin');
            } else {
                navigate('/dashboard');
            }
        }
    } else {
        startNavigation();
        navigate('/login');
    }
  };

  const _getTopRightIcon = () => {
      if (!user) return 'login';
      // On profile page, show gear icon (already on settings)
      if (isProfilePage) return 'settings';
      // For staff/admin not viewing as member, show admin icon
      if (isStaffOrAdmin && !isViewingAs) return 'admin_panel_settings';
      // Gear icon for member portal (including profile page)
      if (isMemberRoute) return 'settings';
      return 'account_circle';
  };

  const getPageTitle = () => {
      if (!isMemberRoute) return null;
      const path = location.pathname;
      if (path === '/dashboard') return 'Dashboard';
      if (path === '/profile') return 'Profile';
      if (path.startsWith('/book')) return 'Book';
      if (path.startsWith('/wellness')) return 'Wellness';
      if (path.startsWith('/updates')) return 'Updates';
      if (path.startsWith('/events')) return 'Events';
      if (path.startsWith('/history')) return 'History';
      return 'Dashboard';
  };

  const openNotifications = (tab?: 'updates' | 'announcements') => {
    navigate(`/updates?tab=${tab || 'activity'}`);
  };
  
  const headerClasses = isMemberRoute 
    ? (isDarkTheme 
        ? "bg-[#293515] text-[#F2F2EC] shadow-lg shadow-black/20 border-b border-[#1e2810]"
        : "bg-[#293515] text-[#F2F2EC] shadow-lg shadow-black/20 border-b border-[#1e2810]")
    : isLandingPage
      ? (hasScrolledPastHero 
          ? "bg-[#293515] text-white shadow-lg shadow-black/20 border-b border-white/10"
          : "bg-[#293515] text-white")
      : "bg-[#293515] text-[#F2F2EC] shadow-lg shadow-black/20";
  const headerBtnClasses = "text-white hover:opacity-70 active:scale-95 transition-opacity duration-fast";

  const headerContent = showHeader ? (
    <header className={`fixed top-0 left-0 right-0 h-20 flex items-center px-4 sm:px-6 pointer-events-auto transition-[box-shadow,border-color] duration-normal ${headerClasses}`} style={{ zIndex: 'var(--z-header)', paddingTop: 'env(safe-area-inset-top, 0px)', boxSizing: 'content-box' }} role="banner">
      {/* Left section - flex-1 for symmetric spacing with right */}
      <div className="flex-1 flex justify-start">
        {isMemberRoute ? (
          <button 
            onClick={() => {
              // On profile page, staff/admin (not viewing as member) should see staff sidebar
              if (isProfilePage && isStaffOrAdmin && !isViewingAs) {
                setIsStaffMenuOpen(true);
              } else {
                setIsMemberMenuOpen(true);
              }
            }}
            className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg`}
            aria-label="Open menu"
          >
            <Icon name="menu" className="text-[24px]" />
          </button>
        ) : (
          <button 
            onClick={handleTopLeftClick}
            className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg`}
            aria-label="Open menu"
          >
            <Icon name="menu" className="text-[24px]" />
          </button>
        )}
      </div>
      
      {/* Center section - auto width, centered between equal flex-1 sides */}
      <div className="flex-shrink-0 flex justify-center">
        {isMemberRoute ? (
          <h1 key={getPageTitle()} className="text-2xl font-normal italic text-[#F2F2EC] truncate leading-none lowercase translate-y-[1px] font-serif animate-header-title">
            {getPageTitle()}
          </h1>
        ) : (
          <button 
            className="cursor-pointer flex items-center justify-center focus:ring-2 focus:ring-accent focus:outline-none rounded-lg" 
            onClick={() => navigate('/')}
            aria-label="Go to home"
          >
            <Logo 
              isMemberRoute={isMemberRoute} 
              isDarkBackground={true} 
              className="h-10 sm:h-12 w-auto object-contain shrink-0"
            />
          </button>
        )}
      </div>

      {/* Right section - flex-1 for symmetric spacing with left */}
      <div className="flex-1 flex items-center justify-end gap-1">
        {isMemberRoute && user && (
          <button 
            onClick={() => isStaffOrAdmin && !isViewingAs ? navigate('/admin/updates') : navigate('/updates?tab=activity')}
            className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg relative`}
            aria-label={isStaffOrAdmin && !isViewingAs ? "Updates" : "Notifications"}
          >
            <Icon name={isStaffOrAdmin && !isViewingAs ? 'campaign' : 'notifications'} className="text-[24px]" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center animate-badge-pulse">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        )}
        {isMemberRoute && user ? (
          <button 
            onClick={handleTopRightClick}
            disabled={isNavigating}
            className={`flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-full relative ${isNavigating ? 'opacity-70' : ''}`}
            aria-label="View profile"
          >
            <Avatar name={user.name && !user.name.includes('@') ? user.name : undefined} email={user.email} size="md" />
            {isNavigating && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              </span>
            )}
          </button>
        ) : (
          <button 
            onClick={handleTopRightClick}
            disabled={isNavigating}
            className={`px-1.5 py-0.5 xs:px-2 xs:py-1 sm:px-3 sm:py-1.5 flex items-center justify-center gap-1.5 shrink ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-full backdrop-blur-xl bg-white/15 border border-white/40 shadow-[0_4px_16px_rgba(0,0,0,0.1),inset_0_1px_1px_rgba(255,255,255,0.4)] text-[9px] xs:text-[10px] sm:text-xs font-semibold tracking-wide hover:bg-white/25 hover:border-white/50 transition-all duration-normal ${isNavigating ? 'opacity-70' : ''}`}
            aria-label={user ? 'Go to dashboard' : 'Sign in'}
          >
            {isNavigating && (
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            Sign In
          </button>
        )}
      </div>
    </header>
  ) : null;

  return (
    <div className={`${isDarkTheme ? 'dark liquid-bg text-white' : 'bg-[#F2F2EC] text-primary'} min-h-screen w-full relative transition-colors duration-emphasis font-sans`}>
      
      {/* Skip to main content link for keyboard navigation - WCAG 2.4.1 */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.04] mix-blend-overlay" id="texture-bg"></div>

      <NotificationContext.Provider value={{ openNotifications }}>
        {isStaffOrAdmin && <Suspense fallback={null}><ViewAsBanner /></Suspense>}
        {isStaffOrAdmin && <Suspense fallback={null}><StaffBookingToast /></Suspense>}
        {user && !isStaffOrAdmin && <WaiverGate />}
        
        {/* Header rendered via portal to escape transform context */}
        {headerContent && createPortal(headerContent, document.getElementById('header-root') ?? document.body)}
        
        <div className={`relative w-full h-auto overflow-visible ${isDarkTheme ? 'text-white' : 'text-primary'}`}>

            <main 
                id="main-content"
                className={`relative h-auto overflow-visible dark:bg-[#141414] ${showHeader && !isFullBleedHeroPage ? 'pt-[calc(env(safe-area-inset-top,0px)+88px)]' : ''}`}
            >
                <PullToRefresh onRefresh={handleLayoutRefresh}>
                  {children}
                </PullToRefresh>
                {isMemberRoute && !isAdminRoute && !isProfilePage && <BottomSentinel />}
            </main>

            {isMemberRoute && !isAdminRoute && !isProfilePage && user && (
              <MemberBottomNav currentPath={location.pathname} isDarkTheme={isDarkTheme} />
            )}

            {/* No overlay for public pages - let content backgrounds show naturally */}

            <MenuOverlay isOpen={isMenuOpen} onClose={() => setIsMenuOpen(false)} />
            <MemberMenuOverlay isOpen={isMemberMenuOpen} onClose={() => setIsMemberMenuOpen(false)} />
            {isStaffOrAdmin && (
              <Suspense fallback={null}>
                <StaffMobileSidebar 
                  isOpen={isStaffMenuOpen} 
                  onClose={() => setIsStaffMenuOpen(false)} 
                  activeTab="home"
                  isAdmin={actualUser?.role === 'admin'}
                />
              </Suspense>
            )}
        </div>
      </NotificationContext.Provider>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <DataProvider>
            <ToastProvider>
            <InitialLoadingScreen>
              <BrowserRouter>
                <OfflineBanner />
                <UpdateNotification />
                <Layout>
                  <AnimatedRoutes />
                </Layout>
              </BrowserRouter>
            </InitialLoadingScreen>
            </ToastProvider>
          </DataProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
