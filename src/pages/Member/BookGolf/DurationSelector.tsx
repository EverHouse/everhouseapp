import React from 'react';
import { haptic } from '../../../utils/haptics';

interface DurationSelectorProps {
  activeTab: 'simulator' | 'conference';
  playerCount: number;
  duration: number;
  setDuration: (d: number) => void;
  setExpandedHour: (h: string | null) => void;
  setHasUserSelectedDuration: (v: boolean) => void;
  isDark: boolean;
  usedMinutesForDay: number;
  overageRatePerBlockDollars: number;
  tierPermissions: { dailyConfRoomMinutes: number; dailySimulatorMinutes: number };
}

const getSimulatorDurations = (players: number): number[] => {
  switch (players) {
    case 1: return [30, 60, 90, 120, 150, 180, 210, 240];
    case 2: return [60, 120, 180, 240];
    case 3: return [90, 120, 150, 180, 270];
    case 4: return [120, 180, 240];
    default: return [60, 120, 180, 240];
  }
};

const DurationSelector: React.FC<DurationSelectorProps> = ({
  activeTab, playerCount, duration, setDuration, setExpandedHour, setHasUserSelectedDuration,
  isDark, usedMinutesForDay, overageRatePerBlockDollars, tierPermissions,
}) => {
  const baseDurations = activeTab === 'simulator'
    ? getSimulatorDurations(playerCount)
    : [30, 60, 90, 120, 150, 180, 210, 240];

  if (baseDurations.length === 0) {
    return (
      <div className={`col-span-2 py-2.5 text-center text-xs ${isDark ? 'text-white/60' : 'text-primary/60'}`}>
        No time remaining for this date
      </div>
    );
  }

  const dailyAllowance = activeTab === 'conference'
    ? (tierPermissions.dailyConfRoomMinutes || 0)
    : (tierPermissions.dailySimulatorMinutes || 0);

  return (
    <>
      {baseDurations.map(mins => {
        const perPersonMins = activeTab === 'simulator' ? Math.floor(mins / playerCount) : mins;
        const isLowTime = activeTab === 'simulator' && playerCount >= 3 && mins <= 60;
        const recommendedMins = playerCount * 30;
        const myUsageMinutes = perPersonMins;
        const overageMinutes = Math.max(0, (usedMinutesForDay + myUsageMinutes) - dailyAllowance);
        const overageBlocks = Math.ceil(overageMinutes / 30);
        const overageFee = overageBlocks * overageRatePerBlockDollars;
        const hasOverage = overageMinutes > 0;

        return (
          <button
            key={mins}
            onClick={() => { haptic.selection(); setDuration(mins); setExpandedHour(null); setHasUserSelectedDuration(true); }}
            aria-pressed={duration === mins}
            className={`relative p-3 rounded-[4px] border transition-all duration-fast ease-spring-smooth active:scale-95 focus:ring-2 focus:ring-accent focus:outline-none ${
              duration === mins
                ? (isDark ? 'bg-white text-primary border-white' : 'bg-primary text-white border-primary')
                : isLowTime
                  ? (isDark ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700')
                  : (isDark ? 'bg-transparent border-white/20 text-white/80 hover:bg-white/5' : 'bg-white border-black/10 text-primary/80 hover:bg-black/5')
            }`}
          >
            <div className="text-lg font-bold">{mins}m</div>
            {activeTab === 'simulator' && (
              <div className={`text-[10px] ${duration === mins ? 'opacity-80' : 'opacity-60'}`}>
                {perPersonMins} min each
              </div>
            )}
            {isLowTime && duration !== mins && (
              <div className="text-[9px] mt-1 opacity-80">
                Rec: {recommendedMins}m+
              </div>
            )}
            {hasOverage && duration !== mins && (
              <div className={`absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                isDark ? 'bg-amber-500 text-black' : 'bg-amber-500 text-white'
              }`}>
                ${overageFee}
              </div>
            )}
          </button>
        );
      })}
    </>
  );
};

export default DurationSelector;
