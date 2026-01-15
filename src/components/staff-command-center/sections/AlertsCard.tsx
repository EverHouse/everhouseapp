import React from 'react';
import EmptyState from '../../EmptyState';
import type { StaffNotification } from '../types';
import { getPacificDateParts } from '../../../utils/dateUtils';

interface AlertsCardProps {
  notifications: StaffNotification[];
  onAlertClick?: () => void;
}

function formatRelativeTime(timestamp: string): string {
  const parts = getPacificDateParts();
  const nowMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const date = new Date(timestamp);
  const diffMs = nowMs - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getNotificationColor(type: string): string {
  switch (type) {
    case 'tour_scheduled':
    case 'tour':
      return 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30';
    case 'booking_request':
    case 'booking_pending':
      return 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30';
    case 'booking_approved':
    case 'payment_success':
    case 'payment_receipt':
    case 'membership_renewed':
    case 'fee_waived':
      return 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30';
    case 'booking_cancelled':
    case 'booking_declined':
    case 'payment_failed':
    case 'membership_failed':
    case 'membership_past_due':
    case 'outstanding_balance':
      return 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30';
    case 'system_alert':
    case 'warning':
    case 'membership_cancelled':
      return 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30';
    case 'card_expiring':
      return 'text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-900/30';
    case 'guest_pass':
      return 'text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/30';
    default:
      return 'text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-900/30';
  }
}

function getNotificationIcon(type: string): string {
  switch (type) {
    case 'tour_scheduled':
    case 'tour':
      return 'directions_walk';
    case 'booking_request':
    case 'booking_pending':
      return 'event_note';
    case 'booking_approved':
      return 'check_circle';
    case 'booking_cancelled':
    case 'booking_declined':
      return 'cancel';
    case 'system_alert':
    case 'warning':
      return 'warning';
    case 'payment_success':
    case 'payment_receipt':
      return 'payments';
    case 'payment_failed':
    case 'outstanding_balance':
      return 'credit_card_off';
    case 'membership_renewed':
      return 'card_membership';
    case 'membership_failed':
    case 'membership_past_due':
      return 'error';
    case 'membership_cancelled':
      return 'person_remove';
    case 'fee_waived':
      return 'money_off';
    case 'card_expiring':
      return 'credit_score';
    case 'guest_pass':
      return 'confirmation_number';
    default:
      return 'notifications';
  }
}

export const AlertsCard: React.FC<AlertsCardProps> = ({ notifications, onAlertClick }) => {
  const unreadCount = notifications.filter(n => !n.is_read).length;
  
  return (
    <div className="flex-1 min-h-[200px] bg-white/60 dark:bg-white/5 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-2xl p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-primary dark:text-white">Alerts</h3>
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </div>
        <span className="text-xs text-primary/60 dark:text-white/60">Recent</span>
      </div>
      
      {notifications.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState icon="notifications_none" title="No new alerts" variant="compact" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {notifications.slice(0, 3).map((notif) => (
            <div 
              key={notif.id}
              onClick={onAlertClick}
              className={`flex items-start gap-3 p-2 rounded-lg hover:bg-primary/5 dark:hover:bg-white/5 transition-colors cursor-pointer ${!notif.is_read ? 'bg-primary/5 dark:bg-white/5' : ''}`}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getNotificationColor(notif.type)}`}>
                <span className="material-symbols-outlined text-base">{getNotificationIcon(notif.type)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium truncate ${!notif.is_read ? 'text-primary dark:text-white' : 'text-primary/70 dark:text-white/70'}`}>
                  {notif.title}
                </p>
                <p className="text-xs text-primary/60 dark:text-white/60 truncate">
                  {notif.message}
                </p>
              </div>
              <span className="text-[10px] text-primary/50 dark:text-white/50 flex-shrink-0 whitespace-nowrap">
                {formatRelativeTime(notif.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
