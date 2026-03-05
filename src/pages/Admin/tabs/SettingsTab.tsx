import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithCredentials, postWithCredentials } from '../../../hooks/queries/useFetch';
import Toggle from '../../../components/Toggle';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';

interface SettingsState {
  dataIntegrityAlerts: boolean;
  syncFailureAlerts: boolean;
  contactPhone: string;
  contactEmail: string;
  addressLine1: string;
  addressLine2: string;
  cityStateZip: string;
  formerlyKnownAs: string;
  googleMapsUrl: string;
  appleMapsQuery: string;
  instagramUrl: string;
  tiktokUrl: string;
  linkedinUrl: string;
  appleMessagesEnabled: boolean;
  appleMessagesBusinessId: string;
  hoursMonday: string;
  hoursTuesdayThursday: string;
  hoursFridaySaturday: string;
  hoursSunday: string;
  resourceGolfSlotDuration: string;
  resourceConferenceSlotDuration: string;
  resourceToursSlotDuration: string;
  hubspotTiers: Record<string, string>;
  hubspotStatuses: Record<string, string>;
  dailyReminderHour: string;
  morningClosureHour: string;
  onboardingNudgeHour: string;
  gracePeriodHour: string;
  maxOnboardingNudges: string;
  gracePeriodDays: string;
  trialCouponCode: string;
}

const HUBSPOT_TIER_KEYS = [
  'core', 'core-founding', 'premium', 'premium-founding',
  'social', 'social-founding', 'vip', 'corporate', 'group-lessons'
] as const;

const HUBSPOT_STATUS_KEYS = [
  { key: 'active', label: 'active' },
  { key: 'trialing', label: 'trialing' },
  { key: 'past_due', label: 'past_due' },
  { key: 'inactive', label: 'inactive' },
  { key: 'cancelled', label: 'cancelled' },
  { key: 'expired', label: 'expired' },
  { key: 'terminated', label: 'terminated' },
  { key: 'former_member', label: 'former_member' },
  { key: 'pending', label: 'pending' },
  { key: 'suspended', label: 'suspended' },
  { key: 'frozen', label: 'frozen' },
  { key: 'non-member', label: 'non-member' },
  { key: 'deleted', label: 'deleted' },
] as const;

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
  const ampm = i < 12 ? 'AM' : 'PM';
  return { value: String(i), label: `${hour12}:00 ${ampm}` };
});

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 === 0 ? '00' : '30';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return { value: `${hour12}:${minute} ${ampm}`, label: `${hour12}:${minute} ${ampm}` };
});

function parseHoursString(str: string): { closed: boolean; open: string; close: string } {
  if (!str || str.toLowerCase() === 'closed') return { closed: true, open: '8:30 AM', close: '8:00 PM' };
  const parts = str.split(/\s*[–\-]\s*/);
  if (parts.length === 2) return { closed: false, open: parts[0].trim(), close: parts[1].trim() };
  return { closed: false, open: '8:30 AM', close: '8:00 PM' };
}

function formatHoursString(closed: boolean, open: string, close: string): string {
  if (closed) return 'Closed';
  return `${open} – ${close}`;
}

const inputClass = "w-full px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent";
const inputSmClass = "flex-1 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-accent text-sm";
const sectionClass = "bg-white/60 dark:bg-white/5 backdrop-blur-lg rounded-xl p-6 border border-primary/10 dark:border-white/20";

const SectionHeader: React.FC<{ icon: string; title: string; subtitle: string }> = ({ icon, title, subtitle }) => (
  <div className="flex items-center gap-3 mb-6">
    <div className="w-10 h-10 rounded-xl bg-primary/10 dark:bg-white/10 flex items-center justify-center">
      <span aria-hidden="true" className="material-symbols-outlined text-primary dark:text-white">{icon}</span>
    </div>
    <div>
      <h3 className="text-2xl leading-tight text-primary dark:text-white" style={{ fontFamily: 'var(--font-headline)' }}>{title}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
    </div>
  </div>
);

const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <label className="block text-sm font-medium text-primary dark:text-white mb-1">{children}</label>
);

const SubSectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="pt-4 pb-1 border-t border-gray-200/50 dark:border-white/10 mt-2">
    <p className="text-xs font-bold text-primary/50 dark:text-white/50 uppercase tracking-widest">{children}</p>
  </div>
);

const SettingsTab: React.FC = () => {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const defaultSettings: SettingsState = {
    dataIntegrityAlerts: true,
    syncFailureAlerts: true,
    contactPhone: '(949) 545-5855',
    contactEmail: 'info@joinever.club',
    addressLine1: '15771 Red Hill Ave, Ste 500',
    addressLine2: '',
    cityStateZip: 'Tustin, CA 92780',
    formerlyKnownAs: 'Formerly Even House (evenhouse.club)',
    googleMapsUrl: 'https://maps.app.goo.gl/Zp93EMzyp9EA3vqA6',
    appleMapsQuery: 'Even+House+Tustin+CA',
    instagramUrl: 'https://www.instagram.com/everclub/',
    tiktokUrl: 'https://www.tiktok.com/@everclub',
    linkedinUrl: 'https://www.linkedin.com/company/ever-club',
    appleMessagesEnabled: false,
    appleMessagesBusinessId: '',
    hoursMonday: 'Closed',
    hoursTuesdayThursday: '8:30 AM – 8:00 PM',
    hoursFridaySaturday: '8:30 AM – 10:00 PM',
    hoursSunday: '8:30 AM – 6:00 PM',
    resourceGolfSlotDuration: '60',
    resourceConferenceSlotDuration: '30',
    resourceToursSlotDuration: '30',
    hubspotTiers: {
      'core': 'Core Membership', 'core-founding': 'Core Membership Founding Members',
      'premium': 'Premium Membership', 'premium-founding': 'Premium Membership Founding Members',
      'social': 'Social Membership', 'social-founding': 'Social Membership Founding Members',
      'vip': 'VIP Membership', 'corporate': 'Corporate Membership', 'group-lessons': 'Group Lessons Membership',
    },
    hubspotStatuses: {
      active: 'Active', trialing: 'trialing', past_due: 'past_due', inactive: 'Suspended',
      cancelled: 'Terminated', expired: 'Expired', terminated: 'Terminated', former_member: 'Terminated',
      pending: 'Pending', suspended: 'Suspended', frozen: 'Froze', 'non-member': 'Non-Member', deleted: 'Terminated',
    },
    dailyReminderHour: '18',
    morningClosureHour: '8',
    onboardingNudgeHour: '10',
    gracePeriodHour: '10',
    maxOnboardingNudges: '3',
    gracePeriodDays: '3',
    trialCouponCode: 'ASTORIA7',
  };

  const [settings, setSettings] = useState<SettingsState>(defaultSettings);

  const { data: fetchedSettings, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const data = await fetchWithCredentials<Record<string, { value: string }>>('/api/settings');

      const hubspotTiers: Record<string, string> = {};
      for (const t of HUBSPOT_TIER_KEYS) {
        hubspotTiers[t] = data[`hubspot.tier.${t}`]?.value || defaultSettings.hubspotTiers[t] || '';
      }

      const hubspotStatuses: Record<string, string> = {};
      for (const s of HUBSPOT_STATUS_KEYS) {
        hubspotStatuses[s.key] = data[`hubspot.status.${s.key}`]?.value || defaultSettings.hubspotStatuses[s.key] || '';
      }

      return {
        dataIntegrityAlerts: data['notifications.data_integrity_alerts']?.value !== 'false',
        syncFailureAlerts: data['notifications.sync_failure_alerts']?.value !== 'false',
        contactPhone: data['contact.phone']?.value || defaultSettings.contactPhone,
        contactEmail: data['contact.email']?.value || defaultSettings.contactEmail,
        addressLine1: data['contact.address_line1']?.value || defaultSettings.addressLine1,
        addressLine2: data['contact.address_line2']?.value || '',
        cityStateZip: data['contact.city_state_zip']?.value || defaultSettings.cityStateZip,
        formerlyKnownAs: data['contact.formerly_known_as']?.value || defaultSettings.formerlyKnownAs,
        googleMapsUrl: data['contact.google_maps_url']?.value || defaultSettings.googleMapsUrl,
        appleMapsQuery: data['contact.apple_maps_query']?.value || defaultSettings.appleMapsQuery,
        instagramUrl: data['social.instagram_url']?.value || defaultSettings.instagramUrl,
        tiktokUrl: data['social.tiktok_url']?.value || defaultSettings.tiktokUrl,
        linkedinUrl: data['social.linkedin_url']?.value || defaultSettings.linkedinUrl,
        appleMessagesEnabled: data['apple_messages.enabled']?.value === 'true',
        appleMessagesBusinessId: data['apple_messages.business_id']?.value || '',
        hoursMonday: data['hours.monday']?.value || defaultSettings.hoursMonday,
        hoursTuesdayThursday: data['hours.tuesday_thursday']?.value || defaultSettings.hoursTuesdayThursday,
        hoursFridaySaturday: data['hours.friday_saturday']?.value || defaultSettings.hoursFridaySaturday,
        hoursSunday: data['hours.sunday']?.value || defaultSettings.hoursSunday,
        resourceGolfSlotDuration: data['resource.golf.slot_duration']?.value || '60',
        resourceConferenceSlotDuration: data['resource.conference.slot_duration']?.value || '30',
        resourceToursSlotDuration: data['resource.tours.slot_duration']?.value || '30',
        hubspotTiers,
        hubspotStatuses,
        dailyReminderHour: data['scheduling.daily_reminder_hour']?.value || '18',
        morningClosureHour: data['scheduling.morning_closure_hour']?.value || '8',
        onboardingNudgeHour: data['scheduling.onboarding_nudge_hour']?.value || '10',
        gracePeriodHour: data['scheduling.grace_period_hour']?.value || '10',
        maxOnboardingNudges: data['scheduling.max_onboarding_nudges']?.value || '3',
        gracePeriodDays: data['scheduling.grace_period_days']?.value || '3',
        trialCouponCode: data['scheduling.trial_coupon_code']?.value || 'ASTORIA7',
      } as SettingsState;
    },
  });

  useEffect(() => {
    if (fetchedSettings) {
      setSettings(fetchedSettings);
      setHasChanges(false);
    }
  }, [fetchedSettings]);

  const saveMutation = useMutation({
    mutationFn: async (settingsToSave: SettingsState) => {
      const payload: Record<string, string> = {
        'notifications.data_integrity_alerts': String(settingsToSave.dataIntegrityAlerts),
        'notifications.sync_failure_alerts': String(settingsToSave.syncFailureAlerts),
        'contact.phone': settingsToSave.contactPhone,
        'contact.email': settingsToSave.contactEmail,
        'contact.address_line1': settingsToSave.addressLine1,
        'contact.address_line2': settingsToSave.addressLine2,
        'contact.city_state_zip': settingsToSave.cityStateZip,
        'contact.formerly_known_as': settingsToSave.formerlyKnownAs,
        'contact.google_maps_url': settingsToSave.googleMapsUrl,
        'contact.apple_maps_query': settingsToSave.appleMapsQuery,
        'social.instagram_url': settingsToSave.instagramUrl,
        'social.tiktok_url': settingsToSave.tiktokUrl,
        'social.linkedin_url': settingsToSave.linkedinUrl,
        'apple_messages.enabled': String(settingsToSave.appleMessagesEnabled),
        'apple_messages.business_id': settingsToSave.appleMessagesBusinessId,
        'hours.monday': settingsToSave.hoursMonday,
        'hours.tuesday_thursday': settingsToSave.hoursTuesdayThursday,
        'hours.friday_saturday': settingsToSave.hoursFridaySaturday,
        'hours.sunday': settingsToSave.hoursSunday,
        'resource.golf.slot_duration': settingsToSave.resourceGolfSlotDuration,
        'resource.conference.slot_duration': settingsToSave.resourceConferenceSlotDuration,
        'resource.tours.slot_duration': settingsToSave.resourceToursSlotDuration,
        'scheduling.daily_reminder_hour': settingsToSave.dailyReminderHour,
        'scheduling.morning_closure_hour': settingsToSave.morningClosureHour,
        'scheduling.onboarding_nudge_hour': settingsToSave.onboardingNudgeHour,
        'scheduling.grace_period_hour': settingsToSave.gracePeriodHour,
        'scheduling.max_onboarding_nudges': settingsToSave.maxOnboardingNudges,
        'scheduling.grace_period_days': settingsToSave.gracePeriodDays,
        'scheduling.trial_coupon_code': settingsToSave.trialCouponCode,
      };

      for (const [key, val] of Object.entries(settingsToSave.hubspotTiers ?? {})) {
        payload[`hubspot.tier.${key}`] = val;
      }
      for (const [key, val] of Object.entries(settingsToSave.hubspotStatuses ?? {})) {
        payload[`hubspot.status.${key}`] = val;
      }

      return fetchWithCredentials('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });
    },
    onSuccess: () => {
      setHasChanges(false);
      setSuccess('Settings saved successfully');
      setTimeout(() => setSuccess(null), 3000);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  const handleReset = () => {
    if (fetchedSettings) {
      setSettings(fetchedSettings);
      setHasChanges(false);
    }
  };

  const updateField = (field: keyof SettingsState, value: string | boolean) => {
    setSettings(prev => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  if (isLoading) {
    return (
      <div className="py-8 flex flex-col items-center gap-2">
        <WalkingGolferSpinner size="md" variant="auto" />
        <p className="text-sm text-gray-500">Loading settings...</p>
      </div>
    );
  }

  const errorMessage = error instanceof Error ? error.message : (saveMutation.error instanceof Error ? saveMutation.error.message : null);

  return (
    <div className="animate-page-enter space-y-6 pb-32 backdrop-blur-sm">
      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-lg text-green-700 dark:text-green-400 text-sm flex items-center gap-2 animate-content-enter">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">check_circle</span>
          {success}
        </div>
      )}

      {errorMessage && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-700 dark:text-red-400 text-sm flex items-center gap-2 animate-content-enter">
          <span aria-hidden="true" className="material-symbols-outlined text-lg">error</span>
          {errorMessage}
        </div>
      )}

      <div className={sectionClass}>
        <SectionHeader icon="contacts" title="Contact & Social Media" subtitle="Club contact info displayed on public pages" />
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Club Phone</FieldLabel>
              <input type="tel" value={settings.contactPhone} onChange={(e) => updateField('contactPhone', e.target.value)} className={inputClass} placeholder="(555) 555-5555" />
            </div>
            <div>
              <FieldLabel>Contact Email</FieldLabel>
              <input type="email" value={settings.contactEmail} onChange={(e) => updateField('contactEmail', e.target.value)} className={inputClass} placeholder="info@example.com" />
            </div>
          </div>
          <div>
            <FieldLabel>Address Line 1</FieldLabel>
            <input type="text" value={settings.addressLine1} onChange={(e) => updateField('addressLine1', e.target.value)} className={inputClass} placeholder="123 Main St" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Address Line 2 / Suite</FieldLabel>
              <input type="text" value={settings.addressLine2} onChange={(e) => updateField('addressLine2', e.target.value)} className={inputClass} placeholder="Suite 100" />
            </div>
            <div>
              <FieldLabel>City, State, Zip</FieldLabel>
              <input type="text" value={settings.cityStateZip} onChange={(e) => updateField('cityStateZip', e.target.value)} className={inputClass} placeholder="City, ST 00000" />
            </div>
          </div>
          <div>
            <FieldLabel>Formerly Known As</FieldLabel>
            <input type="text" value={settings.formerlyKnownAs} onChange={(e) => updateField('formerlyKnownAs', e.target.value)} className={inputClass} placeholder="Leave empty to hide" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Google Maps URL</FieldLabel>
              <input type="url" value={settings.googleMapsUrl} onChange={(e) => updateField('googleMapsUrl', e.target.value)} className={inputClass} placeholder="https://maps.app.goo.gl/..." />
            </div>
            <div>
              <FieldLabel>Apple Maps Query</FieldLabel>
              <input type="text" value={settings.appleMapsQuery} onChange={(e) => updateField('appleMapsQuery', e.target.value)} className={inputClass} placeholder="Business+Name+City+ST" />
            </div>
          </div>

          <SubSectionLabel>Social Media Links</SubSectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel>Instagram URL</FieldLabel>
              <input type="url" value={settings.instagramUrl} onChange={(e) => updateField('instagramUrl', e.target.value)} className={inputClass} placeholder="https://instagram.com/..." />
            </div>
            <div>
              <FieldLabel>TikTok URL</FieldLabel>
              <input type="url" value={settings.tiktokUrl} onChange={(e) => updateField('tiktokUrl', e.target.value)} className={inputClass} placeholder="https://tiktok.com/@..." />
            </div>
            <div>
              <FieldLabel>LinkedIn URL</FieldLabel>
              <input type="url" value={settings.linkedinUrl} onChange={(e) => updateField('linkedinUrl', e.target.value)} className={inputClass} placeholder="https://linkedin.com/company/..." />
            </div>
          </div>

          <SubSectionLabel>Apple Messages for Business</SubSectionLabel>
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
            <div>
              <p className="font-medium text-primary dark:text-white">Enable Apple Messages</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Show Apple Messages button on the contact page</p>
            </div>
            <Toggle
              checked={settings.appleMessagesEnabled}
              onChange={(checked) => updateField('appleMessagesEnabled', checked)}
              size="md"
            />
          </div>
          {settings.appleMessagesEnabled && (
            <div>
              <FieldLabel>Apple Business ID</FieldLabel>
              <input type="text" value={settings.appleMessagesBusinessId} onChange={(e) => updateField('appleMessagesBusinessId', e.target.value)} className={inputClass} placeholder="Enter your Apple Business Messages ID" />
            </div>
          )}

          <SubSectionLabel>Display Hours (Public Pages &amp; Booking Availability)</SubSectionLabel>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">These hours control both the public display and booking slot availability for each day.</p>
          <div className="space-y-3">
            {[
              { label: 'Monday', field: 'hoursMonday' as const },
              { label: 'Tue – Thu', field: 'hoursTuesdayThursday' as const },
              { label: 'Fri – Sat', field: 'hoursFridaySaturday' as const },
              { label: 'Sunday', field: 'hoursSunday' as const },
            ].map(({ label, field }) => {
              const parsed = parseHoursString(settings[field]);
              return (
                <div key={field} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="w-24 flex-shrink-0">
                    <span className="text-sm font-medium text-primary/70 dark:text-white/70">{label}</span>
                  </div>
                  <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={parsed.closed}
                      onChange={(e) => updateField(field, formatHoursString(e.target.checked, parsed.open, parsed.close))}
                      className="rounded border-gray-300 dark:border-white/25"
                    />
                    <span className="text-xs text-gray-500 dark:text-gray-400">Closed</span>
                  </label>
                  {!parsed.closed && (
                    <div className="flex items-center gap-2 w-full sm:w-auto sm:flex-1 min-w-0">
                      <select
                        value={parsed.open}
                        onChange={(e) => updateField(field, formatHoursString(false, e.target.value, parsed.close))}
                        className={inputSmClass + ' !w-auto !flex-1 min-w-0'}
                      >
                        {TIME_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                      <span className="text-gray-400 text-sm flex-shrink-0">–</span>
                      <select
                        value={parsed.close}
                        onChange={(e) => updateField(field, formatHoursString(false, parsed.open, e.target.value))}
                        className={inputSmClass + ' !w-auto !flex-1 min-w-0'}
                      >
                        {TIME_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon="schedule" title="Resource Slot Durations" subtitle="Default booking length per resource type — operating hours follow the Display Hours above" />
        <div className="p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Booking availability uses the Display Hours (above) for each day of the week. Monday = Closed means no bookable slots on Mondays.</p>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Golf Simulators (min)', field: 'resourceGolfSlotDuration' as const },
              { label: 'Conference Room (min)', field: 'resourceConferenceSlotDuration' as const },
              { label: 'Tours (min)', field: 'resourceToursSlotDuration' as const },
            ].map(({ label, field }) => (
              <div key={field}>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</label>
                <input type="number" min="15" max="120" step="15" value={settings[field]} onChange={(e) => updateField(field, e.target.value)} className={inputSmClass} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon="hub" title="HubSpot Contact Mappings" subtitle="Configure how the app maps contact data to HubSpot properties" />
        <div className="space-y-4">
          <div>
            <button onClick={() => toggleSection('hubspotTiers')} className="flex items-center gap-2 w-full text-left py-2">
              <span className="material-symbols-outlined text-sm text-primary/50 dark:text-white/50 transition-transform" style={{ transform: expandedSections.hubspotTiers ? 'rotate(90deg)' : 'rotate(0deg)' }}>chevron_right</span>
              <span className="text-xs font-bold text-primary/50 dark:text-white/50 uppercase tracking-widest">Tier Name Mappings</span>
            </button>
            {expandedSections.hubspotTiers && (
              <div className="space-y-3 mt-2">
                {HUBSPOT_TIER_KEYS.map(key => (
                  <div key={key} className="flex items-center gap-4">
                    <div className="w-36 flex-shrink-0">
                      <span className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-black/30 px-2 py-1 rounded">{key}</span>
                    </div>
                    <input
                      type="text"
                      value={settings.hubspotTiers?.[key] ?? ''}
                      onChange={(e) => {
                        setSettings(prev => ({
                          ...prev,
                          hubspotTiers: { ...(prev.hubspotTiers ?? {}), [key]: e.target.value }
                        }));
                        setHasChanges(true);
                      }}
                      className={inputSmClass}
                      placeholder="HubSpot label"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <button onClick={() => toggleSection('hubspotStatuses')} className="flex items-center gap-2 w-full text-left py-2">
              <span className="material-symbols-outlined text-sm text-primary/50 dark:text-white/50 transition-transform" style={{ transform: expandedSections.hubspotStatuses ? 'rotate(90deg)' : 'rotate(0deg)' }}>chevron_right</span>
              <span className="text-xs font-bold text-primary/50 dark:text-white/50 uppercase tracking-widest">Status Mappings</span>
            </button>
            {expandedSections.hubspotStatuses && (
              <div className="space-y-3 mt-2">
                {HUBSPOT_STATUS_KEYS.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-4">
                    <div className="w-32 flex-shrink-0">
                      <span className="text-xs font-mono text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-black/30 px-2 py-1 rounded">{label}</span>
                    </div>
                    <input
                      type="text"
                      value={settings.hubspotStatuses?.[key] ?? ''}
                      onChange={(e) => {
                        setSettings(prev => ({
                          ...prev,
                          hubspotStatuses: { ...(prev.hubspotStatuses ?? {}), [key]: e.target.value }
                        }));
                        setHasChanges(true);
                      }}
                      className={inputSmClass}
                      placeholder="HubSpot value"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon="notifications_active" title="Notification & Communication" subtitle="Configure notification timing and communication settings" />
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Daily Reminder Hour</FieldLabel>
              <select value={settings.dailyReminderHour} onChange={(e) => updateField('dailyReminderHour', e.target.value)} className={inputClass}>
                {HOUR_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">When to send tomorrow's booking/event reminders</p>
            </div>
            <div>
              <FieldLabel>Morning Closure Alert Hour</FieldLabel>
              <select value={settings.morningClosureHour} onChange={(e) => updateField('morningClosureHour', e.target.value)} className={inputClass}>
                {HOUR_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">When to notify members about today's closures</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>Onboarding Nudge Hour</FieldLabel>
              <select value={settings.onboardingNudgeHour} onChange={(e) => updateField('onboardingNudgeHour', e.target.value)} className={inputClass}>
                {HOUR_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">When to send nudge emails to new members</p>
            </div>
            <div>
              <FieldLabel>Grace Period Check Hour</FieldLabel>
              <select value={settings.gracePeriodHour} onChange={(e) => updateField('gracePeriodHour', e.target.value)} className={inputClass}>
                {HOUR_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1">When to check and send payment grace period reminders</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel>Max Onboarding Nudges</FieldLabel>
              <input type="number" min="1" max="10" value={settings.maxOnboardingNudges} onChange={(e) => updateField('maxOnboardingNudges', e.target.value)} className={inputClass} />
              <p className="text-xs text-gray-400 mt-1">Maximum nudge emails per new member</p>
            </div>
            <div>
              <FieldLabel>Grace Period Days</FieldLabel>
              <input type="number" min="1" max="14" value={settings.gracePeriodDays} onChange={(e) => updateField('gracePeriodDays', e.target.value)} className={inputClass} />
              <p className="text-xs text-gray-400 mt-1">Days before terminating for failed payment</p>
            </div>
            <div>
              <FieldLabel>Trial Coupon Code</FieldLabel>
              <input type="text" value={settings.trialCouponCode} onChange={(e) => updateField('trialCouponCode', e.target.value)} className={inputClass} placeholder="COUPONCODE" />
              <p className="text-xs text-gray-400 mt-1">Promo code included in trial welcome email</p>
            </div>
          </div>
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon="notifications" title="Notification Toggles" subtitle="Configure system notification preferences" />
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
            <div>
              <p className="font-medium text-primary dark:text-white">Data Integrity Check Alerts</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Receive alerts when data integrity issues are detected</p>
            </div>
            <Toggle checked={settings.dataIntegrityAlerts} onChange={(checked) => updateField('dataIntegrityAlerts', checked)} size="md" />
          </div>
          <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-black/20 rounded-xl">
            <div>
              <p className="font-medium text-primary dark:text-white">Sync Failure Alerts</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Receive alerts when external sync operations fail</p>
            </div>
            <Toggle checked={settings.syncFailureAlerts} onChange={(checked) => updateField('syncFailureAlerts', checked)} size="md" />
          </div>
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon="nfc" title="NFC Check-In Setup" subtitle="Generate URLs for NFC tag programming" />
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Program this URL into NFC tags (NTAG215/216) using a free app like NFC Tools. Members tap the tag with their phone to check in.
          </p>
          <div className="flex items-center gap-2">
            <input type="text" readOnly value={`${window.location.origin}/nfc-checkin`} className="flex-1 px-4 py-3 rounded-lg border border-gray-200 dark:border-white/25 bg-gray-50 dark:bg-black/30 text-primary dark:text-white text-sm font-mono select-all" />
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}/nfc-checkin`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch (err) {
                  console.error('Failed to copy:', err);
                }
              }}
              className="tactile-btn px-4 py-3 rounded-lg bg-primary dark:bg-accent text-white dark:text-primary font-medium text-sm hover:opacity-90 transition-opacity whitespace-nowrap flex items-center gap-2"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-base">{copied ? 'check_circle' : 'content_copy'}</span>
              {copied ? 'Copied!' : 'Copy URL'}
            </button>
          </div>
        </div>
      </div>

      {hasChanges && (
        <div className="fixed bottom-20 lg:bottom-6 left-4 right-4 lg:left-72 lg:right-8 bg-white/80 dark:bg-white/10 backdrop-blur-lg border border-primary/10 dark:border-white/20 rounded-xl shadow-lg p-4 flex items-center justify-between gap-4 z-50 animate-slide-up">
          <p className="text-sm text-gray-600 dark:text-gray-400">You have unsaved changes</p>
          <div className="flex items-center gap-3">
            <button onClick={handleReset} disabled={saveMutation.isPending} className="tactile-btn px-4 py-2 rounded-full text-primary dark:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors text-sm font-medium">Reset</button>
            <button onClick={handleSave} disabled={saveMutation.isPending} className="tactile-btn px-6 py-2 rounded-full bg-primary dark:bg-accent text-white dark:text-primary font-medium text-sm disabled:opacity-50 flex items-center gap-2">
              {saveMutation.isPending ? (
                <><span aria-hidden="true" className="material-symbols-outlined animate-spin text-sm">progress_activity</span>Saving...</>
              ) : (
                <><span aria-hidden="true" className="material-symbols-outlined text-sm">save</span>Save Changes</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsTab;
