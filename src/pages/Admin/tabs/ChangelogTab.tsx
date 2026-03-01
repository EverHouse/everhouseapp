import React, { useState, useEffect, useCallback } from 'react';
import { changelog } from '../../../data/changelog';
import EmptyState from '../../../components/EmptyState';
import { formatRelativeTime } from '../../../utils/dateUtils';
import WalkingGolferSpinner from '../../../components/WalkingGolferSpinner';
import { AnimatedPage } from '../../../components/motion';
import { useData } from '../../../contexts/DataContext';

interface AuditLogDetails {
    member_email?: string;
    email?: string;
    visitor_email?: string;
    guest_email?: string;
    attendee_email?: string;
    rsvp_email?: string;
    owner_email?: string;
    trackman_email?: string;
    oldEmail?: string;
    newEmail?: string;
    new_email?: string;
    memberEmail?: string;
    linkedBy?: string;
    previous_owner?: string;
    amount?: number | string;
    amount_cents?: number;
    fee_amount?: number;
    refund_amount_cents?: number;
    description?: string;
    reason?: string;
    refund_reason?: string;
    failure_reason?: string;
    appDuplicateCount?: number;
    hubspotDuplicateCount?: number;
    ghostBookingsFound?: number;
    bookingsProcessed?: number;
    recordsUpdated?: number;
    recordsCreated?: number;
    recordsSkipped?: number;
    recordsAffected?: number;
    bookingsImported?: number;
    bookingsReset?: number;
    contactsUpdated?: number;
    contactsCreated?: number;
    eventsUpdated?: number;
    eventsCreated?: number;
    total?: number;
    total_players?: number;
    count?: number;
    passes_remaining?: number;
    refunded_passes?: number;
    participantCount?: number;
    booking_date?: string;
    start_time?: string;
    booking_time?: string;
    bay_name?: string;
    bay?: string | number;
    action?: string;
    tier?: string;
    old_tier?: string;
    new_tier?: string;
    section?: string;
    tour_date?: string;
    previous_status?: string;
    new_status?: string;
    newStatus?: string;
    event_date?: string;
    date?: string;
    location?: string;
    instructor?: string;
    memberEnrolled?: string;
    priority?: string;
    startDate?: string;
    endDate?: string;
    affectedAreas?: string;
    guest_name?: string;
    guestName?: string;
    memberName?: string;
    member_name?: string;
    participantName?: string;
    participantType?: string;
    groupType?: string;
    filename?: string;
    class_title?: string;
    class_date?: string;
    event_title?: string;
    is_partial?: boolean;
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    invoice_id?: string;
    trackman_booking_id?: string;
    visitor_name?: string;
    name?: string;
    owner_name?: string;
    new_name?: string;
    payment_status?: string;
    from?: string;
    to?: string;
    source?: string;
    waiver_version?: string;
}

interface AuditLogEntry {
    id: number;
    staffEmail: string;
    staffName: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    resourceName: string | null;
    details: AuditLogDetails | null;
    ipAddress: string | null;
    createdAt: string;
    actorType: 'staff' | 'member' | 'system';
    actorEmail: string | null;
}

const ACTION_LABELS: Record<string, { label: string; icon: string; color: string }> = {
    // Booking actions
    approve_booking: { label: 'Approved Booking', icon: 'check_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    decline_booking: { label: 'Declined Booking', icon: 'cancel', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    cancel_booking: { label: 'Cancelled Booking', icon: 'event_busy', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    create_booking: { label: 'Created Booking', icon: 'event_available', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    reschedule_booking: { label: 'Rescheduled Booking', icon: 'update', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    mark_no_show: { label: 'Marked No-Show', icon: 'person_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    mark_attended: { label: 'Marked Attended', icon: 'how_to_reg', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    add_guest_to_booking: { label: 'Added Guest to Booking', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_guest_from_booking: { label: 'Removed Guest', icon: 'person_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_member_to_booking: { label: 'Linked Member to Booking', icon: 'link', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    unlink_member_from_booking: { label: 'Unlinked Member', icon: 'link_off', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    direct_add_participant: { label: 'Added Participant', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    change_booking_owner: { label: 'Change Booking Owner', icon: 'swap_horiz', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    assign_member_to_booking: { label: 'Assigned Member to Booking', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    link_trackman_to_member: { label: 'Linked Trackman to Member', icon: 'link', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    // Billing actions
    pause_subscription: { label: 'Paused Subscription', icon: 'pause_circle', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    resume_subscription: { label: 'Resumed Subscription', icon: 'play_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    cancel_subscription: { label: 'Cancelled Subscription', icon: 'cancel', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    record_charge: { label: 'Recorded Charge', icon: 'payments', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    process_refund: { label: 'Processed Refund', icon: 'currency_exchange', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    send_payment_link: { label: 'Sent Payment Link', icon: 'link', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    change_tier: { label: 'Changed Tier', icon: 'swap_vert', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    update_payment_status: { label: 'Updated Payment', icon: 'payment', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    // Member actions
    invite_member: { label: 'Invited Member', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    create_member: { label: 'Created Member', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    sync_hubspot: { label: 'Synced HubSpot', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_stripe_customer: { label: 'Linked Stripe Customer', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    update_member_notes: { label: 'Updated Member Notes', icon: 'edit_note', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    view_member: { label: 'Viewed Member', icon: 'visibility', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    view_member_profile: { label: 'Viewed Profile', icon: 'person', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    view_member_billing: { label: 'Viewed Billing', icon: 'receipt', color: 'text-gray-500 bg-gray-100 dark:text-gray-400 dark:bg-gray-800/30' },
    export_member_data: { label: 'Exported Member Data', icon: 'download', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    update_member: { label: 'Updated Member', icon: 'edit', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    delete_member: { label: 'Deleted Member', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    archive_member: { label: 'Archived Member', icon: 'archive', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    // Tour actions
    tour_checkin: { label: 'Tour Check-In', icon: 'how_to_reg', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    tour_completed: { label: 'Tour Completed', icon: 'task_alt', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    tour_no_show: { label: 'Tour No-Show', icon: 'person_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    tour_cancelled: { label: 'Tour Cancelled', icon: 'event_busy', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    tour_status_changed: { label: 'Tour Status Changed', icon: 'swap_horiz', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    // Event actions
    create_event: { label: 'Created Event', icon: 'event', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    update_event: { label: 'Updated Event', icon: 'edit_calendar', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    delete_event: { label: 'Deleted Event', icon: 'event_busy', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    sync_events: { label: 'Synced Events', icon: 'sync', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    manual_rsvp: { label: 'Added RSVP', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_rsvp: { label: 'Removed RSVP', icon: 'person_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    // Wellness actions
    create_wellness_class: { label: 'Created Wellness Class', icon: 'fitness_center', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    update_wellness_class: { label: 'Updated Wellness Class', icon: 'edit', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    delete_wellness_class: { label: 'Deleted Wellness Class', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    sync_wellness: { label: 'Synced Wellness', icon: 'sync', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    manual_enrollment: { label: 'Enrolled Member', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    // Announcement actions
    create_announcement: { label: 'Created Announcement', icon: 'campaign', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    update_announcement: { label: 'Updated Announcement', icon: 'edit', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    delete_announcement: { label: 'Deleted Announcement', icon: 'delete', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    // Closure actions
    create_closure: { label: 'Created Closure', icon: 'block', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    update_closure: { label: 'Updated Closure', icon: 'edit', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    delete_closure: { label: 'Deleted Closure', icon: 'delete', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    sync_closures: { label: 'Synced Closures', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    // Trackman/Import actions
    import_trackman: { label: 'Imported Trackman Data', icon: 'upload_file', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    reassign_booking: { label: 'Reassigned Booking', icon: 'swap_horiz', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    unmatch_booking: { label: 'Unmatched Booking', icon: 'link_off', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    reset_trackman_data: { label: 'Reset Trackman Data', icon: 'restart_alt', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    // Data tools/admin actions
    duplicate_detection: { label: 'Detect Duplicates', icon: 'content_copy', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    detect_duplicates: { label: 'Detect Duplicates', icon: 'content_copy', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    fix_ghost_bookings: { label: 'Fix Ghost Bookings', icon: 'auto_fix_high', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    fix_trackman_ghost_bookings: { label: 'Fix TrackMan Ghost Bookings', icon: 'auto_fix_high', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    mark_booking_as_event: { label: 'Mark Booking As Event', icon: 'event', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    assign_booking_with_players: { label: 'Assigned Booking', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    // Group billing actions
    add_group_member: { label: 'Added Group Member', icon: 'group_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    remove_group_member: { label: 'Removed Group Member', icon: 'group_remove', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    link_group_subscription: { label: 'Linked Group Subscription', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    // Waiver actions
    review_waiver: { label: 'Reviewed Waiver', icon: 'verified', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    // Webhook/system booking actions
    booking_cancelled_webhook: { label: 'Booking Cancelled (TrackMan)', icon: 'webhook', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    booking_cancelled_member: { label: 'Booking Cancelled (Member)', icon: 'person_off', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    // Wellness/Event cancellations by members
    cancel_wellness_enrollment: { label: 'Wellness Cancelled (Member)', icon: 'fitness_center', color: 'text-pink-600 bg-pink-100 dark:text-pink-400 dark:bg-pink-900/30' },
    cancel_event_rsvp: { label: 'Event RSVP Cancelled (Member)', icon: 'event_busy', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    // Payment actions
    payment_refunded: { label: 'Payment Refunded', icon: 'currency_exchange', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    payment_refund_partial: { label: 'Partial Refund', icon: 'currency_exchange', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    payment_failed: { label: 'Payment Failed', icon: 'credit_card_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    payment_succeeded: { label: 'Payment Successful', icon: 'check_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    // Stripe webhook subscription events
    subscription_created: { label: 'Subscription Created', icon: 'add_card', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    subscription_updated: { label: 'Subscription Updated', icon: 'credit_card', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    subscription_cancelled: { label: 'Subscription Cancelled', icon: 'credit_card_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    // Invoice actions
    invoice_paid: { label: 'Invoice Paid', icon: 'receipt_long', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    invoice_failed: { label: 'Invoice Failed', icon: 'receipt', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    invoice_overdue: { label: 'Invoice Overdue', icon: 'warning', color: 'text-amber-600 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30' },
    invoice_removed: { label: 'Invoice Removed', icon: 'delete', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    // Day pass actions
    day_pass_purchased: { label: 'Day Pass Purchased', icon: 'confirmation_number', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    day_pass_redeemed: { label: 'Day Pass Redeemed', icon: 'qr_code_scanner', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    day_pass_refunded: { label: 'Day Pass Refunded', icon: 'currency_exchange', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    guest_pass_used: { label: 'Guest Pass Used', icon: 'badge', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    // Waiver actions
    waiver_marked_reviewed: { label: 'Waiver Reviewed', icon: 'verified', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    all_waivers_marked_reviewed: { label: 'All Waivers Reviewed', icon: 'verified', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    // TrackMan sync actions
    trackman_rescan: { label: 'TrackMan Rescan', icon: 'refresh', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    trackman_backfill: { label: 'TrackMan Backfill', icon: 'history', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    backfill_sessions: { label: 'Backfill Sessions', icon: 'history', color: 'text-cyan-600 bg-cyan-100 dark:text-cyan-400 dark:bg-cyan-900/30' },
    // Booking status actions from webhooks
    booking_approved: { label: 'Booking Approved', icon: 'check_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    booking_approved_linked: { label: 'Booking Approved & Linked', icon: 'check_circle', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    booking_declined: { label: 'Booking Declined', icon: 'cancel', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    booking_attended: { label: 'Booking Attended', icon: 'how_to_reg', color: 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30' },
    booking_no_show: { label: 'Booking No-Show', icon: 'person_off', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    booking_payment_updated: { label: 'Booking Payment Updated', icon: 'payment', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    // Privacy/CCPA actions
    anonymize: { label: 'Member Anonymized', icon: 'visibility_off', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    // Visitor actions
    visitor_created: { label: 'Visitor Created', icon: 'person_add', color: 'text-teal-600 bg-teal-100 dark:text-teal-400 dark:bg-teal-900/30' },
    visitor_stripe_linked: { label: 'Visitor Linked to Stripe', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    delete_visitor: { label: 'Visitor Deleted', icon: 'person_remove', color: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30' },
    data_migration: { label: 'Data Migration', icon: 'sync_alt', color: 'text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-900/30' },
    // Bulk actions
    bulk_status_sync: { label: 'Bulk Status Sync', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    bulk_link_stripe_hubspot: { label: 'Bulk Link Stripe/HubSpot', icon: 'link', color: 'text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-900/30' },
    bulk_visit_count_sync: { label: 'Bulk Visit Count Sync', icon: 'sync', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
    bulk_payment_status_sync: { label: 'Bulk Payment Sync', icon: 'sync', color: 'text-emerald-600 bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/30' },
    cleanup_mindbody_ids: { label: 'Cleanup MindBody IDs', icon: 'cleaning_services', color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' },
    sync_members_to_hubspot: { label: 'Sync Members to HubSpot', icon: 'sync', color: 'text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30' },
    manual_sync: { label: 'Manual Sync', icon: 'sync', color: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/30' },
};

const FILTER_CATEGORIES = [
    { key: 'all', label: 'All' },
    { key: 'bookings', label: 'Bookings', actions: ['approve_booking', 'decline_booking', 'cancel_booking', 'create_booking', 'reschedule_booking', 'mark_no_show', 'mark_attended', 'add_guest_to_booking', 'remove_guest_from_booking', 'link_member_to_booking', 'unlink_member_from_booking', 'direct_add_participant', 'reassign_booking', 'unmatch_booking', 'import_trackman', 'change_booking_owner', 'assign_member_to_booking', 'link_trackman_to_member', 'booking_cancelled_webhook', 'booking_cancelled_member', 'mark_booking_as_event', 'assign_booking_with_players'] },
    { key: 'billing', label: 'Billing', actions: ['pause_subscription', 'resume_subscription', 'cancel_subscription', 'record_charge', 'process_refund', 'send_payment_link', 'change_tier', 'update_payment_status', 'add_group_member', 'remove_group_member', 'link_group_subscription', 'payment_refunded', 'payment_refund_partial', 'payment_failed', 'payment_succeeded'] },
    { key: 'members', label: 'Members', actions: ['invite_member', 'create_member', 'update_member', 'delete_member', 'archive_member', 'sync_hubspot', 'link_stripe_customer', 'update_member_notes', 'review_waiver'] },
    { key: 'tours', label: 'Tours', actions: ['tour_checkin', 'tour_completed', 'tour_no_show', 'tour_cancelled', 'tour_status_changed'] },
    { key: 'events', label: 'Events', actions: ['create_event', 'update_event', 'delete_event', 'sync_events', 'manual_rsvp', 'remove_rsvp', 'create_wellness_class', 'update_wellness_class', 'delete_wellness_class', 'sync_wellness', 'manual_enrollment', 'cancel_wellness_enrollment', 'cancel_event_rsvp'] },
    { key: 'admin', label: 'Admin', actions: ['create_announcement', 'update_announcement', 'delete_announcement', 'create_closure', 'update_closure', 'delete_closure', 'sync_closures', 'reset_trackman_data', 'duplicate_detection', 'detect_duplicates', 'fix_ghost_bookings', 'fix_trackman_ghost_bookings'] },
];

const ChangelogTab: React.FC = () => {
    const { actualUser } = useData();
    const isAdmin = actualUser?.role === 'admin';
    const [activeTab, setActiveTab] = useState<'updates' | 'activity'>('updates');
    
    const [entries, setEntries] = useState<AuditLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filterCategory, setFilterCategory] = useState('all');
    const [staffFilter, setStaffFilter] = useState('');
    const [sourceFilter, setSourceFilter] = useState<'' | 'staff' | 'member' | 'system'>('');
    const [uniqueStaff, setUniqueStaff] = useState<string[]>([]);
    const [limit, setLimit] = useState(50);
    const [hasMore, setHasMore] = useState(true);
    
    // Changelog pagination - show 25 entries initially, load 25 more per click
    const [changelogLimit, setChangelogLimit] = useState(25);
    const visibleChangelog = changelog.slice(0, changelogLimit);
    const hasMoreChangelog = changelogLimit < changelog.length;

    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    const fetchActivityLog = useCallback(async (reset = false) => {
        if (!isAdmin) return;
        
        try {
            if (reset) {
                setLoading(true);
                setLimit(50);
            }
            
            const params = new URLSearchParams();
            params.set('limit', String(reset ? 50 : limit));
            
            if (staffFilter) {
                params.set('staff_email', staffFilter);
            }
            
            if (sourceFilter) {
                params.set('actor_type', sourceFilter);
            }
            
            const category = FILTER_CATEGORIES.find(c => c.key === filterCategory);
            if (category && category.actions) {
                params.set('actions', category.actions.join(','));
            }
            
            const res = await fetch(`/api/data-tools/staff-activity?${params.toString()}`, { credentials: 'include' });
            if (!res.ok) throw new Error('Failed to fetch activity log');
            
            const data = await res.json();
            // Filter out view-only actions (noise) - only show actual changes
            const viewOnlyActions = ['view_member', 'view_member_profile', 'view_member_billing', 'view_booking', 'view_payment', 'view_directory', 'view_report'];
            const filteredLogs = (data.logs || []).filter((log: AuditLogEntry) => !viewOnlyActions.includes(log.action));
            setEntries(filteredLogs);
            setHasMore(filteredLogs.length >= (reset ? 50 : limit));
            
            const staffList = [...new Set(data.logs?.map((e: AuditLogEntry) => e.staffEmail) || [])].filter(Boolean) as string[];
            if (staffList.length > uniqueStaff.length) {
                setUniqueStaff(staffList);
            }
            
            setError(null);
        } catch (err: unknown) {
            setError((err instanceof Error ? err.message : String(err)) || 'Failed to load activity log');
        } finally {
            setLoading(false);
        }
    }, [limit, staffFilter, sourceFilter, filterCategory, uniqueStaff.length, isAdmin]);

    useEffect(() => {
        if (activeTab === 'activity' && isAdmin) {
            fetchActivityLog(true);
        }
    }, [activeTab, filterCategory, staffFilter, sourceFilter, isAdmin]);

    useEffect(() => {
        if (limit > 50 && activeTab === 'activity') {
            fetchActivityLog();
        }
    }, [limit, fetchActivityLog, activeTab]);

    const loadMore = () => {
        setLimit(prev => prev + 50);
    };

    const formatDate = (dateStr: string) => {
        const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
        const [year, month, day] = datePart.split('-').map(Number);
        const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return `${day} ${longMonths[month - 1]} ${year}`;
    };

    const getActionInfo = (action: string) => {
        return ACTION_LABELS[action] || { 
            label: action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), 
            icon: 'info', 
            color: 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30' 
        };
    };

    const formatDetails = (entry: AuditLogEntry): string => {
        const parts: string[] = [];
        
        // Parse details - handle both object and string (from database)
        let d: AuditLogDetails = {};
        try {
            const rawDetails = entry.details as unknown;
            if (rawDetails) {
                if (typeof rawDetails === 'string') {
                    d = JSON.parse(rawDetails);
                } else if (typeof rawDetails === 'object' && rawDetails !== null) {
                    d = rawDetails as AuditLogDetails;
                }
            }
        } catch {
            // If parsing fails, try to extract readable content
            const str = String(entry.details || '');
            const emailMatch = str.match(/[\w.+-]+@[\w.-]+\.\w+/);
            if (emailMatch) return emailMatch[0];
            return str.substring(0, 100) || 'Details available';
        }
        
        // Resource name first
        if (entry.resourceName) {
            parts.push(entry.resourceName);
        }
        
        // Universal field extractors - these work for any action type
        // Extract email fields
        if (d.member_email) parts.push(d.member_email);
        else if (d.email) parts.push(d.email);
        else if (d.visitor_email) parts.push(d.visitor_email);
        else if (d.guest_email) parts.push(d.guest_email);
        else if (d.attendee_email) parts.push(d.attendee_email);
        
        // Extract amount fields (convert cents to dollars)
        if (d.amount !== undefined && typeof d.amount === 'number') {
            parts.push(`$${(d.amount / 100).toFixed(2)}`);
        } else if (d.amount_cents !== undefined) {
            parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
        }
        
        // Extract description/reason fields
        if (d.description) parts.push(d.description);
        else if (d.reason) parts.push(d.reason);
        
        // Extract count fields
        if (d.appDuplicateCount !== undefined) parts.push(`App: ${d.appDuplicateCount}`);
        if (d.hubspotDuplicateCount !== undefined) parts.push(`HubSpot: ${d.hubspotDuplicateCount}`);
        if (d.ghostBookingsFound !== undefined) parts.push(`${d.ghostBookingsFound} ghost bookings`);
        if (d.bookingsProcessed !== undefined) parts.push(`${d.bookingsProcessed} bookings`);
        if (d.recordsUpdated !== undefined) parts.push(`${d.recordsUpdated} updated`);
        
        // Extract date/time fields
        if (d.booking_date) parts.push(d.booking_date);
        if (d.start_time) parts.push(d.start_time);
        if (d.bay_name) parts.push(d.bay_name);
        
        // Extract action subtype if present
        if (d.action && d.action !== entry.action) {
            parts.push(d.action.replace(/_/g, ' '));
        }
        
        // Extract tier info
        if (d.tier) parts.push(d.tier);
        if (d.old_tier && d.new_tier) parts.push(`${d.old_tier} → ${d.new_tier}`);
        
        // If we got parts, return them; otherwise try action-specific handling
        if (parts.length > 0) {
            return parts.join(' • ');
        }
        
        // Action-specific details as fallback
        switch (entry.action) {
            case 'view_member':
            case 'view_member_profile':
            case 'view_member_billing':
                if (d.section) parts.push(d.section);
                break;
            case 'tour_checkin':
            case 'tour_completed':
            case 'tour_no_show':
            case 'tour_cancelled':
            case 'tour_status_changed':
                if (d.guest_email) parts.push(d.guest_email);
                if (d.tour_date) parts.push(d.tour_date);
                if (d.previous_status && d.new_status) {
                    parts.push(`${d.previous_status} → ${d.new_status}`);
                }
                break;
            case 'create_event':
            case 'update_event':
            case 'delete_event':
                if (d.event_date || d.date) parts.push(d.event_date || d.date);
                if (d.location) parts.push(d.location);
                break;
            case 'manual_rsvp':
            case 'remove_rsvp':
                if (d.attendee_email || d.rsvp_email) parts.push(d.attendee_email || d.rsvp_email);
                if (d.event_date) parts.push(d.event_date);
                break;
            case 'create_wellness_class':
            case 'update_wellness_class':
            case 'delete_wellness_class':
                if (d.instructor) parts.push(`Instructor: ${d.instructor}`);
                if (d.date) parts.push(d.date);
                break;
            case 'manual_enrollment':
                if (d.memberEnrolled) parts.push(d.memberEnrolled);
                break;
            case 'create_announcement':
            case 'update_announcement':
            case 'delete_announcement':
                if (d.priority) parts.push(`Priority: ${d.priority}`);
                break;
            case 'create_closure':
            case 'update_closure':
            case 'delete_closure':
                if (d.startDate && d.endDate) parts.push(`${d.startDate} to ${d.endDate}`);
                else if (d.startDate) parts.push(d.startDate);
                if (d.affectedAreas) parts.push(d.affectedAreas);
                if (d.reason) parts.push(d.reason);
                break;
            case 'add_guest_to_booking':
                if (d.guest_name) parts.push(d.guest_name);
                if (d.guest_email) parts.push(d.guest_email);
                if (d.fee_amount) parts.push(`Fee: $${(d.fee_amount / 100).toFixed(2)}`);
                break;
            case 'link_member_to_booking':
            case 'unlink_member_from_booking':
                if (d.memberEmail || d.linkedBy) parts.push(d.memberEmail || d.linkedBy);
                break;
            case 'direct_add_participant':
                if (d.guestName) parts.push(d.guestName);
                if (d.memberName) parts.push(d.memberName);
                if (d.participantType) parts.push(d.participantType);
                if (d.reason) parts.push(d.reason);
                break;
            case 'update_payment_status':
                if (d.participantName) parts.push(d.participantName);
                if (d.newStatus) parts.push(`Status: ${d.newStatus}`);
                if (d.action) parts.push(d.action.replace(/_/g, ' '));
                if (d.participantCount) parts.push(`${d.participantCount} participants`);
                break;
            case 'add_group_member':
            case 'remove_group_member':
                if (d.memberEmail) parts.push(d.memberEmail);
                if (d.groupType) parts.push(d.groupType);
                break;
            case 'import_trackman':
                if (d.filename) parts.push(d.filename);
                if (d.bookingsImported !== undefined) parts.push(`${d.bookingsImported} bookings`);
                break;
            case 'reassign_booking':
                if (d.oldEmail && d.newEmail) parts.push(`${d.oldEmail} → ${d.newEmail}`);
                break;
            case 'booking_cancelled_webhook':
            case 'booking_cancelled_member':
                if (d.member_email) parts.push(d.member_email);
                if (d.booking_date) parts.push(d.booking_date);
                if (d.booking_time) parts.push(d.booking_time);
                if (d.bay_name) parts.push(d.bay_name);
                if (d.refund_amount_cents && d.refund_amount_cents > 0) {
                    parts.push(`Refunded: $${(d.refund_amount_cents / 100).toFixed(2)}`);
                }
                if (d.refunded_passes && d.refunded_passes > 0) {
                    parts.push(`${d.refunded_passes} guest pass${d.refunded_passes > 1 ? 'es' : ''} refunded`);
                }
                break;
            case 'cancel_wellness_enrollment':
                if (d.member_email) parts.push(d.member_email);
                if (d.class_title) parts.push(d.class_title);
                if (d.class_date) parts.push(d.class_date);
                break;
            case 'cancel_event_rsvp':
                if (d.member_email) parts.push(d.member_email);
                if (d.event_title) parts.push(d.event_title);
                if (d.event_date) parts.push(d.event_date);
                break;
            case 'payment_refunded':
            case 'payment_refund_partial':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                if (d.is_partial) parts.push('(Partial)');
                if (d.refund_reason) parts.push(d.refund_reason);
                break;
            case 'payment_succeeded':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                if (d.description) parts.push(d.description);
                break;
            case 'payment_failed':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                if (d.failure_reason) parts.push(d.failure_reason);
                break;
            case 'record_charge':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount) parts.push(`$${(Number(d.amount) / 100).toFixed(2)}`);
                if (d.description) parts.push(d.description);
                break;
            case 'send_payment_link':
                if (d.member_email) parts.push(d.member_email);
                break;
            case 'duplicate_detection':
            case 'detect_duplicates':
                if (d.appDuplicateCount !== undefined) parts.push(`App: ${d.appDuplicateCount} duplicates`);
                if (d.hubspotDuplicateCount !== undefined) parts.push(`HubSpot: ${d.hubspotDuplicateCount} duplicates`);
                if (d.action) parts.push(d.action.replace(/_/g, ' '));
                break;
            case 'fix_ghost_bookings':
            case 'fix_trackman_ghost_bookings':
                if (d.ghostBookingsFound !== undefined) parts.push(`${d.ghostBookingsFound} ghost bookings found`);
                if (d.action) parts.push(d.action.replace(/_/g, ' '));
                break;
            case 'mark_booking_as_event':
                if (d.trackman_booking_id) parts.push(`TM: ${d.trackman_booking_id}`);
                break;
            case 'assign_booking_with_players':
                if (d.owner_email) parts.push(d.owner_email);
                if (d.owner_name) parts.push(d.owner_name);
                if (d.total_players) parts.push(`${d.total_players} players`);
                break;
            case 'change_booking_owner':
                if (d.previous_owner && d.new_email) parts.push(`${d.previous_owner} → ${d.new_email}`);
                else if (d.new_email) parts.push(d.new_email);
                if (d.new_name) parts.push(d.new_name);
                break;
            case 'cancel_booking':
                if (d.member_email) parts.push(d.member_email);
                if (d.booking_date) parts.push(d.booking_date);
                if (d.start_time) parts.push(d.start_time);
                break;
            case 'process_refund':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount) parts.push(`$${(typeof d.amount === 'number' ? d.amount / 100 : parseFloat(d.amount)).toFixed(2)}`);
                if (d.reason) parts.push(d.reason);
                break;
            case 'pause_subscription':
            case 'resume_subscription':
            case 'cancel_subscription':
                if (d.member_email) parts.push(d.member_email);
                if (d.tier) parts.push(d.tier);
                if (d.reason) parts.push(d.reason);
                break;
            case 'change_tier':
                if (d.member_email) parts.push(d.member_email);
                if (d.old_tier && d.new_tier) parts.push(`${d.old_tier} → ${d.new_tier}`);
                else if (d.new_tier) parts.push(d.new_tier);
                break;
            case 'sync_hubspot':
                if (d.contactsUpdated !== undefined) parts.push(`${d.contactsUpdated} contacts updated`);
                if (d.contactsCreated !== undefined) parts.push(`${d.contactsCreated} created`);
                break;
            case 'link_stripe_customer':
                if (d.member_email) parts.push(d.member_email);
                if (d.stripe_customer_id) parts.push(`Stripe: ${d.stripe_customer_id.substring(0, 12)}...`);
                break;
            case 'update_member_notes':
                if (d.member_email) parts.push(d.member_email);
                break;
            case 'reset_trackman_data':
                if (d.bookingsReset !== undefined) parts.push(`${d.bookingsReset} bookings reset`);
                break;
            // Stripe subscription events
            case 'subscription_created':
            case 'subscription_updated':
            case 'subscription_cancelled':
                if (d.member_email) parts.push(d.member_email);
                if (d.tier) parts.push(d.tier);
                if (d.stripe_subscription_id) parts.push(`Sub: ${d.stripe_subscription_id.substring(0, 12)}...`);
                break;
            // Invoice events
            case 'invoice_paid':
            case 'invoice_failed':
            case 'invoice_overdue':
            case 'invoice_removed':
                if (d.member_email) parts.push(d.member_email);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                if (d.invoice_id) parts.push(`Invoice: ${d.invoice_id.substring(0, 12)}...`);
                break;
            // Day pass events
            case 'day_pass_purchased':
            case 'day_pass_redeemed':
            case 'day_pass_refunded':
                if (d.visitor_email || d.email) parts.push(d.visitor_email || d.email);
                if (d.visitor_name || d.name) parts.push(d.visitor_name || d.name);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                break;
            case 'guest_pass_used':
                if (d.member_email) parts.push(d.member_email);
                if (d.guest_name) parts.push(d.guest_name);
                if (d.passes_remaining !== undefined) parts.push(`${d.passes_remaining} passes left`);
                break;
            // Waiver events
            case 'waiver_marked_reviewed':
            case 'all_waivers_marked_reviewed':
                if (d.member_email) parts.push(d.member_email);
                if (d.count) parts.push(`${d.count} waivers`);
                break;
            // TrackMan sync events
            case 'trackman_rescan':
            case 'trackman_backfill':
            case 'backfill_sessions':
                if (d.bookingsProcessed !== undefined) parts.push(`${d.bookingsProcessed} bookings`);
                if (d.startDate && d.endDate) parts.push(`${d.startDate} to ${d.endDate}`);
                break;
            // Booking status events
            case 'booking_approved':
            case 'booking_approved_linked':
            case 'booking_declined':
            case 'booking_attended':
            case 'booking_no_show':
                if (d.member_email) parts.push(d.member_email);
                if (d.booking_date) parts.push(d.booking_date);
                if (d.start_time) parts.push(d.start_time);
                if (d.bay_name) parts.push(d.bay_name);
                break;
            case 'booking_payment_updated':
                if (d.member_email) parts.push(d.member_email);
                if (d.payment_status) parts.push(`Status: ${d.payment_status}`);
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                break;
            // Privacy/CCPA
            case 'anonymize':
                if (d.member_email) parts.push(d.member_email);
                if (d.reason) parts.push(d.reason);
                break;
            // Visitor events
            case 'visitor_created':
            case 'visitor_stripe_linked':
            case 'delete_visitor':
                if (d.visitor_email || d.email) parts.push(d.visitor_email || d.email);
                if (d.visitor_name || d.name) parts.push(d.visitor_name || d.name);
                break;
            case 'data_migration':
                if (d.from && d.to) parts.push(`${d.from} → ${d.to}`);
                if (d.recordsAffected !== undefined) parts.push(`${d.recordsAffected} records`);
                break;
            // Bulk actions
            case 'bulk_status_sync':
            case 'bulk_link_stripe_hubspot':
            case 'bulk_visit_count_sync':
            case 'bulk_payment_status_sync':
            case 'cleanup_mindbody_ids':
            case 'sync_members_to_hubspot':
            case 'manual_sync':
                if (d.recordsUpdated !== undefined) parts.push(`${d.recordsUpdated} updated`);
                if (d.recordsCreated !== undefined) parts.push(`${d.recordsCreated} created`);
                if (d.recordsSkipped !== undefined) parts.push(`${d.recordsSkipped} skipped`);
                if (d.total !== undefined) parts.push(`${d.total} total`);
                break;
            // Basic booking/member actions
            case 'approve_booking':
            case 'decline_booking':
            case 'create_booking':
            case 'reschedule_booking':
            case 'mark_no_show':
            case 'mark_attended':
                if (d.member_email) parts.push(d.member_email);
                if (d.booking_date) parts.push(d.booking_date);
                if (d.start_time) parts.push(d.start_time);
                if (d.bay_name || d.bay) parts.push(d.bay_name || `Bay ${d.bay}`);
                break;
            case 'invite_member':
            case 'create_member':
            case 'update_member':
            case 'delete_member':
            case 'archive_member':
                if (d.member_email || d.email) parts.push(d.member_email || d.email);
                if (d.member_name || d.name) parts.push(d.member_name || d.name);
                if (d.tier) parts.push(d.tier);
                break;
            case 'sync_events':
            case 'sync_wellness':
                if (d.eventsUpdated !== undefined) parts.push(`${d.eventsUpdated} updated`);
                if (d.eventsCreated !== undefined) parts.push(`${d.eventsCreated} created`);
                if (d.source) parts.push(`Source: ${d.source}`);
                break;
            case 'review_waiver':
                if (d.member_email) parts.push(d.member_email);
                if (d.waiver_version) parts.push(`v${d.waiver_version}`);
                break;
            case 'link_trackman_to_member':
                if (d.member_email) parts.push(d.member_email);
                if (d.trackman_email) parts.push(`TM: ${d.trackman_email}`);
                break;
            default:
                // Generic fallback
                if (d.member_email) parts.push(d.member_email);
                if (d.amount) {
                    const amount = typeof d.amount === 'number' 
                        ? `$${(d.amount / 100).toFixed(2)}` 
                        : d.amount;
                    parts.push(amount);
                }
                if (d.amount_cents) parts.push(`$${(d.amount_cents / 100).toFixed(2)}`);
                if (d.tier) parts.push(`Tier: ${d.tier}`);
                if (d.reason) parts.push(`Reason: ${d.reason}`);
                if (d.bay) parts.push(`Bay ${d.bay}`);
                if (d.booking_date) parts.push(d.booking_date);
                if (d.description) parts.push(d.description);
        }
        
        return parts.join(' • ') || 'No additional details';
    };

    const renderUpdatesTab = () => (
        <div className="space-y-6 animate-content-enter">
            <div className="text-sm text-primary/80 dark:text-white/80 mb-6">
                A complete history of updates, improvements, and new features added to the Ever Club app.
            </div>

            {visibleChangelog.map((entry, index) => (
                <div 
                    key={entry.version}
                    className={`relative pl-8 pb-6 ${index !== visibleChangelog.length - 1 || hasMoreChangelog ? 'border-l-2 border-primary/20 dark:border-white/20' : ''}`}
                >
                    <div className={`absolute left-0 top-0 w-4 h-4 rounded-full -translate-x-[9px] ${
                        entry.isMajor 
                            ? 'bg-primary dark:bg-accent ring-4 ring-primary/20 dark:ring-accent/20' 
                            : 'bg-gray-300 dark:bg-gray-600'
                    }`} />
                    
                    <div className="bg-white/60 dark:bg-white/5 backdrop-blur-sm rounded-xl p-5 border border-primary/10 dark:border-white/25">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-lg font-bold ${
                                        entry.isMajor 
                                            ? 'text-primary dark:text-accent' 
                                            : 'text-primary dark:text-white'
                                    }`}>
                                        v{entry.version}
                                    </span>
                                    {entry.isMajor && (
                                        <span className="text-[10px] font-bold uppercase tracking-wider w-fit bg-primary/10 dark:bg-accent/20 text-primary dark:text-accent px-2 py-0.5 rounded-[4px]">
                                            Major Release
                                        </span>
                                    )}
                                </div>
                                <h3 className="text-base font-semibold text-primary dark:text-white">
                                    {entry.title}
                                </h3>
                            </div>
                            <span className="text-xs text-primary/70 dark:text-white/70 whitespace-nowrap">
                                {formatDate(entry.date)}
                            </span>
                        </div>
                        
                        <ul className="space-y-2">
                            {entry.changes.map((change, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-primary/80 dark:text-white/80">
                                    <span aria-hidden="true" className="material-symbols-outlined text-sm text-primary/70 dark:text-white/70 mt-0.5">check_circle</span>
                                    {change}
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            ))}
            
            {hasMoreChangelog && (
                <div className="flex justify-center pt-4">
                    <button
                        onClick={() => setChangelogLimit(prev => prev + 25)}
                        className="px-6 py-3 rounded-xl bg-primary/10 dark:bg-white/10 text-primary dark:text-white font-medium hover:bg-primary/20 dark:hover:bg-white/20 transition-colors flex items-center gap-2"
                    >
                        <span className="material-symbols-outlined text-xl">expand_more</span>
                        Load More Updates ({changelog.length - changelogLimit} remaining)
                    </button>
                </div>
            )}
        </div>
    );

    const renderActivityTab = () => {
        if (loading && entries.length === 0) {
            return (
                <div className="flex items-center justify-center py-20">
                    <WalkingGolferSpinner size="lg" />
                </div>
            );
        }

        return (
            <div className="animate-page-enter">
                <div className="flex flex-wrap gap-2 mb-4 animate-content-enter">
                    {FILTER_CATEGORIES.map(cat => (
                        <button
                            key={cat.key}
                            onClick={() => setFilterCategory(cat.key)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-fast ${
                                filterCategory === cat.key
                                    ? 'bg-accent text-primary'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            {cat.label}
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap gap-2 mb-4">
                    {uniqueStaff.length > 1 && (
                        <select
                            value={staffFilter}
                            onChange={(e) => setStaffFilter(e.target.value)}
                            className="w-full sm:w-auto px-3 py-2 rounded-xl text-sm bg-white dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white"
                        >
                            <option value="">All Staff Members</option>
                            {uniqueStaff.map(email => (
                                <option key={email} value={email}>{email}</option>
                            ))}
                        </select>
                    )}
                    <select
                        value={sourceFilter}
                        onChange={(e) => setSourceFilter(e.target.value as '' | 'staff' | 'member' | 'system')}
                        className="w-full sm:w-auto px-3 py-2 rounded-xl text-sm bg-white dark:bg-white/5 border border-primary/10 dark:border-white/10 text-primary dark:text-white"
                    >
                        <option value="">All Sources</option>
                        <option value="staff">Staff</option>
                        <option value="member">Member</option>
                        <option value="system">System</option>
                    </select>
                </div>

                {error && (
                    <div className="mb-4 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                        {error}
                    </div>
                )}

                {entries.length === 0 ? (
                    <EmptyState
                        icon="history"
                        title="No activity found"
                        description="Staff actions will appear here as they occur"
                        variant="compact"
                    />
                ) : (
                    <div className="space-y-3">
                        {entries.map((entry, index) => {
                            const actionInfo = getActionInfo(entry.action);
                            return (
                                <div
                                    key={entry.id}
                                    className={`rounded-xl bg-white dark:bg-white/[0.03] shadow-layered dark:shadow-layered-dark overflow-hidden tactile-row ${index < 10 ? `animate-list-item-delay-${index}` : 'animate-list-item'}`}
                                >
                                    <div className="flex gap-3 p-4">
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${actionInfo.color}`}>
                                            <span className="material-symbols-outlined text-[20px]">
                                                {actionInfo.icon}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start">
                                                <h4 className="font-bold text-sm text-primary dark:text-white">
                                                    {actionInfo.label}
                                                </h4>
                                                <span className="text-[10px] ml-2 shrink-0 text-primary/70 dark:text-white/70">
                                                    {formatRelativeTime(entry.createdAt)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                                    entry.actorType === 'system' 
                                                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                                        : entry.actorType === 'member'
                                                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                                        : 'bg-gray-100 text-gray-700 dark:bg-gray-700/30 dark:text-gray-300'
                                                }`}>
                                                    {entry.actorType === 'system' ? 'System' : entry.actorType === 'member' ? 'Member' : 'Staff'}
                                                </span>
                                                <span className="text-xs text-primary/70 dark:text-white/70">
                                                    {entry.actorType === 'system' 
                                                        ? entry.actorEmail || 'Automated'
                                                        : entry.actorType === 'member'
                                                        ? entry.actorEmail || 'Unknown Member'
                                                        : entry.staffName || entry.staffEmail}
                                                </span>
                                            </div>
                                            <p className="text-xs mt-1 text-primary/60 dark:text-white/60 truncate">
                                                {formatDetails(entry)}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        
                        {hasMore && (
                            <button
                                onClick={loadMore}
                                disabled={loading}
                                className="w-full py-3 rounded-xl text-sm font-medium transition-all duration-fast bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10 disabled:opacity-50"
                            >
                                {loading ? 'Loading...' : 'Load More'}
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
            <AnimatedPage className="pb-32">
                {isAdmin && (
                    <div className="flex gap-2 mb-6 animate-content-enter">
                        <button
                            onClick={() => setActiveTab('updates')}
                            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold uppercase tracking-wide transition-all duration-fast ${
                                activeTab === 'updates'
                                    ? 'bg-accent text-primary'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            App Updates
                        </button>
                        <button
                            onClick={() => setActiveTab('activity')}
                            className={`flex-1 py-3 px-4 rounded-xl text-sm font-bold uppercase tracking-wide transition-all duration-fast ${
                                activeTab === 'activity'
                                    ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                    : 'bg-primary/5 text-primary/80 hover:bg-primary/10 dark:bg-white/5 dark:text-white/80 dark:hover:bg-white/10'
                            }`}
                        >
                            Staff Activity
                        </button>
                    </div>
                )}

                {activeTab === 'updates' && renderUpdatesTab()}
                {activeTab === 'activity' && isAdmin && renderActivityTab()}
            </AnimatedPage>
    );
};

export default ChangelogTab;
