import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useAnnouncementBadge } from '../contexts/AnnouncementBadgeContext';
import { Announcement } from '../contexts/DataContext';
import { haptic } from '../utils/haptics';

const AnnouncementAlert: React.FC = () => {
  const navigate = useNavigate();
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const { unseenHighPriority, markSingleAsSeen, markAllAsSeen } = useAnnouncementBadge();

  if (unseenHighPriority.length === 0) return null;

  const latestAnnouncement = unseenHighPriority[0];
  const hasMultiple = unseenHighPriority.length > 1;
  const isUpdate = latestAnnouncement.type === 'update';

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    haptic.light();
    markSingleAsSeen(latestAnnouncement.id);
  };

  const handleAnnouncementClick = (item: Announcement) => {
    haptic.selection();
    markAllAsSeen();
    if (item.linkType) {
      switch (item.linkType) {
        case 'events':
          navigate('/member-events');
          return;
        case 'wellness':
          navigate('/member-wellness');
          return;
        case 'golf':
          navigate('/book');
          return;
        case 'external':
          if (item.linkTarget) {
            window.open(item.linkTarget, '_blank', 'noopener,noreferrer');
          }
          return;
      }
    }
    navigate('/updates');
  };

  const handleViewAll = () => {
    handleAnnouncementClick(latestAnnouncement);
  };

  const cardColors = isUpdate
    ? isDark 
      ? 'bg-[#CCB8E4]/10 border-[#CCB8E4]/30 hover:bg-[#CCB8E4]/15' 
      : 'bg-[#CCB8E4]/10 border-[#CCB8E4]/30 hover:bg-[#CCB8E4]/20'
    : isDark
      ? 'bg-[#CCB8E4]/10 border-[#CCB8E4]/30 hover:bg-[#CCB8E4]/15'
      : 'bg-[#CCB8E4]/10 border-[#CCB8E4]/30 hover:bg-[#CCB8E4]/20';

  const iconBgColor = isUpdate
    ? isDark ? 'bg-[#CCB8E4]/20' : 'bg-[#CCB8E4]/20'
    : isDark ? 'bg-[#CCB8E4]/20' : 'bg-[#CCB8E4]/20';

  const iconColor = isUpdate
    ? isDark ? 'text-[#CCB8E4]' : 'text-[#9370B8]'
    : isDark ? 'text-[#CCB8E4]' : 'text-[#9370B8]';

  const labelColor = isUpdate
    ? isDark ? 'text-[#CCB8E4]' : 'text-[#7B5BA0]'
    : isDark ? 'text-[#CCB8E4]' : 'text-[#7B5BA0]';

  const labelText = hasMultiple 
    ? `${unseenHighPriority.length} new ${isUpdate ? 'updates' : 'announcements'}` 
    : `New ${isUpdate ? 'update' : 'announcement'}`;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleViewAll();
    }
  };
  
  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      handleViewAll();
    }
  };

  return (
    <article 
      className={`mb-6 p-4 rounded-xl border cursor-pointer transition-all duration-fast ${cardColors} focus-visible:ring-2 focus-visible:ring-[#CCB8E4] focus-visible:outline-none`}
      onClick={handleViewAll}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      role="button"
      tabIndex={0}
      aria-label={`View ${latestAnnouncement.title}`}
    >
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBgColor}`}>
          <span className={`material-symbols-outlined text-xl ${iconColor}`}>
            campaign
          </span>
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className={`font-bold text-sm truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {latestAnnouncement.title}
              </h3>
              {latestAnnouncement.desc && (
                <p className={`text-xs mt-0.5 line-clamp-2 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                  {latestAnnouncement.desc}
                </p>
              )}
            </div>
            <button
              onClick={handleDismiss}
              className={`tactile-btn p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full shrink-0 transition-colors ${
                isDark 
                  ? 'text-white/70 hover:text-white hover:bg-white/10' 
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200'
              }`}
              aria-label="Dismiss announcement"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden="true">close</span>
            </button>
          </div>
          
          <div className="flex items-center justify-between mt-2">
            <span className={`text-[10px] uppercase font-bold tracking-widest ${labelColor}`}>
              {labelText}
            </span>
            <span className={`text-xs font-medium flex items-center gap-1 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
              {latestAnnouncement.linkType === 'events' ? 'View Events' :
               latestAnnouncement.linkType === 'wellness' ? 'View Wellness' :
               latestAnnouncement.linkType === 'golf' ? 'Book Now' :
               latestAnnouncement.linkType === 'external' ? 'Learn More' : 'Tap to view'}
              <span className="material-symbols-outlined text-sm" aria-hidden="true">arrow_forward</span>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
};

export default AnnouncementAlert;
