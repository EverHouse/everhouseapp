import { MemberFormData, MembershipTier } from './newUserTypes';
import { postWithCredentials } from '../../../../hooks/queries/useFetch';
import { apiRequest } from '../../../../lib/apiRequest';

interface GroupCreationResult {
  groupId: string | number;
  addedCount: number;
  failedCount: number;
}

export async function createGroupAndAddMembers({
  form,
  tiers,
  selectedTierSlug,
  subMemberScannedIds,
  useApiRequest = false,
}: {
  form: MemberFormData;
  tiers: MembershipTier[];
  selectedTierSlug: string | undefined;
  subMemberScannedIds: Record<number, { base64: string; mimeType: string }>;
  useApiRequest?: boolean;
}): Promise<GroupCreationResult> {
  let groupId: string | number;

  if (useApiRequest) {
    const groupCreateResult = await apiRequest<Record<string, unknown>>('/api/family-billing/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        primaryEmail: form.email,
        groupName: `${form.firstName} ${form.lastName} Family`,
      }),
    }, { maxRetries: 1 });

    if (!groupCreateResult.ok) {
      throw new Error(groupCreateResult.error || 'Failed to create family billing group');
    }
    const groupCreateData = groupCreateResult.data as Record<string, unknown>;
    groupId = groupCreateData.groupId as string;
  } else {
    const groupCreateData = await postWithCredentials<{ groupId: string }>('/api/family-billing/groups', {
      primaryEmail: form.email,
      groupName: `${form.firstName} ${form.lastName} Family`,
    });
    groupId = groupCreateData.groupId;
  }

  let addedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < form.groupMembers.length; i++) {
    const member = form.groupMembers[i];
    try {
      const memberTierSlug = tiers.find(t => t.id === member.tierId)?.slug || selectedTierSlug;
      const memberPayload: Record<string, unknown> = {
        memberEmail: member.email,
        memberTier: memberTierSlug,
        relationship: 'family',
        firstName: member.firstName,
        lastName: member.lastName,
        phone: member.phone,
        dob: member.dob,
        streetAddress: member.streetAddress || undefined,
        city: member.city || undefined,
        state: member.state || undefined,
        zipCode: member.zipCode || undefined,
        discountCode: member.discountCode !== undefined ? member.discountCode : undefined,
      };

      let memberId: string | undefined;

      if (useApiRequest) {
        const addMemberResult = await apiRequest<Record<string, unknown>>(`/api/family-billing/groups/${groupId}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(memberPayload),
        }, { maxRetries: 1 });

        if (addMemberResult.ok) {
          addedCount++;
          const addData = addMemberResult.data as Record<string, unknown>;
          memberId = addData.memberId as string | undefined;
        } else {
          failedCount++;
          console.error(`Failed to add group member ${member.email}:`, addMemberResult.error);
        }
      } else {
        const addData = await postWithCredentials<{ memberId?: string }>(`/api/family-billing/groups/${groupId}/members`, memberPayload);
        addedCount++;
        memberId = addData.memberId;
      }

      if (subMemberScannedIds[i] && memberId) {
        postWithCredentials('/api/admin/save-id-image', {
          userId: memberId,
          image: subMemberScannedIds[i].base64,
          mimeType: subMemberScannedIds[i].mimeType,
        }).catch(err => console.error('Failed to save sub-member ID image:', err));
      }
    } catch (memberErr: unknown) {
      failedCount++;
      console.error(`Error adding group member ${member.email}:`, memberErr);
    }
  }

  return { groupId, addedCount, failedCount };
}

export function getGroupResultToast(addedCount: number, failedCount: number): { message: string; type: 'success' | 'warning' } {
  if (failedCount === 0) {
    return {
      message: `Family group created with ${addedCount} member${addedCount !== 1 ? 's' : ''}.`,
      type: 'success',
    };
  } else if (addedCount > 0) {
    return {
      message: `Family group created. ${addedCount} added, ${failedCount} failed. Check group billing to fix.`,
      type: 'warning',
    };
  } else {
    return {
      message: 'Family group created but failed to add members. You can add them manually.',
      type: 'warning',
    };
  }
}
