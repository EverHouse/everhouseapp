# Database Entity Relationship Diagrams

This document provides focused views of the database schema for different audiences. Each diagram shows only the relevant tables for that particular domain.

> **Note:** These focused diagrams intentionally show only a subset of tables. For the complete schema, see the "Full Schema Reference" section at the bottom. Some views include substitutions where requested tables don't exist in the current schema.

---

## 1. Core Business Diagram

**Audience:** Non-technical stakeholders, product managers, operations team

This is the cleanest view - showing only what business stakeholders care about: Who are the members, what do they book, and what activities are available?

```mermaid
erDiagram
    users {
        varchar id PK
        varchar email UK
        varchar name
        integer tier_id FK
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
    
    resources {
        integer id PK
        varchar name UK
        varchar type
        text description
        boolean is_active
    }
    
    booking_requests {
        integer id PK
        varchar user_id FK
        integer resource_id FK
        date request_date
        time start_time
        time end_time
        varchar status
    }
    
    booking_sessions {
        integer id PK
        integer resource_id FK
        date session_date
        time start_time
        time end_time
        varchar source
    }
    
    events {
        integer id PK
        varchar title
        text description
        timestamp start_time
        timestamp end_time
        varchar location
        integer max_capacity
    }
    
    event_rsvps {
        integer id PK
        integer event_id FK
        varchar user_email
        varchar status
    }

    %% Relationships
    users ||--o{ booking_requests : "makes"
    users }o--|| membership_tiers : "has"
    resources ||--o{ booking_requests : "booked"
    booking_requests ||--o| booking_sessions : "generates"
    events ||--o{ event_rsvps : "has"
    users ||--o{ event_rsvps : "attends"
```

### What This Shows
- **Members** belong to a membership tier that determines benefits
- **Bookings** reserve simulator bays (resources) for specific time slots
- **Sessions** represent actual usage of the bays
- **Events** are club activities that members can RSVP to attend

---

## 2. Finance & Billing Diagram

**Audience:** Developers working on payments, billing team, finance staff

This view focuses purely on money flow: How members pay, billing group structures, and payment tracking.

> **Schema Note:** There is no separate `invoices` table. Invoice management is handled directly in Stripe. The `stripe_payment_intents` table tracks payment attempts and the `booking_fee_snapshots` table captures calculated fees.

```mermaid
erDiagram
    users {
        varchar id PK
        varchar email UK
        varchar name
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
        varchar name
        integer price_cents
    }
    
    day_pass_purchases {
        varchar id PK
        varchar email
        varchar stripe_payment_intent_id FK
        varchar status
        integer price_cents
        timestamp purchased_at
    }
    
    booking_fee_snapshots {
        integer id PK
        integer booking_id FK
        integer total_cents
        varchar stripe_payment_intent_id FK
        varchar status
    }

    %% Relationships
    users }o--o| billing_groups : "belongs to"
    users ||--o{ stripe_payment_intents : "pays"
    users ||--o{ day_pass_purchases : "purchases"
    day_pass_purchases }o--|| stripe_payment_intents : "paid via"
    booking_fee_snapshots }o--|| stripe_payment_intents : "charged via"
```

### What This Shows
- **Billing Groups** handle family/corporate unified billing (one person pays for multiple members)
- **Stripe Payment Intents** track all payment attempts and completions
- **Booking Fee Snapshots** capture calculated fees at booking time (serves as "invoice" data)
- **Day Passes** are one-time purchases for non-members

---

## 3. Integrations Diagram

**Audience:** Developers working on external service connections

This view shows how data maps to external services: HubSpot CRM, Trackman simulators, and Stripe.

> **Schema Note:** There is no separate `stripe_customers` table. Stripe customer IDs are stored in `billing_groups.primary_stripe_customer_id`.

```mermaid
erDiagram
    users {
        varchar id PK
        varchar email UK
        varchar name
    }
    
    billing_groups {
        integer id PK
        varchar primary_email UK
        varchar primary_stripe_customer_id
        varchar group_name
    }
    
    hubspot_deals {
        integer id PK
        varchar hubspot_deal_id UK
        varchar member_email
        varchar deal_name
        varchar stage
        numeric amount
        timestamp close_date
    }
    
    resources {
        integer id PK
        varchar name UK
        varchar type
    }
    
    trackman_bay_slots {
        integer id PK
        integer resource_id FK
        varchar trackman_bay_id
        varchar bay_name
    }
    
    trackman_import_runs {
        integer id PK
        timestamp started_at
        timestamp completed_at
        integer records_processed
        integer records_matched
        varchar status
    }

    %% Relationships
    users ||--o{ hubspot_deals : "syncs to"
    users }o--o| billing_groups : "has Stripe customer"
    resources ||--o{ trackman_bay_slots : "maps to"
```

### What This Shows
- **HubSpot Deals** track membership sales in CRM (synced from Stripe subscriptions)
- **Billing Groups** store Stripe customer IDs for payment integration
- **Trackman Bay Slots** map simulator bays to Trackman's booking system
- **Trackman Import Runs** log CSV import history from Trackman exports

---

## 4. System Internals Diagram

**Audience:** Backend engineers, DevOps, debugging infrastructure issues

This view covers operational tables for debugging and monitoring.

> **Schema Note:** There is no `error_logs` table. Error logging is handled via structured `console.error` calls that appear in server runtime logs.

```mermaid
erDiagram
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
    
    notifications {
        integer id PK
        varchar user_email
        varchar type
        varchar title
        text message
        boolean is_read
        timestamp created_at
    }
    
    app_settings {
        integer id PK
        varchar key UK
        text value
        varchar category
        timestamp updated_at
    }
    
    admin_audit_log {
        integer id PK
        varchar staff_email
        varchar action
        varchar resource_type
        varchar resource_id
        jsonb details
        timestamp created_at
    }
    
    webhook_processed_events {
        integer id PK
        varchar event_id UK
        varchar source
        timestamp processed_at
    }
```

### What This Shows
- **Job Queue** handles background tasks (emails, syncs, cleanup)
- **Rate Limits** prevent API abuse by tracking request counts
- **Notifications** are in-app alerts delivered to users
- **App Settings** store configurable values (feature flags, etc.)
- **Admin Audit Log** tracks all staff actions for compliance
- **Webhook Events** ensures external events are processed exactly once

---

## Full Schema Reference

For the complete database schema with all 70+ tables, see below. This is the authoritative reference for all tables and relationships.

<details>
<summary>Click to expand full schema</summary>

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

</details>

---

## Table Summary

| Category | Tables | Count |
|----------|--------|-------|
| **Core Users & Membership** | users, staff_users, membership_tiers, tier_features, tier_feature_values, billing_groups, group_members, family_add_on_products | 8 |
| **Resources & Availability** | resources, availability_blocks, trackman_bay_slots, facility_closures, closure_reasons | 5 |
| **Bookings** | booking_requests, booking_sessions, booking_participants, booking_members, booking_guests, booking_fee_snapshots, booking_payment_audit | 7 |
| **Guests & Passes** | guests, guest_passes, guest_check_ins, pass_redemption_logs | 4 |
| **Day Passes** | day_pass_purchases | 1 |
| **Events** | events, event_rsvps | 2 |
| **Wellness** | wellness_classes, wellness_enrollments | 2 |
| **Payments & Stripe** | stripe_payment_intents, stripe_products, stripe_transaction_cache, discount_rules | 4 |
| **HubSpot Integration** | hubspot_deals, hubspot_line_items, hubspot_product_mappings, hubspot_form_configs, hubspot_sync_queue, dismissed_hubspot_meetings | 6 |
| **Tours** | tours | 1 |
| **Communication** | communication_logs, notifications, announcements, notice_types, user_dismissed_notices, push_subscriptions, email_events, member_notes | 8 |
| **Authentication** | sessions, magic_links, user_linked_emails | 3 |
| **TrackMan Integration** | trackman_import_runs, trackman_unmatched_bookings, trackman_webhook_events, trackman_webhook_dedup | 4 |
| **Admin & Audit** | admin_audit_log, billing_audit_log, account_deletion_requests, data_export_requests, bug_reports, form_submissions | 6 |
| **Content & Settings** | app_settings, system_settings, faqs, gallery_images, training_sections, cafe_items | 6 |
| **System & Jobs** | job_queue, rate_limits, webhook_processed_events | 3 |
| **Integrity & Legacy** | integrity_check_history, integrity_issues_tracking, integrity_ignores, integrity_audit_log, legacy_import_jobs, legacy_purchases, usage_ledger | 7 |
