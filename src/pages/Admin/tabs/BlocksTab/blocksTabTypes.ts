export interface BlocksClosure {
    id: number;
    title: string;
    reason: string | null;
    memberNotice: string | null;
    notes: string | null;
    noticeType: string | null;
    startDate: string;
    startTime: string | null;
    endDate: string;
    endTime: string | null;
    affectedAreas: string | null;
    visibility: string | null;
    notifyMembers: boolean | null;
    isActive: boolean;
    needsReview: boolean | null;
    createdAt: string;
    createdBy: string | null;
}

export interface BlocksClosureForm {
    start_date: string;
    start_time: string;
    end_date: string;
    end_time: string;
    affected_areas: string;
    reason: string;
    member_notice: string;
    notes: string;
    title: string;
    notice_type: string;
    notify_members: boolean;
}

export interface NoticeType {
    id: number;
    name: string;
    isPreset: boolean;
    sortOrder: number;
}

export interface ClosureReason {
    id: number;
    label: string;
    sortOrder: number;
    isActive: boolean;
}

export function stripHtml(html: string | null | undefined): string {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<p>/gi, '')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export const emptyClosureForm: BlocksClosureForm = {
    start_date: '',
    start_time: '',
    end_date: '',
    end_time: '',
    affected_areas: 'entire_facility',
    reason: '',
    member_notice: '',
    notes: '',
    title: '',
    notice_type: '',
    notify_members: false
};
