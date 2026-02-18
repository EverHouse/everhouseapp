export interface BookingRequest {
    id: number | string;
    user_email: string | null;
    user_name: string | null;
    resource_id: number | null;
    bay_name: string | null;
    resource_preference: string | null;
    request_date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number | null;
    notes: string | null;
    status: 'pending' | 'pending_approval' | 'approved' | 'declined' | 'cancelled' | 'cancellation_pending' | 'confirmed' | 'attended' | 'no_show';
    staff_notes: string | null;
    suggested_time: string | null;
    created_at: string | null;
    source?: 'booking_request' | 'booking' | 'calendar';
    resource_name?: string;
    first_name?: string;
    last_name?: string;
    reschedule_booking_id?: number | null;
    tier?: string | null;
    trackman_booking_id?: string | null;
    has_unpaid_fees?: boolean;
    total_owed?: number;
    guardian_name?: string | null;
    guardian_relationship?: string | null;
    guardian_phone?: string | null;
    guardian_consent_at?: string | null;
    is_unmatched?: boolean;
    declared_player_count?: number;
    filled_player_count?: number;
    cancellation_reason?: string | null;
    player_count?: number | null;
    userName?: string | null;
    note?: string | null;
    fee_snapshot_paid?: boolean;
}

export interface Bay {
    id: number;
    name: string;
    description: string;
}

export interface Resource {
    id: number;
    name: string;
    type: string;
    description: string | null;
}

export interface CalendarClosure {
    id: number;
    title: string;
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
    affectedAreas: string;
    reason: string | null;
}

export interface AvailabilityBlock {
    id: number;
    resourceId: number;
    blockDate: string;
    startTime: string;
    endTime: string;
    blockType: string;
    notes: string | null;
    closureTitle?: string | null;
}

export interface MemberSearchResult {
    email: string;
    firstName: string | null;
    lastName: string | null;
    tier: string | null;
    status: string | null;
}

export interface ManualBookingResult {
    id: number;
    user_email: string;
    user_name: string | null;
    resource_id: number;
    bay_name: string | null;
    request_date: string;
    start_time: string;
    end_time: string;
    duration_minutes: number;
    status: 'approved' | 'confirmed';
    notes: string | null;
    staff_notes: string | null;
}
