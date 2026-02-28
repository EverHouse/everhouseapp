import React, { useCallback } from 'react';
import { MemberSearchInput, SelectedMember } from './MemberSearchInput';

export interface PlayerSlot {
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  type: 'member' | 'guest';
  searchQuery: string;
  selectedId?: string;
  selectedName?: string;
}

export interface PlayerSlotEditorProps {
  playerCount: number;
  onPlayerCountChange: (count: number) => void;
  slots: PlayerSlot[];
  onSlotsChange: (slots: PlayerSlot[]) => void;
  guestPassesRemaining?: number;
  isDark?: boolean;
  privacyMode?: boolean;
  maxPlayers?: number;
  showPlayerCountSelector?: boolean;
}

const PlayerSlotEditor: React.FC<PlayerSlotEditorProps> = ({
  playerCount,
  onPlayerCountChange,
  slots,
  onSlotsChange,
  guestPassesRemaining,
  isDark = true,
  privacyMode = true,
  maxPlayers = 4,
  showPlayerCountSelector = true,
}) => {
  const playerCounts = Array.from({ length: maxPlayers }, (_, i) => i + 1);
  const labels: Record<number, string> = { 1: 'Solo', 2: 'Duo', 3: 'Trio', 4: 'Four' };

  const updateSlot = useCallback((index: number, updates: Partial<PlayerSlot>) => {
    const newSlots = [...slots];
    newSlots[index] = { ...newSlots[index], ...updates };
    onSlotsChange(newSlots);
  }, [slots, onSlotsChange]);

  const handleTypeChange = useCallback((index: number, type: 'member' | 'guest') => {
    const newSlots = [...slots];
    newSlots[index] = { ...newSlots[index], type, searchQuery: '', selectedId: undefined, selectedName: undefined, email: '', name: '', firstName: '', lastName: '' };
    onSlotsChange(newSlots);
  }, [slots, onSlotsChange]);

  const handleClearSelection = useCallback((index: number) => {
    const newSlots = [...slots];
    newSlots[index] = { ...newSlots[index], selectedId: undefined, selectedName: undefined, searchQuery: '', email: '', name: '', firstName: '', lastName: '' };
    onSlotsChange(newSlots);
  }, [slots, onSlotsChange]);

  const handleMemberSelect = useCallback((index: number, member: SelectedMember) => {
    const newSlots = [...slots];
    newSlots[index] = {
      ...newSlots[index],
      selectedId: member.id,
      selectedName: member.name,
      searchQuery: member.name,
      email: member.email,
      name: member.name,
    };
    onSlotsChange(newSlots);
  }, [slots, onSlotsChange]);

  return (
    <>
      {showPlayerCountSelector && (
        <section className={`rounded-xl p-4 border glass-card ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-white/80' : 'text-primary/80'}`}>How many players?</span>
            </div>
          </div>
          <div className={`flex gap-2 p-1 rounded-xl border ${isDark ? 'bg-black/20 border-white/20' : 'bg-black/5 border-black/5'}`}>
            {playerCounts.map(count => (
              <button
                key={count}
                onClick={() => onPlayerCountChange(count)}
                aria-pressed={playerCount === count}
                className={`flex-1 py-3 rounded-lg transition-all duration-fast active:scale-95 focus:ring-2 focus:ring-accent focus:outline-none ${
                  playerCount === count
                    ? 'bg-accent text-[#293515] shadow-glow'
                    : (isDark ? 'text-white/80 hover:bg-white/5 hover:text-white' : 'text-primary/80 hover:bg-black/5 hover:text-primary')
                }`}
              >
                <div className="text-lg font-bold">{count}</div>
                <div className="text-[10px] opacity-70">{labels[count] || count}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {slots.length > 0 && (
        <section className={`rounded-xl p-4 border glass-card relative z-10 overflow-hidden ${isDark ? 'border-white/25' : 'border-black/10'}`}>
          <div className="flex items-center gap-2 mb-3">
            <span className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-white/80' : 'text-primary/80'}`}>Additional Players</span>
            <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>(Optional)</span>
          </div>

          <div className={`mb-3 p-3 rounded-lg text-sm ${isDark ? 'bg-blue-500/10 border border-blue-500/30 text-blue-300' : 'bg-blue-50 border border-blue-200 text-blue-700'}`}>
            <span className="material-symbols-outlined text-sm mr-1 align-middle">info</span>
            Provide guest first name, last name, and email to use your guest passes. Unfilled slots are charged the full guest fee.
          </div>

          <div className="space-y-4">
            {slots.map((slot, index) => {
              const isGuestComplete = slot.type === 'guest' && slot.firstName.trim() !== '' && slot.lastName.trim() !== '' && slot.email.includes('@');
              const isGuestIncomplete = slot.type === 'guest' && !slot.selectedId && (!slot.firstName.trim() || !slot.lastName.trim() || !slot.email.includes('@'));
              const showIndicator = slot.type === 'guest' && !slot.selectedId && (slot.firstName.trim() !== '' || slot.lastName.trim() !== '' || slot.email.trim() !== '');

              return (
                <div key={index} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-primary/70'}`}>
                      Player {index + 2}
                    </label>
                    <div className={`flex rounded-lg border overflow-hidden ${isDark ? 'border-white/20' : 'border-black/10'}`}>
                      <button
                        type="button"
                        onClick={() => handleTypeChange(index, 'member')}
                        className={`px-3 py-1.5 text-xs font-medium transition-all duration-fast ${
                          slot.type === 'member'
                            ? 'bg-accent text-[#293515]'
                            : (isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-primary/60 hover:bg-black/10')
                        }`}
                      >
                        Member
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTypeChange(index, 'guest')}
                        className={`px-3 py-1.5 text-xs font-medium transition-all duration-fast ${
                          slot.type === 'guest'
                            ? 'bg-accent text-[#293515]'
                            : (isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-primary/60 hover:bg-black/10')
                        }`}
                      >
                        Guest
                      </button>
                    </div>
                  </div>
                  
                  <div className="relative">
                    {slot.selectedId ? (
                      <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${
                        isDark 
                          ? 'bg-accent/10 border-accent/30' 
                          : 'bg-accent/10 border-accent/30'
                      }`}>
                        <span className="material-symbols-outlined text-accent text-lg">
                          {slot.type === 'member' ? 'person' : 'person_add'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-primary'}`}>
                            {slot.selectedName}
                          </div>
                          <div className={`text-xs truncate ${isDark ? 'text-white/50' : 'text-primary/50'}`}>
                            {slot.email}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleClearSelection(index)}
                          className={`p-1 rounded-full transition-colors tactile-btn ${
                            isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'
                          }`}
                        >
                          <span className="material-symbols-outlined text-lg opacity-60">close</span>
                        </button>
                      </div>
                    ) : slot.type === 'member' ? (
                      <MemberSearchInput
                        onSelect={(member) => handleMemberSelect(index, member)}
                        onClear={() => handleClearSelection(index)}
                        placeholder="Search members by name..."
                        privacyMode={privacyMode}
                        showTier={false}
                        forceApiSearch
                      />
                    ) : (
                      <div className="space-y-2">
                        <div className="flex gap-2 min-w-0">
                          <input
                            type="text"
                            placeholder="First name..."
                            value={slot.firstName}
                            onChange={(e) => updateSlot(index, { firstName: e.target.value, name: `${e.target.value} ${slot.lastName}`.trim() })}
                            className={`flex-1 min-w-0 px-3 py-2.5 rounded-lg border text-sm transition-all duration-fast focus:ring-2 focus:ring-accent focus:outline-none ${
                              isDark 
                                ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40' 
                                : 'bg-black/5 border-black/10 text-primary placeholder:text-primary/40'
                            }`}
                          />
                          <input
                            type="text"
                            placeholder="Last name..."
                            value={slot.lastName}
                            onChange={(e) => updateSlot(index, { lastName: e.target.value, name: `${slot.firstName} ${e.target.value}`.trim() })}
                            className={`flex-1 min-w-0 px-3 py-2.5 rounded-lg border text-sm transition-all duration-fast focus:ring-2 focus:ring-accent focus:outline-none ${
                              isDark 
                                ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40' 
                                : 'bg-black/5 border-black/10 text-primary placeholder:text-primary/40'
                            }`}
                          />
                        </div>
                        <input
                          type="email"
                          placeholder="Guest email..."
                          value={slot.email}
                          onChange={(e) => updateSlot(index, { email: e.target.value })}
                          className={`w-full px-3 py-2.5 rounded-lg border text-sm transition-all duration-fast focus:ring-2 focus:ring-accent focus:outline-none ${
                            isDark 
                              ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40' 
                              : 'bg-black/5 border-black/10 text-primary placeholder:text-primary/40'
                          }`}
                        />
                        {showIndicator && (
                          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
                            isGuestComplete
                              ? (isDark ? 'text-green-400' : 'text-green-600')
                              : (isDark ? 'text-amber-400' : 'text-amber-600')
                          }`}>
                            <span className="material-symbols-outlined text-sm">
                              {isGuestComplete ? 'check_circle' : 'warning'}
                            </span>
                            {isGuestComplete ? 'Pass eligible' : 'Provide first name, last name & email to use pass'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {guestPassesRemaining !== undefined && (
            <div className={`mt-3 pt-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-black/5'}`}>
              <span className={`text-xs ${isDark ? 'text-white/50' : 'text-primary/50'}`}>Guest passes remaining</span>
              <span className={`text-xs font-semibold ${isDark ? 'text-white/70' : 'text-primary/70'}`}>{guestPassesRemaining}</span>
            </div>
          )}
        </section>
      )}
    </>
  );
};

export default PlayerSlotEditor;
