# Database Entity Relationship Diagram

This document contains the complete ER diagram for all database tables and their relationships.

## Mermaid ER Diagram

```mermaid
erDiagram
    %% ========== CORE USER & MEMBERSHIP ==========
    users {
        varchar id PK
        varchar email UK
        varchar name
        integer tier_id FK
        integer family_group_id FK
        timestamp created_at
    }
    
    staff_users {
        integer id PK
        varchar email UK
        varchar name
        varchar role
        timestamp created_at
    }
    
    membership_tiers {
        integer id PK
        varchar name UK
        varchar slug UK
        text description
        integer monthly_price_cents
        boolean is_active
    }
    
    tier_features {
        integer id PK
        varchar feature_key UK
        varchar name
        text description
    }
    
    tier_feature_values {
        integer id PK
        integer tier_id FK
        integer feature_id FK
        text value
    }
    
    billing_groups {
        integer id PK
        varchar primary_email UK
        varchar primary_stripe_customer_id
        varchar primary_stripe_subscription_id
        varchar group_name
        text type
        boolean is_active
    }
    
    group_members {
        integer id PK
        integer billing_group_id FK
        varchar member_email
        varchar relationship
        boolean is_primary
    }
    
    family_add_on_products {
        integer id PK
        varchar tier_name UK
        varchar stripe_product_id
        integer price_cents
    }
    
    %% ========== RESOURCES & AVAILABILITY ==========
    resources {
        integer id PK
        varchar name UK
        varchar type
        text description
        boolean is_active
        integer sort_order
    }
    
    availability_blocks {
        integer id PK
        integer resource_id FK
        date block_date
        time start_time
        time end_time
        varchar block_type
        integer closure_id FK
        integer event_id
        integer wellness_class_id
    }
    
    trackman_bay_slots {
        integer id PK
        integer resource_id FK
        varchar trackman_bay_id
        varchar bay_name
    }
    
    facility_closures {
        integer id PK
        date closure_date
        time start_time
        time end_time
        varchar reason
        boolean is_full_day
        boolean affects_all_resources
    }
    
    closure_reasons {
        integer id PK
        varchar label UK
        integer sort_order
        boolean is_active
    }
    
    %% ========== BOOKINGS ==========
    booking_requests {
        integer id PK
        varchar user_id FK
        varchar user_email
        integer resource_id FK
        date request_date
        time start_time
        time end_time
        integer duration_minutes
        varchar status
        integer closure_id FK
        integer session_id FK
        varchar trackman_booking_id
        boolean is_event
        jsonb request_participants
    }
    
    booking_sessions {
        integer id PK
        varchar trackman_booking_id UK
        integer resource_id FK
        date session_date
        time start_time
        time end_time
        varchar source
        boolean needs_review
    }
    
    booking_participants {
        integer id PK
        integer session_id FK
        varchar user_id
        integer guest_id
        varchar participant_type
        varchar display_name
        varchar payment_status
        varchar invite_status
        integer cached_fee_cents
    }
    
    booking_members {
        integer id PK
        integer booking_id FK
        varchar user_email
        integer slot_number
        boolean is_primary
        varchar trackman_booking_id
    }
    
    booking_guests {
        integer id PK
        integer booking_id FK
        varchar guest_name
        varchar guest_email
        integer slot_number
        varchar trackman_booking_id
    }
    
    booking_fee_snapshots {
        integer id PK
        integer booking_id FK
        integer session_id FK
        jsonb participant_fees
        integer total_cents
        varchar stripe_payment_intent_id
        varchar status
    }
    
    booking_payment_audit {
        integer id PK
        integer booking_id FK
        integer session_id
        integer participant_id
        varchar action
        varchar staff_email
        numeric amount_affected
        varchar previous_status
        varchar new_status
    }
    
    %% ========== GUESTS & PASSES ==========
    guests {
        integer id PK
        varchar email
        varchar name
        varchar phone
        timestamp created_at
    }
    
    guest_passes {
        integer id PK
        varchar member_email UK
        integer total_passes
        integer used_passes
        timestamp last_reset_at
    }
    
    guest_check_ins {
        integer id PK
        varchar member_email
        varchar guest_name
        varchar guest_email
        timestamp check_in_time
        varchar checked_in_by
    }
    
    pass_redemption_logs {
        integer id PK
        varchar member_email
        varchar pass_type
        integer quantity
        varchar reason
        timestamp created_at
    }
    
    %% ========== DAY PASSES ==========
    day_pass_purchases {
        varchar id PK
        varchar email
        varchar name
        integer booking_id FK
        varchar stripe_payment_intent_id
        varchar status
        integer price_cents
        timestamp purchased_at
    }
    
    %% ========== EVENTS ==========
    events {
        integer id PK
        varchar title
        text description
        timestamp start_time
        timestamp end_time
        varchar location
        varchar eventbrite_id UK
        boolean is_active
        integer max_capacity
    }
    
    event_rsvps {
        integer id PK
        integer event_id FK
        varchar user_email
        varchar matched_user_id FK
        varchar status
        timestamp created_at
    }
    
    %% ========== WELLNESS ==========
    wellness_classes {
        integer id PK
        varchar google_calendar_id UK
        varchar title
        text description
        timestamp start_time
        timestamp end_time
        integer max_capacity
        boolean is_active
    }
    
    wellness_enrollments {
        integer id PK
        integer wellness_class_id
        varchar user_email
        varchar status
        timestamp enrolled_at
    }
    
    %% ========== PAYMENTS & STRIPE ==========
    stripe_payment_intents {
        integer id PK
        varchar stripe_payment_intent_id UK
        varchar customer_email
        integer amount_cents
        varchar status
        varchar payment_type
        timestamp created_at
    }
    
    stripe_products {
        integer id PK
        varchar stripe_product_id UK
        varchar hubspot_product_id UK
        varchar name
        integer price_cents
    }
    
    stripe_transaction_cache {
        integer id PK
        varchar stripe_id UK
        varchar type
        jsonb data
        timestamp cached_at
    }
    
    discount_rules {
        integer id PK
        varchar discount_tag UK
        varchar name
        integer discount_percent
        boolean is_active
    }
    
    %% ========== HUBSPOT INTEGRATION ==========
    hubspot_deals {
        integer id PK
        varchar hubspot_deal_id UK
        varchar member_email
        varchar deal_name
        varchar stage
        numeric amount
        timestamp close_date
    }
    
    hubspot_line_items {
        integer id PK
        varchar hubspot_line_item_id UK
        varchar hubspot_deal_id
        varchar product_name
        integer quantity
        numeric amount
    }
    
    hubspot_product_mappings {
        integer id PK
        varchar hubspot_product_id UK
        varchar internal_product_type
        varchar tier_slug
    }
    
    hubspot_form_configs {
        integer id PK
        varchar form_type UK
        varchar hubspot_form_id
        varchar hubspot_portal_id
    }
    
    hubspot_sync_queue {
        integer id PK
        varchar entity_type
        varchar entity_id
        varchar action
        jsonb payload
        varchar status
        timestamp created_at
    }
    
    dismissed_hubspot_meetings {
        integer id PK
        varchar hubspot_meeting_id UK
        varchar dismissed_by
        timestamp dismissed_at
    }
    
    %% ========== TOURS ==========
    tours {
        integer id PK
        varchar google_calendar_id UK
        varchar hubspot_meeting_id UK
        varchar visitor_name
        varchar visitor_email
        timestamp scheduled_at
        varchar status
    }
    
    %% ========== COMMUNICATION & NOTIFICATIONS ==========
    communication_logs {
        integer id PK
        varchar member_email
        varchar type
        varchar direction
        varchar subject
        text body
        varchar status
        varchar hubspot_engagement_id
    }
    
    notifications {
        integer id PK
        varchar user_email
        varchar type
        varchar title
        text message
        boolean is_read
        timestamp created_at
    }
    
    announcements {
        integer id PK
        varchar title
        text message
        varchar priority
        boolean is_active
        timestamp starts_at
        timestamp ends_at
        integer closure_id
        boolean show_as_banner
    }
    
    notice_types {
        integer id PK
        varchar name UK
        text description
        boolean is_active
    }
    
    user_dismissed_notices {
        integer id PK
        varchar user_email
        varchar notice_type
        timestamp dismissed_at
    }
    
    push_subscriptions {
        integer id PK
        varchar endpoint UK
        varchar user_email
        jsonb keys
        timestamp created_at
    }
    
    email_events {
        integer id PK
        varchar event_id UK
        varchar email
        varchar event_type
        timestamp occurred_at
    }
    
    member_notes {
        integer id PK
        varchar member_email
        text note
        varchar created_by
        timestamp created_at
    }
    
    %% ========== AUTHENTICATION ==========
    sessions {
        varchar sid PK
        jsonb sess
        timestamp expire
    }
    
    magic_links {
        integer id PK
        varchar token UK
        varchar email
        timestamp expires_at
        boolean is_used
    }
    
    user_linked_emails {
        integer id PK
        varchar primary_email
        varchar linked_email
        timestamp linked_at
    }
    
    %% ========== TRACKMAN INTEGRATION ==========
    trackman_import_runs {
        integer id PK
        timestamp started_at
        timestamp completed_at
        integer records_processed
        integer records_matched
        varchar status
    }
    
    trackman_unmatched_bookings {
        integer id PK
        varchar trackman_booking_id
        jsonb booking_data
        varchar status
        timestamp created_at
    }
    
    trackman_webhook_events {
        integer id PK
        varchar event_type
        jsonb payload
        varchar status
        timestamp received_at
    }
    
    trackman_webhook_dedup {
        integer id PK
        varchar trackman_booking_id UK
        timestamp last_processed_at
    }
    
    %% ========== ADMIN & AUDIT ==========
    admin_audit_log {
        integer id PK
        varchar staff_email
        varchar action
        varchar resource_type
        varchar resource_id
        jsonb details
        timestamp created_at
    }
    
    billing_audit_log {
        integer id PK
        varchar member_email
        varchar hubspot_deal_id
        varchar action_type
        jsonb action_details
        varchar performed_by
        timestamp created_at
    }
    
    account_deletion_requests {
        integer id PK
        integer user_id
        varchar email
        varchar status
        timestamp requested_at
        timestamp processed_at
    }
    
    data_export_requests {
        integer id PK
        varchar user_email
        varchar status
        timestamp requested_at
        timestamp completed_at
        text download_url
    }
    
    bug_reports {
        integer id PK
        varchar user_email
        text description
        varchar status
        varchar page_url
        timestamp created_at
    }
    
    form_submissions {
        integer id PK
        varchar form_type
        varchar email
        jsonb data
        timestamp submitted_at
    }
    
    %% ========== CONTENT & SETTINGS ==========
    app_settings {
        integer id PK
        varchar key UK
        text value
        varchar category
        timestamp updated_at
    }
    
    system_settings {
        varchar key PK
        text value
        timestamp updated_at
    }
    
    faqs {
        integer id PK
        varchar question
        text answer
        varchar category
        integer sort_order
        boolean is_active
    }
    
    gallery_images {
        integer id PK
        varchar title
        text url
        varchar category
        integer sort_order
        boolean is_active
    }
    
    training_sections {
        integer id PK
        varchar title UK
        varchar guide_id UK
        text content
        integer sort_order
    }
    
    cafe_items {
        integer id PK
        varchar category UK
        varchar name UK
        numeric price
        text description
        boolean is_active
    }
    
    %% ========== SYSTEM & JOBS ==========
    job_queue {
        integer id PK
        varchar job_type
        jsonb payload
        varchar status
        integer attempts
        timestamp run_at
        timestamp created_at
    }
    
    rate_limits {
        integer id PK
        varchar key UK
        integer count
        timestamp window_start
    }
    
    webhook_processed_events {
        integer id PK
        varchar event_id UK
        varchar source
        timestamp processed_at
    }
    
    %% ========== INTEGRITY & LEGACY ==========
    integrity_check_history {
        integer id PK
        timestamp run_at
        integer issues_found
        jsonb summary
    }
    
    integrity_issues_tracking {
        integer id PK
        varchar issue_key UK
        varchar issue_type
        varchar status
        jsonb details
        timestamp first_detected_at
    }
    
    integrity_ignores {
        integer id PK
        varchar issue_key UK
        varchar ignored_by
        text reason
        timestamp ignored_at
    }
    
    integrity_audit_log {
        integer id PK
        varchar action
        varchar issue_key
        jsonb details
        varchar performed_by
        timestamp created_at
    }
    
    legacy_import_jobs {
        integer id PK
        varchar import_type
        varchar status
        integer records_processed
        timestamp started_at
        timestamp completed_at
    }
    
    legacy_purchases {
        integer id PK
        varchar email
        varchar product_type
        numeric amount
        timestamp purchase_date
    }
    
    usage_ledger {
        integer id PK
        varchar user_email
        varchar usage_type
        integer quantity
        timestamp recorded_at
    }

    %% ========== RELATIONSHIPS ==========
    users ||--o{ booking_requests : "makes"
    users }o--|| membership_tiers : "has tier"
    users }o--o| billing_groups : "belongs to"
    
    membership_tiers ||--o{ tier_feature_values : "has"
    tier_features ||--o{ tier_feature_values : "defines"
    
    billing_groups ||--o{ group_members : "contains"
    
    resources ||--o{ booking_requests : "booked for"
    resources ||--o{ booking_sessions : "hosts"
    resources ||--o{ availability_blocks : "has"
    resources ||--o{ trackman_bay_slots : "has"
    
    facility_closures ||--o{ booking_requests : "affects"
    facility_closures ||--o{ availability_blocks : "creates"
    
    booking_requests ||--o{ day_pass_purchases : "paid via"
    booking_requests ||--o{ booking_fee_snapshots : "has"
    
    booking_sessions ||--o{ booking_fee_snapshots : "has"
    booking_sessions ||--o{ booking_participants : "contains"
    
    events ||--o{ event_rsvps : "has"
    users ||--o{ event_rsvps : "attends"
```

## Table Summary

| Category | Tables |
|----------|--------|
| **Core Users & Membership** | users, staff_users, membership_tiers, tier_features, tier_feature_values, billing_groups, group_members, family_add_on_products |
| **Resources & Availability** | resources, availability_blocks, trackman_bay_slots, facility_closures, closure_reasons |
| **Bookings** | booking_requests, booking_sessions, booking_participants, booking_members, booking_guests, booking_fee_snapshots, booking_payment_audit |
| **Guests & Passes** | guests, guest_passes, guest_check_ins, pass_redemption_logs |
| **Day Passes** | day_pass_purchases |
| **Events** | events, event_rsvps |
| **Wellness** | wellness_classes, wellness_enrollments |
| **Payments & Stripe** | stripe_payment_intents, stripe_products, stripe_transaction_cache, discount_rules |
| **HubSpot Integration** | hubspot_deals, hubspot_line_items, hubspot_product_mappings, hubspot_form_configs, hubspot_sync_queue, dismissed_hubspot_meetings |
| **Tours** | tours |
| **Communication** | communication_logs, notifications, announcements, notice_types, user_dismissed_notices, push_subscriptions, email_events, member_notes |
| **Authentication** | sessions, magic_links, user_linked_emails |
| **TrackMan Integration** | trackman_import_runs, trackman_unmatched_bookings, trackman_webhook_events, trackman_webhook_dedup |
| **Admin & Audit** | admin_audit_log, billing_audit_log, account_deletion_requests, data_export_requests, bug_reports, form_submissions |
| **Content & Settings** | app_settings, system_settings, faqs, gallery_images, training_sections, cafe_items |
| **System & Jobs** | job_queue, rate_limits, webhook_processed_events |
| **Integrity & Legacy** | integrity_check_history, integrity_issues_tracking, integrity_ignores, integrity_audit_log, legacy_import_jobs, legacy_purchases, usage_ledger |

## Key Relationships

1. **Users → Membership Tiers**: Each user has a membership tier
2. **Users → Billing Groups**: Users can belong to a billing group (family/corporate)
3. **Booking Requests → Users, Resources**: Bookings link users to resources
4. **Booking Sessions → Resources**: Sessions are hosted on resources
5. **Booking Participants → Sessions**: Participants belong to booking sessions
6. **Events → RSVPs → Users**: Event attendance tracking
7. **Tier Features → Feature Values → Tiers**: Feature configuration per tier
8. **Availability Blocks → Resources, Closures**: Availability management
