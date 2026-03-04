import React from 'react';
import type { GuestHistoryItem, GuestCheckInItem } from './types';
import { formatDatePacific, formatTime12Hour } from './types';

export function GuestPassesSection({
  guestPassInfo,
  guestHistory,
  guestCheckInsHistory,
  isDark,
}: {
  guestPassInfo?: { remainingPasses: number; totalUsed: number } | null;
  guestHistory: GuestHistoryItem[];
  guestCheckInsHistory: GuestCheckInItem[];
  isDark: boolean;
}) {
  return (
    <div className={`p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2 mb-4">
        <span className={`material-symbols-outlined ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>badge</span>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-primary'}`}>Guest Passes</h3>
      </div>
      
      {guestPassInfo ? (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-lg text-green-500">confirmation_number</span>
              <span className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {guestPassInfo.remainingPasses}
              </span>
            </div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Remaining Passes</p>
          </div>
          <div className={`p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-lg text-blue-500">history</span>
              <span className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {guestPassInfo.totalUsed}
              </span>
            </div>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Used Passes</p>
          </div>
        </div>
      ) : (
        <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-500'} mb-4`}>
          No guest pass information available
        </p>
      )}

      {guestHistory.length > 0 && (
        <div className="mb-4">
          <h4 className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Guests Brought to Bookings ({guestHistory.length})
          </h4>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {guestHistory.map((guest) => (
              <div key={guest.id} className={`p-2 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} flex items-center justify-between`}>
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {guest.guestName || guest.guestEmail || 'Unknown Guest'}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                    {guest.resourceName} · {formatDatePacific(guest.visitDate)} at {formatTime12Hour(guest.startTime)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {guestCheckInsHistory.length > 0 && (
        <div>
          <h4 className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Guest Check-In History ({guestCheckInsHistory.length})
          </h4>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {guestCheckInsHistory.map((checkIn) => (
              <div key={checkIn.id} className={`p-2 rounded-lg ${isDark ? 'bg-white/5' : 'bg-white'} flex items-center justify-between`}>
                <div>
                  <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {checkIn.guestName || 'Unknown Guest'}
                  </p>
                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                    Checked in on {formatDatePacific(checkIn.checkInDate)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {guestHistory.length === 0 && guestCheckInsHistory.length === 0 && !guestPassInfo && (
        <div className={`text-center py-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          <span className="material-symbols-outlined text-3xl mb-2">group_off</span>
          <p className="text-sm">No guest activity recorded</p>
        </div>
      )}
    </div>
  );
}
