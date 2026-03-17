import React from 'react';
import { MemberSearchInput, type SelectedMember } from '../../../shared/MemberSearchInput';
import type { SavedCardInfo } from './posTypes';

interface POSCustomerSectionProps {
  useGuestCheckout: boolean;
  setUseGuestCheckout: (v: boolean) => void;
  useNewCustomer: boolean;
  setUseNewCustomer: (v: boolean) => void;
  selectedMember: SelectedMember | null;
  setSelectedMember: (m: SelectedMember | null) => void;
  newCustomerFirstName: string;
  setNewCustomerFirstName: (v: string) => void;
  newCustomerLastName: string;
  setNewCustomerLastName: (v: string) => void;
  newCustomerEmail: string;
  setNewCustomerEmail: (v: string) => void;
  newCustomerPhone: string;
  setNewCustomerPhone: (v: string) => void;
  scannedIdImage: { base64: string; mimeType: string } | null;
  setScannedIdImage: (v: { base64: string; mimeType: string } | null) => void;
  setSavedCard: (v: SavedCardInfo | null) => void;
  setShowIdScanner: (v: boolean) => void;
}

const POSCustomerSection: React.FC<POSCustomerSectionProps> = ({
  useGuestCheckout,
  setUseGuestCheckout,
  useNewCustomer,
  setUseNewCustomer,
  selectedMember,
  setSelectedMember,
  newCustomerFirstName,
  setNewCustomerFirstName,
  newCustomerLastName,
  setNewCustomerLastName,
  newCustomerEmail,
  setNewCustomerEmail,
  newCustomerPhone,
  setNewCustomerPhone,
  scannedIdImage,
  setScannedIdImage,
  setSavedCard,
  setShowIdScanner,
}) => {
  if (useGuestCheckout) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30">
          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">bolt</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Quick Guest Checkout</p>
            <p className="text-xs text-amber-600 dark:text-amber-400">No customer info needed — terminal only</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setUseGuestCheckout(false);
            setUseNewCustomer(false);
          }}
          className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-base">search</span>
          Search existing
        </button>
      </div>
    );
  }

  if (!useNewCustomer) {
    return (
      <div className="space-y-2">
        <MemberSearchInput
          label="Customer"
          placeholder="Search by name or email..."
          selectedMember={selectedMember}
          onSelect={(member) => setSelectedMember(member)}
          onClear={() => setSelectedMember(null)}
          includeVisitors={true}
          includeFormer={true}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setUseNewCustomer(true);
              setSelectedMember(null);
            }}
            className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-base">person_add</span>
            New Customer
          </button>
          <button
            type="button"
            onClick={() => {
              setUseGuestCheckout(true);
              setUseNewCustomer(false);
              setSelectedMember(null);
              setSavedCard(null);
            }}
            className="text-sm text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 flex items-center gap-1 font-medium"
          >
            <span className="material-symbols-outlined text-base">bolt</span>
            Quick Guest
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-primary dark:text-white">New Customer</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowIdScanner(true)}
            className="text-sm text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-base">badge</span>
            Scan ID
          </button>
          <button
            type="button"
            onClick={() => {
              setUseNewCustomer(false);
              setNewCustomerFirstName('');
              setNewCustomerLastName('');
              setNewCustomerEmail('');
              setNewCustomerPhone('');
              setScannedIdImage(null);
            }}
            className="text-sm text-primary/60 dark:text-white/60 hover:text-primary dark:hover:text-white flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-base">search</span>
            Search existing
          </button>
          <button
            type="button"
            onClick={() => {
              setUseGuestCheckout(true);
              setUseNewCustomer(false);
              setSelectedMember(null);
              setSavedCard(null);
              setNewCustomerFirstName('');
              setNewCustomerLastName('');
              setNewCustomerEmail('');
              setNewCustomerPhone('');
              setScannedIdImage(null);
            }}
            className="text-sm text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 flex items-center gap-1 font-medium"
          >
            <span className="material-symbols-outlined text-base">bolt</span>
            Quick Guest
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
            First Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={newCustomerFirstName}
            onChange={(e) => setNewCustomerFirstName(e.target.value)}
            placeholder="John"
            className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
            Last Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={newCustomerLastName}
            onChange={(e) => setNewCustomerLastName(e.target.value)}
            placeholder="Doe"
            className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
          Email <span className="text-red-500">*</span>
        </label>
        <input
          type="email"
          value={newCustomerEmail}
          onChange={(e) => setNewCustomerEmail(e.target.value)}
          placeholder="john@example.com"
          className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-primary/60 dark:text-white/60 mb-1">
          Phone (optional)
        </label>
        <input
          type="tel"
          value={newCustomerPhone}
          onChange={(e) => setNewCustomerPhone(e.target.value)}
          placeholder="(555) 123-4567"
          className="w-full px-3 py-2.5 rounded-xl bg-white/80 dark:bg-white/10 border border-primary/20 dark:border-white/20 text-primary dark:text-white placeholder:text-primary/40 dark:placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
        />
      </div>
      {scannedIdImage && (
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs mt-1">
          <span className="material-symbols-outlined text-sm">check_circle</span>
          ID scanned — image will be saved with this customer
        </div>
      )}
    </div>
  );
};

export default POSCustomerSection;
