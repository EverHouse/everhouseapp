import React, { useState, useEffect, useCallback } from 'react';
import TierBadge from '../TierBadge';
import { MemberSearchInput, SelectedMember } from '../shared/MemberSearchInput';
import { useToast } from '../Toast';
import { getApiErrorMessage, getNetworkErrorMessage } from '../../utils/errorHandling';

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

interface GroupBillingManagerProps {
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

const GroupBillingManager: React.FC<GroupBillingManagerProps> = ({ memberEmail }) => {
  const { showToast } = useToast();
  const [familyGroup, setFamilyGroup] = useState<FamilyGroupData | null>(null);
  const [products, setProducts] = useState<FamilyAddOnProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [groupName, setGroupName] = useState('');

  const [showAddMemberForm, setShowAddMemberForm] = useState(false);
  const [selectedNewMember, setSelectedNewMember] = useState<SelectedMember | null>(null);
  const [selectedTier, setSelectedTier] = useState<string>('');
  const [selectedRelationship, setSelectedRelationship] = useState<string>('');
  const [isAddingMember, setIsAddingMember] = useState(false);

  const [removingMemberId, setRemovingMemberId] = useState<number | null>(null);

  const [isEditingGroupName, setIsEditingGroupName] = useState(false);
  const [editedGroupName, setEditedGroupName] = useState('');
  const [isSavingGroupName, setIsSavingGroupName] = useState(false);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
        setError(getApiErrorMessage(res, 'load billing group'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
      console.error('Failed to fetch group billing products', err);
    }
  }, []);

  useEffect(() => {
    fetchFamilyGroup();
    fetchProducts();
  }, [fetchFamilyGroup, fetchProducts]);

  const showSuccess = (message: string) => {
    showToast(message, 'success');
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
        showSuccess('Billing group created successfully');
      } else {
        setError(getApiErrorMessage(res, 'create billing group'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        showSuccess('Group member added successfully');
      } else {
        setError(getApiErrorMessage(res, 'add group member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
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
        showSuccess('Group member removed');
      } else {
        setError(getApiErrorMessage(res, 'remove group member'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setRemovingMemberId(null);
    }
  };

  const handleUpdateGroupName = async () => {
    if (!familyGroup) return;
    
    setIsSavingGroupName(true);
    setError(null);
    try {
      const res = await fetch(`/api/group-billing/group/${familyGroup.id}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ groupName: editedGroupName.trim() || null }),
      });
      if (res.ok) {
        await fetchFamilyGroup();
        setIsEditingGroupName(false);
        setEditedGroupName('');
        showSuccess('Group name updated');
      } else {
        setError(getApiErrorMessage(res, 'update group name'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsSavingGroupName(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!familyGroup) return;
    
    setIsDeletingGroup(true);
    setError(null);
    try {
      const res = await fetch(`/api/group-billing/group/${familyGroup.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        setFamilyGroup(null);
        setShowDeleteConfirm(false);
        showSuccess('Billing group deleted');
      } else {
        setError(getApiErrorMessage(res, 'delete billing group'));
      }
    } catch (err) {
      setError(getNetworkErrorMessage());
    } finally {
      setIsDeletingGroup(false);
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
          Loading group billing info...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-4 bg-gray-50 dark:bg-white/5 rounded-lg">
        <div className="flex items-center gap-2 mb-4">
          <span className="material-symbols-outlined text-primary dark:text-white text-lg">groups</span>
          <p className="text-sm font-semibold text-primary dark:text-white">Group Billing</p>
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

        {!familyGroup ? (
          <div className="space-y-4">
            <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-gray-100 dark:border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-gray-400 dark:text-gray-500">group_off</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-primary dark:text-white">Not part of a billing group</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    This member is not currently in a billing group
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
                Create Billing Group with This Member as Primary
              </button>
            ) : (
              <div className="p-4 bg-white dark:bg-black/20 rounded-lg border border-primary/20 dark:border-white/20 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-lg">group_add</span>
                  <p className="text-sm font-semibold text-primary dark:text-white">Create Billing Group</p>
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
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="material-symbols-outlined text-primary dark:text-accent text-lg shrink-0">groups</span>
                  {isEditingGroupName ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editedGroupName}
                        onChange={(e) => setEditedGroupName(e.target.value)}
                        placeholder="Enter group name"
                        className="flex-1 px-2 py-1 border border-gray-200 dark:border-white/20 rounded bg-white dark:bg-black/30 text-sm text-primary dark:text-white"
                        autoFocus
                      />
                      <button
                        onClick={handleUpdateGroupName}
                        disabled={isSavingGroupName}
                        className="p-1 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10 rounded"
                      >
                        {isSavingGroupName ? (
                          <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                        ) : (
                          <span className="material-symbols-outlined text-sm">check</span>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setIsEditingGroupName(false);
                          setEditedGroupName('');
                        }}
                        className="p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 rounded"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="font-semibold text-primary dark:text-white truncate">
                        {familyGroup.groupName || 'Billing Group'}
                      </p>
                      {isPrimaryPayer && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => {
                              setEditedGroupName(familyGroup.groupName || '');
                              setIsEditingGroupName(true);
                            }}
                            className="p-1 text-gray-400 hover:text-primary dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 rounded"
                            title="Edit group name"
                          >
                            <span className="material-symbols-outlined text-sm">edit</span>
                          </button>
                          <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded"
                            title="Delete billing group"
                          >
                            <span className="material-symbols-outlined text-sm">delete</span>
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {familyGroup.stripeSubscriptionId && !isEditingGroupName && (
                  <span className="px-2 py-1 text-[10px] font-bold rounded bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 shrink-0 ml-2">
                    ACTIVE SUBSCRIPTION
                  </span>
                )}
              </div>

              {showDeleteConfirm && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                    Are you sure you want to delete this billing group? This will remove all members from the group.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleDeleteGroup}
                      disabled={isDeletingGroup}
                      className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      {isDeletingGroup ? (
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                      ) : (
                        <span className="material-symbols-outlined text-sm">delete</span>
                      )}
                      Delete Group
                    </button>
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 rounded"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

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
                    Group Members ({familyGroup.members.length})
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
                              title="Remove from billing group"
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
                  <p className="text-sm font-semibold text-primary dark:text-white">Add Group Member</p>
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
                    <span className="ml-1 text-[10px] text-green-600 dark:text-green-400">(20% group discount applied)</span>
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
                    Add to Group
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

export default GroupBillingManager;
