import React from 'react';
import { formatPhoneNumber } from '../../../utils/formatting';
import { Section, Row } from './ProfileShared';

interface AccountSectionProps {
  isDark: boolean;
  isStaffOrAdminProfile: boolean;
  editingProfile: boolean;
  setEditingProfile: (v: boolean) => void;
  editFirstName: string;
  setEditFirstName: (v: string) => void;
  editLastName: string;
  setEditLastName: (v: string) => void;
  editPhone: string;
  setEditPhone: (v: string) => void;
  handleStartEdit: () => void;
  handleSaveProfile: () => void;
  updateProfilePending: boolean;
  user: { name?: string | null; email: string; phone?: string | null };
  staffPhone?: string;
}

const AccountSection: React.FC<AccountSectionProps> = ({
  isDark,
  isStaffOrAdminProfile,
  editingProfile,
  setEditingProfile,
  editFirstName,
  setEditFirstName,
  editLastName,
  setEditLastName,
  editPhone,
  setEditPhone,
  handleStartEdit,
  handleSaveProfile,
  updateProfilePending,
  user,
  staffPhone,
}) => {
  return (
    <Section title="Account" isDark={isDark} staggerIndex={1}>
      {editingProfile ? (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-medium mb-1 block ${isDark ? 'opacity-70' : 'text-primary/70'}`}>First Name</label>
              <input
                type="text"
                value={editFirstName}
                onChange={(e) => setEditFirstName(e.target.value)}
                className={`w-full px-3 py-2 rounded-xl text-sm border transition-colors ${
                  isDark 
                    ? 'bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-white/40' 
                    : 'bg-white border-black/10 text-primary placeholder:text-primary/40 focus:border-primary/40'
                } outline-none`}
                placeholder="First name"
              />
            </div>
            <div>
              <label className={`text-xs font-medium mb-1 block ${isDark ? 'opacity-70' : 'text-primary/70'}`}>Last Name</label>
              <input
                type="text"
                value={editLastName}
                onChange={(e) => setEditLastName(e.target.value)}
                className={`w-full px-3 py-2 rounded-xl text-sm border transition-colors ${
                  isDark 
                    ? 'bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-white/40' 
                    : 'bg-white border-black/10 text-primary placeholder:text-primary/40 focus:border-primary/40'
                } outline-none`}
                placeholder="Last name"
              />
            </div>
          </div>
          <div>
            <label className={`text-xs font-medium mb-1 block ${isDark ? 'opacity-70' : 'text-primary/70'}`}>Phone</label>
            <input
              type="tel"
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
              className={`w-full px-3 py-2 rounded-xl text-sm border transition-colors ${
                isDark 
                  ? 'bg-white/10 border-white/20 text-white placeholder:text-white/40 focus:border-white/40' 
                  : 'bg-white border-black/10 text-primary placeholder:text-primary/40 focus:border-primary/40'
              } outline-none`}
              placeholder="(555) 123-4567"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSaveProfile}
              disabled={updateProfilePending}
              className={`tactile-btn flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors ${
                updateProfilePending ? 'opacity-50 cursor-not-allowed' : ''
              } bg-primary text-white hover:bg-primary/90`}
            >
              {updateProfilePending ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => setEditingProfile(false)}
              disabled={updateProfilePending}
              className={`tactile-btn flex-1 py-2.5 rounded-xl font-semibold text-sm transition-colors ${
                isDark 
                  ? 'bg-white/10 text-white hover:bg-white/20' 
                  : 'bg-black/5 text-primary hover:bg-black/10'
              }`}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <Row icon="person" label="Name" value={(user.name || '').includes('@') ? 'Not set' : (user.name || 'Not set')} isDark={isDark} />
          <Row icon="mail" label="Email" value={user.email} isDark={isDark} />
          <Row icon="call" label="Phone" value={formatPhoneNumber(staffPhone || user.phone)} isDark={isDark} />
          {!isStaffOrAdminProfile && (
            <div className="px-4 pb-4 pt-3">
              <button
                onClick={handleStartEdit}
                className={`tactile-btn w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-fast ${
                  isDark 
                    ? 'bg-accent/20 text-accent hover:bg-accent/30' 
                    : 'bg-primary/10 text-primary hover:bg-primary/20'
                }`}
              >
                <span className="material-symbols-outlined text-base">edit</span>
                Edit Profile
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
};

export default AccountSection;
