import React, { useState, useEffect } from 'react';
import SlideUpDrawer from '../SlideUpDrawer';
import Input from '../Input';
import { useTheme } from '../../contexts/ThemeContext';

interface GuestEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (name: string, email?: string) => void;
  isSocialTier: boolean;
}

const NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 255;

const GuestEntryModal: React.FC<GuestEntryModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  isSocialTier
}) => {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [emailError, setEmailError] = useState<string | undefined>();

  useEffect(() => {
    if (!isOpen) {
      setName('');
      setEmail('');
      setNameError(undefined);
      setEmailError(undefined);
    }
  }, [isOpen]);

  const validateName = (value: string): string | undefined => {
    if (!value.trim()) {
      return 'Name is required';
    }
    if (value.length > NAME_MAX_LENGTH) {
      return `Name must be ${NAME_MAX_LENGTH} characters or less`;
    }
    return undefined;
  };

  const validateEmail = (value: string): string | undefined => {
    if (!value.trim()) {
      return 'Email is required for guest tracking';
    }
    if (value.length > EMAIL_MAX_LENGTH) {
      return `Email must be ${EMAIL_MAX_LENGTH} characters or less`;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      return 'Please enter a valid email address';
    }
    return undefined;
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setName(value);
    if (nameError) {
      setNameError(validateName(value));
    }
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    if (emailError) {
      setEmailError(validateEmail(value));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const nameErr = validateName(name);
    const emailErr = validateEmail(email);
    
    setNameError(nameErr);
    setEmailError(emailErr);
    
    if (nameErr || emailErr || isSocialTier) {
      return;
    }
    
    onAdd(name.trim(), email.trim() || undefined);
    onClose();
  };

  const isSubmitDisabled = isSocialTier || !name.trim() || !email.trim();

  const footerContent = (
    <div className="flex gap-3 p-4">
      <button
        type="button"
        onClick={onClose}
        className={`flex-1 py-3 px-4 rounded-2xl font-semibold text-sm transition-all active:scale-[0.98] ${
          isDark
            ? 'bg-white/10 text-white hover:bg-white/15'
            : 'bg-black/5 text-[#293515] hover:bg-black/10'
        }`}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="guest-entry-form"
        disabled={isSubmitDisabled}
        className={`flex-1 py-3 px-4 rounded-2xl font-semibold text-sm transition-all active:scale-[0.98] ${
          isSubmitDisabled
            ? isDark
              ? 'bg-white/10 text-white/40 cursor-not-allowed'
              : 'bg-black/5 text-black/30 cursor-not-allowed'
            : 'bg-[#293515] text-white hover:bg-[#3a4a20]'
        }`}
      >
        Add Guest
      </button>
    </div>
  );

  return (
    <SlideUpDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Add Guest"
      maxHeight="medium"
      stickyFooter={footerContent}
    >
      <form id="guest-entry-form" onSubmit={handleSubmit} className="p-4 space-y-4">
        {isSocialTier && (
          <div className={`p-4 rounded-2xl flex items-start gap-3 ${
            isDark 
              ? 'bg-red-500/10 border border-red-500/30' 
              : 'bg-red-50 border border-red-200'
          }`}>
            <span className={`material-symbols-outlined text-xl flex-shrink-0 ${
              isDark ? 'text-red-400' : 'text-red-600'
            }`}>
              error
            </span>
            <p className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
              Social tier members cannot bring guests to simulator bookings
            </p>
          </div>
        )}
        
        <Input
          label="Name"
          placeholder="Enter guest's full name"
          value={name}
          onChange={handleNameChange}
          icon="person"
          error={nameError}
          maxLength={NAME_MAX_LENGTH}
          required
          disabled={isSocialTier}
        />
        
        <Input
          label="Email"
          placeholder="Enter guest's email address"
          type="email"
          value={email}
          onChange={handleEmailChange}
          icon="mail"
          error={emailError}
          maxLength={EMAIL_MAX_LENGTH}
          required
          disabled={isSocialTier}
        />
      </form>
    </SlideUpDrawer>
  );
};

export default GuestEntryModal;
