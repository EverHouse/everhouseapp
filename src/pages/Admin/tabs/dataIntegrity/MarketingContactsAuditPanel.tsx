import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { fetchWithCredentials, postWithCredentials } from '../../../../hooks/queries/useFetch';
import { useToast } from '../../../../components/Toast';

interface AuditContact {
  hubspotId: string;
  email: string;
  firstName: string;
  lastName: string;
  membershipStatus: string;
  lifecycleStage: string;
  tier: string | null;
  createdAt: string | null;
  lastModified: string | null;
  isMarketingContact: boolean;
  category: 'safe_to_remove' | 'review' | 'keep';
  reasons: string[];
  inLocalDb: boolean;
  localDbStatus: string | null;
  localDbRole: string | null;
  lastBookingDate: string | null;
  lastEmailOpen: string | null;
  emailBounced: boolean;
}

interface AuditSummary {
  totalContacts: number;
  totalMarketingContacts: number;
  totalNonMarketing: number;
  safeToRemoveCount: number;
  needsReviewCount: number;
  keepCount: number;
  potentialSavings: number;
}

interface AuditResponse {
  summary: AuditSummary;
  safeToRemove: AuditContact[];
  needsReview: AuditContact[];
  keep: AuditContact[];
}

interface RemoveResponse {
  success: boolean;
  removed: number;
  failed: number;
  errors?: string[];
}

interface MarketingContactsAuditPanelProps {
  isOpen: boolean;
  onToggle: () => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/Los_Angeles',
    });
  } catch {
    return '-';
  }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    trialing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    past_due: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    terminated: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    expired: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
    declined: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    'non-member': 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
    unknown: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  };

  return (
    <span className={`inline-block px-2 py-0.5 rounded-[4px] text-xs font-medium ${colors[status] || colors.unknown}`}>
      {status}
    </span>
  );
}

const MarketingContactsAuditPanel: React.FC<MarketingContactsAuditPanelProps> = ({ isOpen, onToggle }) => {
  const [parent] = useAutoAnimate();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<'safe_to_remove' | 'review' | 'keep'>('safe_to_remove');
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');

  const auditQuery = useQuery<AuditResponse>({
    queryKey: ['hubspot-marketing-audit'],
    queryFn: () => fetchWithCredentials('/api/admin/hubspot/marketing-contacts-audit'),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const queryClient = useQueryClient();

  const removeMutation = useMutation<RemoveResponse, Error, string[]>({
    mutationFn: (contactIds: string[]) =>
      postWithCredentials('/api/admin/hubspot/remove-marketing-contacts', { contactIds }),
    onSuccess: (data, removedIds) => {
      showToast(`Removed ${data.removed} contacts from marketing.${data.failed > 0 ? ` ${data.failed} failed.` : ''}`, data.failed > 0 ? 'warning' : 'success');
      setSelectedContacts(new Set());

      if (data.removed > 0) {
        queryClient.setQueryData<AuditResponse>(['hubspot-marketing-audit'], (old) => {
          if (!old) return old;
          const removedSet = new Set(removedIds);
          const filterOut = (list: AuditContact[]) => list.filter(c => !removedSet.has(c.hubspotId));
          const newSafeToRemove = filterOut(old.safeToRemove);
          const newNeedsReview = filterOut(old.needsReview);
          const newKeep = filterOut(old.keep);
          return {
            ...old,
            safeToRemove: newSafeToRemove,
            needsReview: newNeedsReview,
            keep: newKeep,
            summary: {
              ...old.summary,
              totalMarketingContacts: old.summary.totalMarketingContacts - data.removed,
              totalNonMarketing: old.summary.totalNonMarketing + data.removed,
              safeToRemoveCount: newSafeToRemove.length,
              needsReviewCount: newNeedsReview.length,
              keepCount: newKeep.length,
              potentialSavings: newSafeToRemove.length + newNeedsReview.length,
            },
          };
        });
      }
    },
    onError: (error) => {
      showToast(`Failed to remove contacts: ${error.message}`, 'error');
    },
  });

  const currentList = useMemo(() => {
    if (!auditQuery.data) return [];
    const list = auditQuery.data[activeTab === 'safe_to_remove' ? 'safeToRemove' : activeTab === 'review' ? 'needsReview' : 'keep'];
    if (!searchTerm.trim()) return list;
    const terms = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter(c => {
      const searchable = `${c.firstName} ${c.lastName} ${c.email}`.toLowerCase();
      return terms.every(t => searchable.includes(t));
    });
  }, [auditQuery.data, activeTab, searchTerm]);

  const handleSelectAll = () => {
    if (selectedContacts.size === currentList.length) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(currentList.map(c => c.hubspotId)));
    }
  };

  const handleToggleContact = (id: string) => {
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRemoveSelected = () => {
    if (selectedContacts.size === 0) return;
    const ids = Array.from(selectedContacts);
    removeMutation.mutate(ids);
  };

  const handleExportCsv = () => {
    if (!currentList.length) return;
    const headers = ['Email', 'First Name', 'Last Name', 'HubSpot Status', 'Local DB Status', 'Lifecycle Stage', 'Tier', 'Last Email Open', 'Last Booking', 'Bounced', 'Category', 'Reasons'];
    const rows = currentList.map(c => [
      c.email,
      c.firstName,
      c.lastName,
      c.membershipStatus,
      c.localDbStatus || '',
      c.lifecycleStage,
      c.tier || '',
      c.lastEmailOpen || '',
      c.lastBookingDate || '',
      c.emailBounced ? 'Yes' : 'No',
      c.category,
      c.reasons.join('; '),
    ]);
    const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hubspot-marketing-audit-${activeTab}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-white/10 dark:border-white/5 bg-white/60 dark:bg-white/5 backdrop-blur-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-white/40 dark:hover:bg-white/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">marketing</span>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Marketing Contacts Audit</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">Identify HubSpot marketing contacts you can safely remove to free up space</p>
          </div>
        </div>
        <span className="material-symbols-outlined text-gray-400 transition-transform" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}>
          expand_more
        </span>
      </button>

      <div ref={parent}>
        {isOpen && (
          <div className="p-4 pt-0 space-y-4">
            {auditQuery.isLoading && (
              <div className="flex items-center justify-center py-12 gap-3 text-gray-500 dark:text-gray-400">
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                <span>Analyzing all HubSpot contacts... This may take a minute.</span>
              </div>
            )}

            {auditQuery.isError && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-red-700 dark:text-red-400 text-sm">
                  Failed to load marketing contacts audit. Make sure HubSpot is connected.
                </p>
                <button
                  onClick={() => auditQuery.refetch()}
                  className="mt-2 text-sm text-red-600 dark:text-red-400 underline hover:no-underline"
                >
                  Try again
                </button>
              </div>
            )}

            {auditQuery.data && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-gray-50 dark:bg-white/5 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-gray-900 dark:text-white">
                      {auditQuery.data.summary.totalMarketingContacts.toLocaleString()}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">Marketing Contacts</div>
                  </div>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                      {auditQuery.data.summary.safeToRemoveCount.toLocaleString()}
                    </div>
                    <div className="text-xs text-green-600 dark:text-green-500 mt-1">Safe to Remove</div>
                  </div>
                  <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                      {auditQuery.data.summary.needsReviewCount.toLocaleString()}
                    </div>
                    <div className="text-xs text-amber-600 dark:text-amber-500 mt-1">Needs Review</div>
                  </div>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                      {auditQuery.data.summary.keepCount.toLocaleString()}
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-500 mt-1">Keep</div>
                  </div>
                </div>

                {auditQuery.data.summary.totalNonMarketing > 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {auditQuery.data.summary.totalNonMarketing.toLocaleString()} contacts are already non-marketing (not shown).
                    Total HubSpot contacts: {auditQuery.data.summary.totalContacts.toLocaleString()}.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 dark:border-white/10 pb-2">
                  {(['safe_to_remove', 'review', 'keep'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => { setActiveTab(tab); setSelectedContacts(new Set()); setSearchTerm(''); }}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === tab
                          ? tab === 'safe_to_remove'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                            : tab === 'review'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5'
                      }`}
                    >
                      {tab === 'safe_to_remove' ? 'Safe to Remove' : tab === 'review' ? 'Needs Review' : 'Keep'}
                      <span className="ml-1.5 text-xs opacity-75">
                        ({tab === 'safe_to_remove' ? auditQuery.data.summary.safeToRemoveCount : tab === 'review' ? auditQuery.data.summary.needsReviewCount : auditQuery.data.summary.keepCount})
                      </span>
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg">search</span>
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      placeholder="Search by name or email..."
                      className="w-full pl-10 pr-3 py-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </div>
                  <button
                    onClick={handleExportCsv}
                    disabled={currentList.length === 0}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 disabled:opacity-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">download</span>
                    Export CSV
                  </button>
                  {activeTab !== 'keep' && selectedContacts.size > 0 && (
                    <button
                      onClick={handleRemoveSelected}
                      disabled={removeMutation.isPending}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                    >
                      {removeMutation.isPending ? (
                        <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                      ) : (
                        <span className="material-symbols-outlined text-base">person_remove</span>
                      )}
                      Remove {selectedContacts.size} from Marketing
                    </button>
                  )}
                </div>

                <div className="rounded-lg border border-gray-200 dark:border-white/10 overflow-hidden">
                  <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-white/5 sticky top-0">
                        <tr>
                          {activeTab !== 'keep' && (
                            <th className="px-3 py-2 text-left w-10">
                              <input
                                type="checkbox"
                                checked={currentList.length > 0 && selectedContacts.size === currentList.length}
                                onChange={handleSelectAll}
                                className="rounded border-gray-300 dark:border-gray-600"
                              />
                            </th>
                          )}
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">Contact</th>
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">HubSpot Status</th>
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">Local DB</th>
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">Last Email Open</th>
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">Last Booking</th>
                          <th className="px-3 py-2 text-left text-gray-600 dark:text-gray-400 font-medium">Reasons</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-white/5">
                        {currentList.length === 0 && (
                          <tr>
                            <td colSpan={activeTab !== 'keep' ? 7 : 6} className="px-3 py-8 text-center text-gray-400 dark:text-gray-500">
                              {searchTerm ? 'No contacts match your search.' : 'No contacts in this category.'}
                            </td>
                          </tr>
                        )}
                        {currentList.map(contact => (
                          <tr
                            key={contact.hubspotId}
                            className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                          >
                            {activeTab !== 'keep' && (
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selectedContacts.has(contact.hubspotId)}
                                  onChange={() => handleToggleContact(contact.hubspotId)}
                                  className="rounded border-gray-300 dark:border-gray-600"
                                />
                              </td>
                            )}
                            <td className="px-3 py-2">
                              <div className="font-medium text-gray-900 dark:text-white">
                                {contact.firstName} {contact.lastName}
                                {contact.emailBounced && (
                                  <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                    BOUNCED
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">{contact.email}</div>
                            </td>
                            <td className="px-3 py-2">
                              <StatusBadge status={contact.membershipStatus} />
                            </td>
                            <td className="px-3 py-2">
                              {contact.inLocalDb ? (
                                <StatusBadge status={contact.localDbStatus || 'unknown'} />
                              ) : (
                                <span className="text-xs text-gray-400 dark:text-gray-500 italic">Not in DB</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                              {formatDate(contact.lastEmailOpen)}
                            </td>
                            <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                              {formatDate(contact.lastBookingDate)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {contact.reasons.map((reason, i) => (
                                  <span
                                    key={i}
                                    className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400"
                                  >
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Removing contacts from marketing does not delete them from HubSpot.
                  They become non-marketing contacts and no longer count toward your marketing contact limit.
                  You can re-add them as marketing contacts at any time from HubSpot.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MarketingContactsAuditPanel;
