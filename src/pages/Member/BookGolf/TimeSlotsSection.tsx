import React from 'react';
import { haptic } from '../../../utils/haptics';
import { EmptySlots } from '../../../components/EmptyState';
import type { TimeSlot } from './bookGolfTypes';

interface HourGroup {
  hourLabel: string;
  hour24: string;
  slots: TimeSlot[];
  totalAvailable: number;
}

interface TimeSlotsSectionProps {
  slotsByHour: HourGroup[];
  selectedSlot: TimeSlot | null;
  setSelectedSlot: (s: TimeSlot | null) => void;
  setSelectedResource: (r: null) => void;
  expandedHour: string | null;
  setExpandedHour: (h: string | null) => void;
  isLoading: boolean;
  isDark: boolean;
  activeTab: 'simulator' | 'conference';
  dates: Array<{ label: string; date: string; day: string; dateNum: string }>;
  selectedDateObj: { date: string } | null;
  setSelectedDateObj: (d: { label: string; date: string; day: string; dateNum: string }) => void;
  timeSlotsRef: React.RefObject<HTMLDivElement | null>;
  timeSlotsAnimRef: (el: HTMLElement | null) => void;
}

const TimeSlotsSection: React.FC<TimeSlotsSectionProps> = ({
  slotsByHour, selectedSlot, setSelectedSlot, setSelectedResource,
  expandedHour, setExpandedHour, isLoading, isDark, activeTab,
  dates, selectedDateObj, setSelectedDateObj, timeSlotsRef, timeSlotsAnimRef,
}) => {
  return (
    <section ref={timeSlotsRef} className="min-h-[120px]">
      <h3 className={`text-[11px] font-bold uppercase tracking-[0.2em] mb-3 ${isDark ? 'text-white/80' : 'text-primary/80'}`} style={{ fontFamily: 'var(--font-label)' }}>Available Times</h3>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`h-14 rounded-xl animate-pulse ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
          ))}
        </div>
      )}
      <div className={`transition-opacity duration-normal ${isLoading ? 'opacity-0 hidden' : 'opacity-100'}`}>
        <div ref={timeSlotsAnimRef} className="space-y-2">
          {slotsByHour.map((hourGroup) => {
            const isExpanded = expandedHour === hourGroup.hour24;
            const hasSelectedSlot = hourGroup.slots.some(s => selectedSlot?.id === s.id);

            return (
              <div key={hourGroup.hour24}>
                <button
                  onClick={() => { haptic.light(); setExpandedHour(isExpanded ? null : hourGroup.hour24); }}
                  className={`w-full p-4 rounded-xl border text-left transition-all duration-fast active:scale-[0.99] flex items-center justify-between ${
                    hasSelectedSlot
                      ? (isDark ? 'bg-white/10 border-white/30' : 'bg-primary/5 border-primary/20')
                      : isExpanded
                        ? (isDark ? 'border-white/20 bg-white/10' : 'bg-white border-black/20')
                        : (isDark ? 'bg-transparent border-white/15 hover:bg-white/5' : 'bg-white border-black/10 hover:bg-black/5')
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`material-symbols-outlined text-xl transition-transform duration-fast ${isExpanded ? 'rotate-90' : ''} ${
                      hasSelectedSlot ? (isDark ? 'text-accent' : 'text-accent-dark') : (isDark ? 'text-white/80' : 'text-primary/80')
                    }`}>chevron_right</span>
                    <div>
                      <div className={`font-bold text-base ${hasSelectedSlot ? (isDark ? 'text-accent' : 'text-primary') : (isDark ? 'text-white' : 'text-primary')}`}>
                        {hourGroup.hourLabel}
                      </div>
                      <div className={`text-[10px] font-bold uppercase tracking-wide ${hasSelectedSlot ? 'text-accent-dark/80 dark:text-accent/80' : 'opacity-50'}`}>
                        {hourGroup.slots.length} {hourGroup.slots.length === 1 ? 'time' : 'times'} · {hourGroup.totalAvailable} {activeTab === 'simulator' ? 'bays' : 'rooms'}
                      </div>
                    </div>
                  </div>
                  {hasSelectedSlot && (
                    <span className="material-symbols-outlined text-accent-dark dark:text-accent">check_circle</span>
                  )}
                </button>

                <div className={`grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 overflow-hidden transition-all duration-normal ease-out ${
                  isExpanded ? 'max-h-[500px] opacity-100 mt-2 pl-6' : 'max-h-0 opacity-0'
                }`}>
                  {hourGroup.slots.map((slot, slotIndex) => {
                    const isRequestedOnly = !slot.available && slot.requestedResourceDbIds.length > 0;
                    if (isRequestedOnly) {
                      return (
                        <div
                          key={slot.id}
                          className={`p-3 rounded-xl border text-left opacity-50 cursor-not-allowed ${
                            isDark ? 'bg-white/5 border-amber-500/30' : 'bg-amber-50 border-amber-200'
                          }`}
                          style={{ '--stagger-index': slotIndex } as React.CSSProperties}
                        >
                          <div className={`font-bold text-sm ${isDark ? 'text-white/60' : 'text-primary/60'}`}>{slot.start}</div>
                          <div className={`text-[10px] font-bold uppercase tracking-wide ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>Requested</div>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={slot.id}
                        onClick={() => { haptic.light(); setSelectedSlot(slot); setSelectedResource(null); }}
                        aria-pressed={selectedSlot?.id === slot.id}
                        className={`p-3 rounded-[4px] border text-left transition-all duration-fast active:scale-[0.98] focus:ring-2 focus:ring-accent focus:outline-none ${
                          selectedSlot?.id === slot.id
                            ? (isDark ? 'bg-white text-primary border-white' : 'bg-primary text-white border-primary')
                            : (isDark ? 'bg-transparent text-white hover:bg-white/10 border-white/15' : 'bg-white text-primary hover:bg-black/5 border-black/10')
                        }`}
                        style={{ '--stagger-index': slotIndex } as React.CSSProperties}
                      >
                        <div className="font-bold text-sm">{slot.start}</div>
                        <div className={`text-[10px] font-bold uppercase tracking-wide ${selectedSlot?.id === slot.id ? 'opacity-80' : 'opacity-40'}`}>
                          {slot.availableResourceDbIds.length} {activeTab === 'simulator' ? 'bays' : 'rooms'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {slotsByHour.length === 0 && !isLoading && (
            <EmptySlots onChangeDate={dates.length > 1 ? () => {
              if (selectedDateObj) {
                const currentIdx = dates.findIndex(d => d.date === selectedDateObj.date);
                const nextIdx = (currentIdx + 1) % dates.length;
                setSelectedDateObj(dates[nextIdx]);
              }
            } : undefined} />
          )}
        </div>
      </div>
    </section>
  );
};

export default TimeSlotsSection;
