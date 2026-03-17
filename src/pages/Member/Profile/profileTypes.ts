export interface AccountBalanceData {
  balanceDollars: number;
  isCredit: boolean;
}

export interface StaffDetailsData {
  phone?: string;
  job_title?: string;
}

export interface WaiverStatusData {
  needsWaiverUpdate?: boolean;
  currentVersion?: string;
}

export interface PreferencesData {
  emailOptIn: boolean | null;
  smsOptIn: boolean | null;
  smsPromoOptIn?: boolean | null;
  smsTransactionalOptIn?: boolean | null;
  smsRemindersOptIn?: boolean | null;
  doNotSellMyInfo: boolean;
  dataExportRequestedAt: string | null;
}

export interface StaffAdminCheckData {
  hasPassword: boolean;
}
