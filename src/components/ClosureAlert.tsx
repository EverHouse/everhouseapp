import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useData } from '../contexts/DataContext';
import { getTodayPacific } from '../utils/dateUtils';

interface Closure {
  id: number;
  title: string;
  reason: string | null;
  noticeType: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  affectedAreas: string;
  notifyMembers: boolean;
}

const formatAffectedAreas = (areas: string): string => {
  if (areas === 'entire_facility') return 'Entire Facility';
  if (areas === 'all_bays') return 'All Simulator Bays';
  if (areas === 'none') return 'No booking restrictions';
  
  const areaList = areas.split(',').map(a => a.trim());
  const formatted = areaList.map(area => {
    if (area === 'entire_facility') return 'Entire Facility';
    if (area === 'all_bays') return 'All Simulator Bays';
    if (area === 'conference_room') return 'Conference Room';
    if (area === 'none') return 'No booking restrictions';
    if (area.startsWith('bay_')) {
      const bayNum = area.replace('bay_', '');
      return `Bay ${bayNum}`;
    }
    return area;
  });
  return formatted.join(', ');
};

const getAffectedAreasList = (areas: string): string[] => {
  if (!areas || areas === 'none') return [];
  if (areas === 'entire_facility') return ['Entire Facility'];
  if (areas === 'all_bays') return ['All Simulator Bays'];
  
  return areas.split(',').map(a => a.trim()).map(area => {
    if (area === 'entire_facility') return 'Entire Facility';
    if (area === 'all_bays') return 'All Simulator Bays';
    if (area === 'conference_room') return 'Conference Room';
    if (area === 'none') return '';
    if (area.startsWith('bay_')) {
      const bayNum = area.replace('bay_', '');
      return `Bay ${bayNum}`;
    }
    return area;
  }).filter(a => a);
};

const getNoticeDisplayText = (closure: Closure): string => {
  if (closure.noticeType && closure.noticeType.trim()) {
    return closure.noticeType;
  }
  if (closure.reason && closure.reason.trim()) {
    return closure.reason;
  }
  if (closure.affectedAreas) {
    return formatAffectedAreas(closure.affectedAreas);
  }
  return closure.title || 'Notice';
};

const ClosureAlert: React.FC = () => {
  const navigate = useNavigate();
  const { effectiveTheme } = useTheme();
  const { user, actualUser } = useData();
  const isDark = effectiveTheme === 'dark';
  
  // Check if viewing as staff/admin (not in "View As" mode)
  const isStaffOrAdmin = actualUser?.role === 'admin' || actualUser?.role === 'staff';
  const isViewingAsMember = user?.email && actualUser?.email && user.email !== actualUser.email;
  
  const [closures, setClosures] = useState<Closure[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  const getStorageKey = () => `eh_dismissed_notices_${user?.email || 'guest'}`;

  useEffect(() => {
    const stored = localStorage.getItem(getStorageKey());
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setDismissedIds(new Set(parsed));
      } catch {
        setDismissedIds(new Set());
      }
    }
  }, [user?.email]);

  useEffect(() => {
    const fetchClosures = async () => {
      try {
        const res = await fetch('/api/closures');
        if (res.ok) {
          const data = await res.json();
          setClosures(data);
        }
      } catch (error) {
        console.error('Failed to fetch closures:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchClosures();
  }, []);

  const activeClosures = useMemo(() => {
    const todayStr = getTodayPacific();
    
    return closures.filter(closure => {
      if (dismissedIds.has(closure.id)) return false;
      if (closure.endDate < todayStr) return false;
      
      // Staff/admin see all upcoming notices (unless in "View As" mode)
      if (isStaffOrAdmin && !isViewingAsMember) {
        const hasAffectedResources = closure.affectedAreas && closure.affectedAreas !== 'none';
        return hasAffectedResources || closure.notifyMembers === true;
      }
      
      // Members only see notices ON the day of the closure (startDate <= today)
      if (closure.startDate > todayStr) return false;
      
      const hasAffectedResources = closure.affectedAreas && closure.affectedAreas !== 'none';
      return hasAffectedResources || closure.notifyMembers === true;
    });
  }, [closures, dismissedIds, isStaffOrAdmin, isViewingAsMember]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    const closure = activeClosures[0];
    if (!closure) return;
    const newDismissed = new Set(dismissedIds);
    newDismissed.add(closure.id);
    setDismissedIds(newDismissed);
    localStorage.setItem(getStorageKey(), JSON.stringify([...newDismissed]));
  };

  const handleViewDetails = () => {
    navigate('/updates?tab=notices');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleViewDetails();
    }
  };
  
  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      handleViewDetails();
    }
  };

  const isBlocking = (areas: string | null): boolean => {
    return areas !== 'none' && areas !== '' && areas !== null;
  };

  const formatTime12Hour = (time: string): string => {
    if (!time) return '';
    const [hours, minutes] = time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${hours12}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  const formatDateDisplay = (dateStr: string): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'T12:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  if (isLoading || activeClosures.length === 0) return null;

  const closure = activeClosures[0];
  const hasMultiple = activeClosures.length > 1;
  const blocking = isBlocking(closure.affectedAreas);
  
  // For informational notices (not blocking), always show "Notice" unless a specific type is set
  // "Closure" type should only show for blocking notices
  const getNoticeLabel = () => {
    if (!blocking) {
      // Informational notice - show type if meaningful, otherwise "Notice"
      if (closure.noticeType && closure.noticeType.toLowerCase() !== 'closure') {
        return closure.noticeType;
      }
      return 'Notice';
    }
    // Blocking notice - show type or default to "Closure"
    return closure.noticeType || 'Closure';
  };
  const noticeLabel = getNoticeLabel();

  return (
    <div 
      className={`mb-4 py-2 px-4 rounded-xl flex items-center justify-between gap-3 cursor-pointer transition-all duration-200 ${
        blocking
          ? (isDark ? 'bg-red-500/20 hover:bg-red-500/30' : 'bg-red-100 hover:bg-red-200')
          : (isDark ? 'bg-amber-500/20 hover:bg-amber-500/30' : 'bg-amber-100 hover:bg-amber-200')
      }`}
      onClick={handleViewDetails}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      role="button"
      tabIndex={0}
      aria-label={`View notice: ${noticeLabel}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className={`material-symbols-outlined text-lg flex-shrink-0 ${
          blocking
            ? (isDark ? 'text-red-400' : 'text-red-600')
            : (isDark ? 'text-amber-400' : 'text-amber-600')
        }`} aria-hidden="true">
          {blocking ? 'event_busy' : 'notifications'}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold uppercase ${
              blocking
                ? (isDark ? 'text-red-400' : 'text-red-600')
                : (isDark ? 'text-amber-400' : 'text-amber-600')
            }`}>
              {noticeLabel}
            </span>
            <span className={`text-[10px] ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              {formatDateDisplay(closure.startDate)}
              {closure.endDate && closure.endDate !== closure.startDate && ` - ${formatDateDisplay(closure.endDate)}`}
              {closure.startTime && ` • ${formatTime12Hour(closure.startTime)}`}
              {closure.endTime && closure.endTime !== closure.startTime && ` - ${formatTime12Hour(closure.endTime)}`}
            </span>
          </div>
          <div className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <span className="line-clamp-1">
              {closure.reason && closure.reason.trim() ? closure.reason : closure.title || 'Notice'}
            </span>
          </div>
          {(() => {
            const hasAffectedAreas = closure.affectedAreas && closure.affectedAreas !== 'none' && closure.affectedAreas !== '';
            const areasList = hasAffectedAreas ? getAffectedAreasList(closure.affectedAreas) : [];
            if (areasList.length > 0) {
              return (
                <div className="flex flex-wrap gap-1 mt-1">
                  {areasList.slice(0, 3).map((area, idx) => (
                    <span 
                      key={idx} 
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        blocking
                          ? (isDark ? 'bg-red-400/30 text-red-300' : 'bg-red-200 text-red-700')
                          : (isDark ? 'bg-amber-400/30 text-amber-300' : 'bg-amber-200 text-amber-700')
                      }`}
                    >
                      {area}
                    </span>
                  ))}
                  {areasList.length > 3 && (
                    <span className={`text-[10px] ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                      +{areasList.length - 3} more
                    </span>
                  )}
                </div>
              );
            }
            // For informational notices without affected areas, show "No booking restrictions"
            if (!blocking) {
              return (
                <span className={`text-[10px] mt-1 ${isDark ? 'text-white/50' : 'text-gray-400'}`}>
                  No booking restrictions
                </span>
              );
            }
            return null;
          })()}
        </div>
        {hasMultiple && (
          <span className={`text-xs font-medium flex-shrink-0 px-1.5 py-0.5 rounded ${
            blocking
              ? (isDark ? 'bg-red-400/30 text-red-300' : 'bg-red-200 text-red-700')
              : (isDark ? 'bg-amber-400/30 text-amber-300' : 'bg-amber-200 text-amber-700')
          }`}>
            +{activeClosures.length - 1}
          </span>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className={`p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full flex-shrink-0 transition-colors ${
          isDark 
            ? 'text-white/70 hover:text-white hover:bg-white/10' 
            : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
        }`}
        aria-label="Dismiss notice"
      >
        <span className="material-symbols-outlined text-lg" aria-hidden="true">close</span>
      </button>
    </div>
  );
};

export default ClosureAlert;
