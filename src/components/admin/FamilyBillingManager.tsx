import React, { useState, useEffect, useCallback } from 'react';
import TierBadge from '../TierBadge';
import { MemberSearchInput, SelectedMember } from '../shared/MemberSearchInput';

interface FamilyMemberInfo {
  id: number;
  memberEmail: string;
  memberName: string;
  memberTier: string;
  relationship: string | null;
  addOnPriceCents: number;
  isActive: boolean;
  addedAt: Date | null;
}

interface FamilyGroupData {
  id: number;
  primaryEmail: string;
  primaryName: string;
  groupName: string | null;
  stripeSubscriptionId: string | null;
  members: FamilyMemberInfo[];
  totalMonthlyAmount: number;
  isActive: boolean;
}

interface FamilyAddOnProduct {
  id: number;
  tierName: string;
  priceCents: number;
  displayName: string | null;
}

interface FamilyBillingManagerProps {
  memberEmail: string;
}

const RELATIONSHIP_OPTIONS = [
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'parent', label: 'Parent' },
  { value: 'sibling', label: 'Sibling' },
  { value: 'partner', label: 'Partner' },
  { value: 'other', label: 'Other' },
];

const FamilyBillingManager: React.FC<FamilyBillingManagerProps> = ({ memberEmail }) => {
  const [familyGroup, setFamilyGroup] = useState<FamilyGroupData | null>(null);
  const [products, setProducts] = useState<FamilyAddOnProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [groupName, setGroupName] = useState('');

  const [showAddMemberForm, setShowAddMemberForm] = useState(false);
  const [selectedNewMember, setSelectedNewMember] = useState<SelectedMember | null>(null);
  const [selectedTier, setSelectedTier] = useState<string>('');
  const [selectedRelationship, setSelectedRelationship] = useState<string>('');
  const [isAddingMember, setIsAddingMember] = useState(false);

  const [removingMemberId, setRemovingMemberId] = useState<number | null>(null);

  const isPrimaryPayer = familyGroup?.primaryEmail.toLowerCase() === memberEmail.toLowerCase();
  const isAddOnMember = familyGroup && !isPrimaryPayer;

  const fetchFamilyGroup = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/group-billing/group/${encodeURIComponent(memberEmail)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setFamilyGroup(data);
      } else if (res.status === 404) {
        setFamilyGroup(null);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to load family group');
      }
    } catch (err) {
      setError('Failed to load family group');
    } finally {
      setIsLoading(false);
    }
  }, [memberEmail]);

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/group-billing/products', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setProducts(data);
      }
    } catch (err) {
      console.error('Failed to fetch family billing products', err);
    }
  }, []);

  useEffect(() => {
    fetchFamilyGroup();
    fetchProducts();
  }, [fetchFamilyGroup, fetchProducts]);

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleCreateGroup = async () => {
    setIsCreatingGroup(true);
    setError(null);
    try {
      const res = await fetch('/api/group-billing/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          primaryEmail: memberEmail,
          groupName: groupName.trim() || undefined,
        }),
      });
      if (res.ok) {
        await fetchFamilyGroup();
        setShowCreateForm(false);
        setGroupName('');
        showSuccess('Family group created successfully');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create family group');
      }
    } catch (err) {
      setError('Failed to create family group');
    } finally {
      setIsCreatingGroup(false);
    }
  };

  const handleAddMember = async () => {
    if (!selectedNewMember || !selectedTier || !familyGroup) return;

    setIsAddingMember(true);
    setError(null);
    try {
      const res = await fetch(`/api/group-billing/groups/${familyGroup.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          memberEmail: selectedNewMember.email,
          memberTier: selectedTier,
          relationship: selectedRelationship || undefined,
        }),
      });
      if (res.ok) {
        await fetchFamilyGroup();
        setShowAddMemberForm(false);
        setSelectedNewMember(null);
        setSelectedTier('');
        setSelectedRelationship('');
        showSuccess('Family member added successfully');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to add family member');
      }
    } catch (err) {
      setError('Failed to add family member');
    } finally {
      setIsAddingMember(false);
    }
  };

  const handleRemoveMember = async (memberId: number) => {
    setRemovingMemberId(memberId);
    setError(null);
    try {
      const res = await fetch(`/api/group-billing/members/${memberId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchFamilyGroup();
        showSuccess('Family member removed');
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to remove family member');
      }
    } catch (err) {
      setError('Failed to remove family member');
    } finally {
      setRemovingMemberId(null);
    }
  };

  const formatCurrency = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  const getProductPriceForTier = (tierName: string): number => {
    const product = products.find(p => p.tierName.toLowerCase() === tierName.toLowerCase());
    return product?.priceCents || 0;
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
          <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
          Loading family billing info...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-4 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-primary dark:text-white text-lg">family_restroom</span>
          <p className="text-sm font-semibold text-primary dark:text-white">Family Billing</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-red-500 text-base">error</span>
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <button
              onClick={() => setError(null)}
              className="ml-auto p-1 hover:bg-red-100 dark:hover:bg-red-500/20 rounded"
            >
              <span className="material-symbols-outlined text-red-500 text-base">close</span>
            </button>
          </div>
        )}

        {successMessage && (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/30 rounded-lg flex items-center gap-2">
            <span className="material-symbols-outlined text-green-500 text-base">check_circle</span>
            <p className="text-sm text-green-600 dark:text-green-400">{successMessage}</p>
          </div>
        )}

        {!familyGroup ? (
          <div className="space-y-4">
            <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-gray-100 dark:border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-gray-400 dark:text-gray-500">group_off</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-primary dark:text-white">Not part of a family group</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    This member is not currently in a family billing group
                  </p>
                </div>
              </div>
            </div>

            {!showCreateForm ? (
              <button
                onClick={() => setShowCreateForm(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary dark:bg-accent text-white dark:text-primary font-medium rounded-lg hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined text-lg">add</span>
                Create Family Group with This Member as Primary
              </button>
            ) : (
              <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-primary/20 dark:border-white/20 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-lg">group_add</span>
                  <p className="text-sm font-semibold text-primary dark:text-white">Create Family Group</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    Primary Payer
                  </label>
                  <div className="px-3 py-2 bg-gray-50 dark:bg-white/5 rounded-lg text-sm text-primary dark:text-white">
                    {memberEmail}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    Group Name (optional)
                  </label>
                  <input
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="e.g., Smith Family"
                    className="w-full px-3 py-2 border border-gray-200 dark:border-white/20 rounded-lg bg-white dark:bg-black/30 text-sm text-primary dark:text-white placeholder:text-gray-400"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCreateGroup}
                    disabled={isCreatingGroup}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {isCreatingGroup ? (
                      <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    ) : (
                      <span className="material-symbols-outlined text-base">check</span>
                    )}
                    Create Group
                  </button>
                  <button
                    onClick={() => {
                      setShowCreateForm(false);
                      setGroupName('');
                    }}
                    className="px-4 py-2.5 border border-gray-200 dark:border-white/20 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-gray-100 dark:border-white/10">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-lg">groups</span>
                  <p className="font-semibold text-primary dark:text-white">
                    {familyGroup.groupName || 'Family Group'}
                  </p>
                </div>
                {familyGroup.stripeSubscriptionId && (
                  <span className="px-2 py-1 text-[10px] font-bold rounded bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400">
                    ACTIVE SUBSCRIPTION
                  </span>
                )}
              </div>

              <div className="mb-4 p-3 bg-primary/5 dark:bg-white/5 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-sm">credit_card</span>
                  <p className="text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wide">
                    Primary Payer
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-primary dark:text-white">{familyGroup.primaryName}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{familyGroup.primaryEmail}</p>
                </div>
              </div>

              {isAddOnMember && (
                <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-500 text-base">info</span>
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    This member is an add-on under the primary payer's subscription
                  </p>
                </div>
              )}

              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-primary/60 dark:text-white/60 uppercase tracking-wide">
                    Family Members ({familyGroup.members.length})
                  </p>
                  {isPrimaryPayer && (
                    <button
                      onClick={() => setShowAddMemberForm(true)}
                      className="flex items-center gap-1 text-xs font-medium text-primary dark:text-accent hover:opacity-80 transition-opacity"
                    >
                      <span className="material-symbols-outlined text-sm">person_add</span>
                      Add Member
                    </button>
                  )}
                </div>

                {familyGroup.members.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 py-2">
                    No add-on members yet
                  </p>
                ) : (
                  <div className="space-y-2">
                    {familyGroup.members.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 rounded-lg"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-8 h-8 rounded-full bg-primary/10 dark:bg-white/10 flex items-center justify-center flex-shrink-0">
                            <span className="material-symbols-outlined text-primary dark:text-white text-sm">person</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm text-primary dark:text-white truncate">
                                {member.memberName}
                              </p>
                              <TierBadge tier={member.memberTier} size="sm" />
                              {member.relationship && (
                                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-400 capitalize">
                                  {member.relationship}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              {member.memberEmail}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-sm font-semibold text-primary dark:text-accent">
                            {formatCurrency(member.addOnPriceCents)}/mo
                          </span>
                          {isPrimaryPayer && (
                            <button
                              onClick={() => handleRemoveMember(member.id)}
                              disabled={removingMemberId === member.id}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50"
                              title="Remove from family group"
                            >
                              {removingMemberId === member.id ? (
                                <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                              ) : (
                                <span className="material-symbols-outlined text-base">person_remove</span>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-gray-100 dark:border-white/10">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    Total Monthly Add-on Amount
                  </p>
                  <p className="text-lg font-bold text-primary dark:text-accent">
                    {formatCurrency(familyGroup.totalMonthlyAmount)}
                  </p>
                </div>
              </div>
            </div>

            {showAddMemberForm && isPrimaryPayer && (
              <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-primary/20 dark:border-white/20 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-lg">person_add</span>
                  <p className="text-sm font-semibold text-primary dark:text-white">Add Family Member</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    Select Member
                  </label>
                  <MemberSearchInput
                    onSelect={setSelectedNewMember}
                    onClear={() => setSelectedNewMember(null)}
                    selectedMember={selectedNewMember}
                    placeholder="Search for a member..."
                    excludeEmails={familyGroup ? [
                      familyGroup.primaryEmail,
                      ...familyGroup.members.map(m => m.memberEmail)
                    ] : []}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    Membership Tier
                    <span className="ml-1 text-[10px] text-green-600 dark:text-green-400">(20% family discount applied)</span>
                  </label>
                  <select
                    value={selectedTier}
                    onChange={(e) => setSelectedTier(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-white/20 rounded-lg bg-white dark:bg-black/30 text-sm text-primary dark:text-white"
                  >
                    <option value="">Select tier...</option>
                    {products.map((product) => (
                      <option key={product.tierName} value={product.tierName}>
                        {product.tierName} ({formatCurrency(product.priceCents)}/mo)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    Relationship (optional)
                  </label>
                  <select
                    value={selectedRelationship}
                    onChange={(e) => setSelectedRelationship(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-white/20 rounded-lg bg-white dark:bg-black/30 text-sm text-primary dark:text-white"
                  >
                    <option value="">Select relationship...</option>
                    {RELATIONSHIP_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAddMember}
                    disabled={isAddingMember || !selectedNewMember || !selectedTier}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary dark:bg-accent text-white dark:text-primary font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {isAddingMember ? (
                      <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                    ) : (
                      <span className="material-symbols-outlined text-base">person_add</span>
                    )}
                    Add to Family
                  </button>
                  <button
                    onClick={() => {
                      setShowAddMemberForm(false);
                      setSelectedNewMember(null);
                      setSelectedTier('');
                      setSelectedRelationship('');
                    }}
                    className="px-4 py-2.5 border border-gray-200 dark:border-white/20 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FamilyBillingManager;
