import { loadStripe, Stripe } from '@stripe/stripe-js';
import React from 'react';

let stripePromise: Promise<Stripe | null> | null = null;

export async function getStripePromise(): Promise<Stripe | null> {
  if (stripePromise) return stripePromise;
  
  try {
    const res = await fetch('/api/stripe/config', { credentials: 'include' });
    if (!res.ok) return null;
    const { publishableKey } = await res.json();
    if (!publishableKey) return null;
    stripePromise = loadStripe(publishableKey);
    return stripePromise;
  } catch {
    return null;
  }
}

export type Mode = 'member' | 'visitor';
export type MemberStep = 'form' | 'preview' | 'payment' | 'success';
export type VisitorStep = 'form' | 'payment' | 'success';

export interface MembershipTier {
  id: number;
  name: string;
  slug: string;
  priceCents: number;
  stripePriceId: string | null;
  productType: string;
}

export interface DayPassProduct {
  id: string;
  name: string;
  priceCents: number;
  stripePriceId: string;
}

export interface GroupMember {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  tierId: number | null;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface ExistingBillingGroup {
  id: number;
  primaryEmail: string;
  primaryName: string;
  groupName: string | null;
  groupType: 'family' | 'corporate';
  isActive: boolean;
  primaryStripeSubscriptionId: string | null;
  memberCount: number;
}

export interface MemberFormData {
  tierId: number | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  discountCode: string;
  addGroupMembers: boolean;
  groupMembers: GroupMember[];
  joinExistingGroup: boolean;
  existingGroupId: number | null;
  existingGroupType: 'family' | 'corporate' | null;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface VisitorFormData {
  productId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  notes: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface NewUserDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (userData: { id: string; email: string; name: string; mode: Mode }) => void;
  onBookNow?: (visitorData: { id: string; email: string; name: string; phone: string }) => void;
  defaultMode?: Mode;
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_REGEX = /^[\d\s\-\+\(\)\.]+$/;

export const initialMemberForm: MemberFormData = {
  tierId: null,
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dob: '',
  discountCode: '',
  addGroupMembers: false,
  groupMembers: [],
  joinExistingGroup: false,
  existingGroupId: null,
  existingGroupType: null,
  streetAddress: '',
  city: '',
  state: '',
  zipCode: '',
};

export const initialVisitorForm: VisitorFormData = {
  productId: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dob: '',
  notes: '',
  streetAddress: '',
  city: '',
  state: '',
  zipCode: '',
};

export interface MemberFlowProps {
  step: MemberStep;
  form: MemberFormData;
  setForm: React.Dispatch<React.SetStateAction<MemberFormData>>;
  tiers: MembershipTier[];
  discounts: { id: string; code: string; percentOff: number; stripeCouponId?: string }[];
  existingBillingGroups: ExistingBillingGroup[];
  isDark: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setPendingUserToCleanup: (user: { id: string; name: string } | null) => void;
  setStep: (step: MemberStep) => void;
  onSuccess: (user: { id: string; email: string; name: string }) => void;
  createdUser: { id: string; email: string; name: string } | null;
  onClose: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  scannedIdImage: { base64: string; mimeType: string } | null;
  onShowIdScanner: () => void;
}

export interface VisitorFlowProps {
  step: VisitorStep;
  form: VisitorFormData;
  setForm: React.Dispatch<React.SetStateAction<VisitorFormData>>;
  products: DayPassProduct[];
  isDark: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setStep: (step: VisitorStep) => void;
  onSuccess: (user: { id: string; email: string; name: string }) => void;
  createdUser: { id: string; email: string; name: string } | null;
  onClose: () => void;
  onBookNow: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  scannedIdImage: { base64: string; mimeType: string } | null;
  onShowIdScanner: () => void;
}
