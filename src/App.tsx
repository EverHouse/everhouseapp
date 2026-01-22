
import React, { useState, useEffect, useContext, ErrorInfo, useMemo, useRef, lazy, Suspense, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { BrowserRouter, Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { DataProvider, useData } from './contexts/DataContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { SmoothScrollProvider } from './components/motion/SmoothScroll';
import DirectionalPageTransition, { TransitionContext } from './components/motion/DirectionalPageTransition';
import Logo from './components/Logo';
import MenuOverlay from './components/MenuOverlay';
import ViewAsBanner from './components/ViewAsBanner';
import PageErrorBoundary from './components/PageErrorBoundary';
import Avatar from './components/Avatar';
import { ToastProvider } from './components/Toast';
import OfflineBanner from './components/OfflineBanner';
import { NotificationContext } from './contexts/NotificationContext';
import { SafeAreaBottomOverlay } from './components/layout/SafeAreaBottomOverlay';
import { BottomNavProvider } from './contexts/BottomNavContext';
import { AnnouncementBadgeProvider } from './contexts/AnnouncementBadgeContext';
import { BottomSentinel } from './components/layout/BottomSentinel';
import { BottomFadeOverlay } from './components/layout/BottomFadeOverlay';
import MemberBottomNav from './components/MemberBottomNav';
import { NavigationLoadingProvider, useNavigationLoading } from './contexts/NavigationLoadingContext';
import { PageReadyProvider } from './contexts/PageReadyContext';
import WalkingGolferLoader from './components/WalkingGolferLoader';
import NavigationLoader from './components/NavigationLoader';
import { useNotificationSounds } from './hooks/useNotificationSounds';
import { useEdgeSwipe } from './hooks/useEdgeSwipe';
import { useKeyboardDetection } from './hooks/useKeyboardDetection';
import { useUserStore } from './stores/userStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useSupabaseRealtime } from './hooks/useSupabaseRealtime';
import { StaffBookingToast } from './components/StaffBookingToast';

const INITIAL_LOAD_SAFETY_TIMEOUT_MS = 100;

const InitialLoadingScreen: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isDataReady } = useData();
  const [showLoader, setShowLoader] = React.useState(true);
  const [hasHiddenLoader, setHasHiddenLoader] = React.useState(false);
  const safetyTimerFiredRef = React.useRef(false);

  React.useEffect(() => {
    if (isDataReady && !hasHiddenLoader) {
      const timer = setTimeout(() => {
        setShowLoader(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isDataReady, hasHiddenLoader]);

  React.useEffect(() => {
    if (safetyTimerFiredRef.current) return;
    
    const safetyTimer = setTimeout(() => {
      safetyTimerFiredRef.current = true;
      setShowLoader(false);
    }, INITIAL_LOAD_SAFETY_TIMEOUT_MS);
    
    return () => clearTimeout(safetyTimer);
  }, []);

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
  <div className="px-6 pt-4 animate-pulse">
    <div className="h-8 w-48 bg-white/10 rounded-lg mb-2" />
    <div className="h-4 w-32 bg-white/5 rounded mb-6" />
    <div className="space-y-4">
      <div className="h-24 bg-white/5 rounded-xl" />
      <div className="h-24 bg-white/5 rounded-xl" />
      <div className="h-24 bg-white/5 rounded-xl" />
    </div>
  </div>
);

const lazyWithPrefetch = (importFn: () => Promise<{ default: React.ComponentType<any> }>) => {
  const Component = lazy(importFn);
  (Component as any).prefetch = importFn;
  return Component;
};

const Dashboard = lazy(() => import('./pages/Member/Dashboard'));
const BookGolf = lazyWithPrefetch(() => import('./pages/Member/BookGolf'));
const MemberEvents = lazyWithPrefetch(() => import('./pages/Member/Events'));
const MemberWellness = lazyWithPrefetch(() => import('./pages/Member/Wellness'));
const Profile = lazyWithPrefetch(() => import('./pages/Member/Profile'));
const MemberUpdates = lazyWithPrefetch(() => import('./pages/Member/Updates'));
const MemberHistory = lazyWithPrefetch(() => import('./pages/Member/History'));
const Landing = lazy(() => import('./pages/Public/Landing'));
const Membership = lazy(() => import('./pages/Public/Membership'));
const Contact = lazy(() => import('./pages/Public/Contact'));
const Gallery = lazy(() => import('./pages/Public/Gallery'));
const WhatsOn = lazy(() => import('./pages/Public/WhatsOn'));
const PrivateHire = lazy(() => import('./pages/Public/PrivateHire'));
const PublicCafe = lazy(() => import('./pages/Public/Cafe'));
const FAQ = lazy(() => import('./pages/Public/FAQ'));
const BuyDayPass = lazy(() => import('./pages/Public/BuyDayPass'));
const DayPassSuccess = lazy(() => import('./pages/Public/DayPassSuccess'));
const PrivacyPolicy = lazy(() => import('./pages/Public/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/Public/TermsOfService'));
const Login = lazy(() => import('./pages/Public/Login'));
const AuthCallback = lazy(() => import('./pages/Public/AuthCallback'));
const AdminDashboard = lazy(() => import('./pages/Admin/AdminDashboard'));
const DataIntegrity = lazy(() => import('./pages/Admin/DataIntegrity'));
const Checkout = lazy(() => import('./pages/Checkout'));

import { prefetchRoute, prefetchAdjacentRoutes, prefetchOnIdle } from './lib/prefetch';

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
    localStorage.removeItem('sync_events');
    localStorage.removeItem('sync_cafe_menu');
    
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
      const isNetworkError = this.state.error?.message?.toLowerCase().includes('fetch') ||
                              this.state.error?.message?.toLowerCase().includes('network') ||
                              this.state.error?.message?.toLowerCase().includes('load failed');
      const canRetry = this.state.retryCount < 3;

      return (
        <div className="flex items-center justify-center h-screen bg-[#0f120a] text-white p-6">
          <div className="glass-card rounded-2xl p-8 max-w-md text-center">
            <span className="material-symbols-outlined text-6xl text-red-400 mb-4">
              {isNetworkError ? 'wifi_off' : 'error'}
            </span>
            <h2 className="text-2xl font-bold mb-2">
              {isNetworkError ? 'Connection Issue' : 'Something went wrong'}
            </h2>
            <p className="text-white/70 mb-6">
              {isNetworkError 
                ? 'Please check your internet connection and try again.'
                : 'We\'re sorry for the inconvenience.'}
            </p>
            <div className="flex flex-col gap-3">
              {canRetry && (
                <button
                  onClick={this.handleRetry}
                  className="px-6 py-3 bg-accent rounded-xl font-semibold hover:opacity-90 transition-opacity text-brand-green"
                >
                  Try Again
                </button>
              )}
              <button
                onClick={this.handleReload}
                className={`px-6 py-3 rounded-xl font-semibold hover:opacity-90 transition-opacity ${
                  canRetry ? 'bg-white/10 text-white' : 'bg-accent text-brand-green'
                }`}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryCount}>{this.props.children}</React.Fragment>;
  }
}

const ScrollToTop = () => {
  const { pathname } = useLocation();
  
  useEffect(() => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  }, [pathname]);
  
  return null;
};

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isLoading } = useData();
  if (isLoading) return <div className="min-h-screen" />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

// Members Portal route guard - redirects staff/admin to Staff Portal (unless viewing as member or on profile page)
const MemberPortalRoute: React.FC<{ children: React.ReactNode; allowStaffAccess?: boolean }> = ({ children, allowStaffAccess }) => {
  const { user, actualUser, isViewingAs, isLoading } = useData();
  if (isLoading) return <div className="min-h-screen" />;
  if (!user) return <Navigate to="/login" replace />;
  
  // If staff/admin is NOT viewing as a member, redirect to Staff Portal
  // Exception: allow staff access to profile page for sign out
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  if (isStaffOrAdmin && !isViewingAs && !allowStaffAccess) {
    return <Navigate to="/admin" replace />;
  }
  
  return <>{children}</>;
};

const AdminProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { actualUser, isLoading } = useData();
  if (isLoading) return <div className="min-h-screen" />;
  if (!actualUser) return <Navigate to="/login" replace />;
  if (actualUser.role !== 'admin' && actualUser.role !== 'staff') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
};

const ROUTE_INDICES: Record<string, number> = {
  '/dashboard': 0,
  '/book': 1,
  '/member-wellness': 2,
  '/member-events': 3,
  '/history': 4,
  '/updates': 5,
  '/profile': 6,
};

const AnimatedRoutes: React.FC = () => {
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  
  useEffect(() => {
    prefetchOnIdle();
  }, []);
  
  const transitionState = useMemo(() => {
    const prevPath = prevPathRef.current;
    const currentPath = location.pathname;
    
    const prevIndex = ROUTE_INDICES[prevPath] ?? -1;
    const currentIndex = ROUTE_INDICES[currentPath] ?? -1;
    
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
      <Suspense fallback={<PageSkeleton />}>
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<DirectionalPageTransition><PageErrorBoundary pageName="Landing"><Landing /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/membership/*" element={<DirectionalPageTransition><PageErrorBoundary pageName="Membership"><Membership /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/contact" element={<DirectionalPageTransition><PageErrorBoundary pageName="Contact"><Contact /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/gallery" element={<DirectionalPageTransition><PageErrorBoundary pageName="Gallery"><Gallery /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/whats-on" element={<DirectionalPageTransition><PageErrorBoundary pageName="WhatsOn"><WhatsOn /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/private-hire" element={<DirectionalPageTransition><PageErrorBoundary pageName="PrivateHire"><PrivateHire /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/menu" element={<DirectionalPageTransition><PageErrorBoundary pageName="Cafe"><PublicCafe /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/faq" element={<DirectionalPageTransition><PageErrorBoundary pageName="FAQ"><FAQ /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/day-pass" element={<DirectionalPageTransition><PageErrorBoundary pageName="BuyDayPass"><BuyDayPass /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/day-pass/success" element={<DirectionalPageTransition><PageErrorBoundary pageName="DayPassSuccess"><DayPassSuccess /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/privacy" element={<DirectionalPageTransition><PageErrorBoundary pageName="Privacy"><PrivacyPolicy /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/terms" element={<DirectionalPageTransition><PageErrorBoundary pageName="Terms"><TermsOfService /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/login" element={<DirectionalPageTransition><PageErrorBoundary pageName="Login"><Login /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/auth/callback" element={<DirectionalPageTransition><PageErrorBoundary pageName="AuthCallback"><AuthCallback /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/reset-password" element={<DirectionalPageTransition><PageErrorBoundary pageName="ResetPassword"><Login /></PageErrorBoundary></DirectionalPageTransition>} />
            <Route path="/checkout/*" element={<DirectionalPageTransition><PageErrorBoundary pageName="Checkout"><Checkout /></PageErrorBoundary></DirectionalPageTransition>} />

            <Route path="/admin" element={
              <AdminProtectedRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary></DirectionalPageTransition>
              </AdminProtectedRoute>
            } />
            <Route path="/admin/data-integrity" element={
              <AdminProtectedRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="DataIntegrity"><DataIntegrity /></PageErrorBoundary></DirectionalPageTransition>
              </AdminProtectedRoute>
            } />

            <Route path="/dashboard" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/book" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/member-events" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/member-wellness" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/profile" element={
              <MemberPortalRoute allowStaffAccess>
                <DirectionalPageTransition><PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/updates" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />
            <Route path="/history" element={
              <MemberPortalRoute>
                <DirectionalPageTransition><PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary></DirectionalPageTransition>
              </MemberPortalRoute>
            } />

            {/* Dev preview routes - ONLY available in development, disabled in production */}
            {import.meta.env.DEV && (
              <>
                {/* Light mode (default) */}
                <Route path="/dev-preview/test" element={<div className="min-h-screen flex items-center justify-center bg-brand-green text-white text-4xl">DEV PREVIEW WORKS</div>} />
                <Route path="/dev-preview/dashboard" element={<PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary>} />
                <Route path="/dev-preview/book" element={<PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary>} />
                <Route path="/dev-preview/history" element={<PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary>} />
                <Route path="/dev-preview/wellness" element={<PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary>} />
                <Route path="/dev-preview/events" element={<PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary>} />
                <Route path="/dev-preview/profile" element={<PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary>} />
                <Route path="/dev-preview/updates" element={<PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary>} />
                {/* Dark mode variants - append -dark to route */}
                <Route path="/dev-preview/dashboard-dark" element={<PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary>} />
                <Route path="/dev-preview/book-dark" element={<PageErrorBoundary pageName="BookGolf"><BookGolf /></PageErrorBoundary>} />
                <Route path="/dev-preview/history-dark" element={<PageErrorBoundary pageName="History"><MemberHistory /></PageErrorBoundary>} />
                <Route path="/dev-preview/wellness-dark" element={<PageErrorBoundary pageName="Wellness"><MemberWellness /></PageErrorBoundary>} />
                <Route path="/dev-preview/events-dark" element={<PageErrorBoundary pageName="Events"><MemberEvents /></PageErrorBoundary>} />
                <Route path="/dev-preview/profile-dark" element={<PageErrorBoundary pageName="Profile"><Profile /></PageErrorBoundary>} />
                <Route path="/dev-preview/updates-dark" element={<PageErrorBoundary pageName="Updates"><MemberUpdates /></PageErrorBoundary>} />
                {/* Staff/Admin portal dev preview routes */}
                <Route path="/dev-preview/admin" element={<PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary>} />
                <Route path="/dev-preview/admin-dark" element={<PageErrorBoundary pageName="AdminDashboard"><AdminDashboard /></PageErrorBoundary>} />
              </>
            )}
            
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
      </Suspense>
    </TransitionContext.Provider>
  );
};

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { announcements, user, actualUser, isViewingAs } = useData();
  const { effectiveTheme } = useTheme();
  const { endNavigation } = useNavigationLoading();
  const { processNotifications } = useNotificationSounds(false, user?.email);
  
  // End navigation loading when route changes
  useEffect(() => {
    endNavigation();
  }, [location.pathname, location.search, endNavigation]);
  
  // Check if actual user is staff/admin (for header logic)
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const unreadCount = useUserStore(state => state.unreadNotifications);
  useWebSocket({ effectiveEmail: user?.email });
  useSupabaseRealtime({ userEmail: user?.email });
  const [hasScrolledPastHero, setHasScrolledPastHero] = useState(false);
  
  useDebugLayout();
  useKeyboardDetection();

  // Edge swipe back navigation for member and staff pages on touch devices
  const isRootPage = location.pathname === '/dashboard' || location.pathname === '/admin';
  const isMemberOrStaff = !!user && (user.role === 'member' || user.role === 'staff' || user.role === 'admin');
  const { isActive: isEdgeSwipeActive, progress: edgeSwipeProgress } = useEdgeSwipe({
    enabled: isMemberOrStaff && !isRootPage && !isMenuOpen,
    edgeWidth: 20,
    threshold: 100
  });

  useEffect(() => {
    const metaThemeColor = document.getElementById('theme-color-meta');
    const isMember = ['/dashboard', '/book', '/member-events', '/member-wellness', '/profile', '/updates', '/history'].some(path => location.pathname.startsWith(path));
    const isAdmin = location.pathname.startsWith('/admin');
    
    const updateThemeColor = (scrolledPastHero: boolean) => {
      if (!metaThemeColor) return;
      
      let themeColor: string;
      if (location.pathname === '/' && !scrolledPastHero) {
        themeColor = '#1a1610';
      } else {
        themeColor = '#293515';
      }
      metaThemeColor.setAttribute('content', themeColor);
    };
    
    if (location.pathname !== '/') {
      setHasScrolledPastHero(false);
      updateThemeColor(false);
      return;
    }
    
    const handleScroll = () => {
      const heroThreshold = window.innerHeight * 0.6;
      const scrolledPast = window.scrollY > heroThreshold;
      setHasScrolledPastHero(scrolledPast);
      updateThemeColor(scrolledPast);
    };
    
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [location.pathname]);
  
  const isMemberRoute = ['/dashboard', '/book', '/member-events', '/member-wellness', '/profile', '/updates', '/history'].some(path => location.pathname.startsWith(path));
  const isAdminRoute = location.pathname.startsWith('/admin');
  const isLandingPage = location.pathname === '/';
  const isFullBleedHeroPage = isLandingPage || location.pathname === '/private-hire';
  const isDarkTheme = (isAdminRoute || isMemberRoute) && effectiveTheme === 'dark';
  const showHeader = !isAdminRoute;

  useEffect(() => {
    const bgColor = isFullBleedHeroPage 
      ? '#293515' 
      : isDarkTheme 
        ? '#0f120a' 
        : '#F2F2EC';
    document.documentElement.style.backgroundColor = bgColor;
    document.body.style.backgroundColor = bgColor;
  }, [isFullBleedHeroPage, isDarkTheme]);

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
        // For staff/admin (not viewing as member), go to Staff Portal
        if (isStaffOrAdmin && !isViewingAs) {
            navigate('/admin');
        } else if (isMemberRoute) {
            navigate('/profile');
        } else {
            // On public pages, staff/admin go to Staff Portal, members go to dashboard
            if (isStaffOrAdmin) {
                navigate('/admin');
            } else {
                navigate('/dashboard');
            }
        }
    } else {
        navigate('/login');
    }
  };

  const getTopRightIcon = () => {
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
      if (path.startsWith('/member-wellness')) return 'Wellness';
      if (path.startsWith('/updates')) return 'Updates';
      if (path.startsWith('/member-events')) return 'Calendar';
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
          : "bg-transparent text-white")
      : "bg-[#293515] text-[#F2F2EC] shadow-lg shadow-black/20";
  const headerBtnClasses = "text-white hover:opacity-70 active:scale-95 transition-opacity duration-200";

  const headerContent = showHeader ? (
    <header className={`fixed top-0 left-0 right-0 flex items-center px-4 sm:px-6 pt-[max(16px,env(safe-area-inset-top))] pb-4 pointer-events-auto transition-[background-color,box-shadow,border-color] duration-300 ${headerClasses}`} style={{ zIndex: 'var(--z-header)' }} role="banner">
      {/* Left section - flex-1 for symmetric spacing with right */}
      <div className="flex-1 flex justify-start">
        {isMemberRoute ? (
          isProfilePage ? (
            <button 
              onClick={() => navigate(-1)}
              className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg`}
              aria-label="Go back"
            >
              <span className="material-symbols-outlined text-[24px]">arrow_back</span>
            </button>
          ) : (
            <button 
              onClick={() => navigate('/')}
              className={`flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg py-1`}
              aria-label="Go to home"
            >
              <img 
                src="/assets/logos/mascot-white.webp" 
                alt="Ever House" 
                className="h-10 w-auto object-contain"
              />
            </button>
          )
        ) : (
          <button 
            onClick={handleTopLeftClick}
            className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg`}
            aria-label="Open menu"
          >
            <span className="material-symbols-outlined text-[24px]">menu</span>
          </button>
        )}
      </div>
      
      {/* Center section - auto width, centered between equal flex-1 sides */}
      <div className="flex-shrink-0 flex justify-center">
        {isMemberRoute ? (
          <h1 className="text-lg font-bold text-[#F2F2EC] tracking-wide truncate">
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
            onClick={() => isStaffOrAdmin && !isViewingAs ? navigate('/admin?tab=updates') : navigate('/updates?tab=activity')}
            className={`w-10 h-10 flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-lg relative`}
            aria-label={isStaffOrAdmin && !isViewingAs ? "Updates" : "Notifications"}
          >
            <span className="material-symbols-outlined text-[24px]">{isStaffOrAdmin && !isViewingAs ? 'campaign' : 'notifications'}</span>
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        )}
        {isMemberRoute && user ? (
          <button 
            onClick={handleTopRightClick}
            className={`flex items-center justify-center ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-full`}
            aria-label="View profile"
          >
            <Avatar name={user.name} email={user.email} size="md" />
          </button>
        ) : (
          <button 
            onClick={handleTopRightClick}
            className={`px-1.5 py-0.5 xs:px-2 xs:py-1 sm:px-3 sm:py-1.5 flex items-center justify-center shrink ${headerBtnClasses} focus:ring-2 focus:ring-accent focus:outline-none rounded-full backdrop-blur-xl bg-white/15 border border-white/40 shadow-[0_4px_16px_rgba(0,0,0,0.1),inset_0_1px_1px_rgba(255,255,255,0.4)] text-[9px] xs:text-[10px] sm:text-xs font-semibold tracking-wide hover:bg-white/25 hover:border-white/50 transition-all duration-300`}
            aria-label={user ? 'Go to dashboard' : 'Members login'}
          >
            Members
          </button>
        )}
      </div>
    </header>
  ) : null;

  return (
    <div className={`${isDarkTheme ? 'dark liquid-bg text-white' : isLandingPage ? 'bg-[#293515] text-primary' : 'bg-[#F2F2EC] text-primary'} min-h-screen w-full relative transition-colors duration-500 font-sans`}>
      
      {/* Skip to main content link for keyboard navigation - WCAG 2.4.1 */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      
      {/* Edge swipe indicator - back arrow that fades and bounces */}
      <div 
        className={`fixed left-0 top-1/2 -translate-y-1/2 pointer-events-none transition-all duration-200 ${isEdgeSwipeActive ? 'opacity-100' : 'opacity-0'}`}
        style={{ 
          zIndex: 'var(--z-header)',
          transform: `translateY(-50%) translateX(${isEdgeSwipeActive ? Math.min(edgeSwipeProgress * 60, 50) : -40}px) scale(${0.8 + edgeSwipeProgress * 0.3})`,
          transition: isEdgeSwipeActive ? 'none' : 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }}
      >
        <div 
          className="w-10 h-10 rounded-full bg-accent/90 backdrop-blur-sm flex items-center justify-center shadow-lg"
          style={{ opacity: Math.min(edgeSwipeProgress * 1.5, 1) }}
        >
          <span className="material-symbols-outlined text-white text-xl">arrow_back</span>
        </div>
      </div>

      {isDarkTheme ? (
        <>
            <div className="fixed top-[-10%] left-[-10%] w-[500px] h-[500px] bg-accent/10 rounded-full blur-[120px] pointer-events-none animate-pulse-slow"></div>
            <div className="fixed bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#E7E7DC]/5 rounded-full blur-[100px] pointer-events-none animate-pulse-slow" style={{animationDelay: '2s'}}></div>
        </>
      ) : (
        <>
            <div className="fixed top-[-20%] right-[-20%] w-[600px] h-[600px] bg-white rounded-full blur-[80px] pointer-events-none opacity-60"></div>
            <div className="fixed bottom-[-10%] left-[-10%] w-[400px] h-[400px] bg-[#E7E7DC] rounded-full blur-[60px] pointer-events-none opacity-40"></div>
        </>
      )}
      
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.04] bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] mix-blend-overlay"></div>

      <NotificationContext.Provider value={{ openNotifications }}>
        <ViewAsBanner />
        
        {/* Header rendered via portal to escape transform context */}
        {headerContent && createPortal(headerContent, document.body)}
        
        <div className={`relative w-full h-auto overflow-visible ${isDarkTheme ? 'text-white' : 'text-primary'}`}>

            <main 
                id="main-content"
                className={`relative h-auto overflow-visible ${showHeader && !isFullBleedHeroPage ? 'pt-[max(88px,calc(env(safe-area-inset-top)+72px))]' : ''}`}
            >
                {children}
                {isMemberRoute && !isAdminRoute && !isProfilePage && <BottomSentinel />}
            </main>

            {isMemberRoute && !isAdminRoute && !isProfilePage && user && (
              <>
                <BottomFadeOverlay isDark={isDarkTheme} variant="colored" />
                <MemberBottomNav currentPath={location.pathname} isDarkTheme={isDarkTheme} />
              </>
            )}

            {!isMemberRoute && !isAdminRoute && (
              <BottomFadeOverlay variant="shadow" />
            )}

            <MenuOverlay isOpen={isMenuOpen} onClose={() => setIsMenuOpen(false)} />
        </div>
      </NotificationContext.Provider>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <DataProvider>
          <ToastProvider>
          <BottomNavProvider>
          <AnnouncementBadgeProvider>
          <NavigationLoadingProvider>
          <PageReadyProvider>
          <InitialLoadingScreen>
            <OfflineBanner />
            <StaffBookingToast />
            <BrowserRouter>
              <NavigationLoader />
              <SmoothScrollProvider>
                <ScrollToTop />
                <Layout>
                  <AnimatedRoutes />
                </Layout>
              </SmoothScrollProvider>
            </BrowserRouter>
          </InitialLoadingScreen>
          </PageReadyProvider>
          </NavigationLoadingProvider>
          </AnnouncementBadgeProvider>
          </BottomNavProvider>
          </ToastProvider>
        </DataProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
};

export default App;
