---
name: hubspot-sync
description: HubSpot CRM synchronization system — queue-based sync of contacts, deals, memberships, products, line items, form submissions, and deal pipeline stages between the Ever Club Members App and HubSpot. Covers contact sync, queue processing, two-way safeguards, and form submission ingestion.
---

# HubSpot Synchronization System

## Architecture Overview

The app integrates with HubSpot CRM as the central member directory. The integration is **asymmetric by design**:

- **HubSpot → App (read direction):** The daily member sync (`syncAllMembersFromHubSpot`) pulls all contacts from HubSpot and upserts them into the local `users` table. HubSpot is the source of truth for member profiles, tiers, statuses, communication preferences, address/DOB, and notes sourced from Mindbody.
- **App → HubSpot (write direction):** The app pushes discrete changes (new contacts, tier changes, payments, day pass purchases, company associations) to HubSpot via a **persistent queue** (`hubspot_sync_queue` table). Deal creation is currently disabled but the infrastructure remains.
- **Form submissions (HubSpot → App):** A separate scheduler pulls form submissions from HubSpot Forms API every 30 minutes and inserts them into the local `form_submissions` table.

### Loop Prevention — Single Writer Rule

The app prevents sync loops between HubSpot ↔ Mindbody ↔ App with two mechanisms:

1. **Stripe-protected members:** When `billing_provider = 'stripe'`, the member sync skips overwriting `membership_status` and `tier` from HubSpot. Stripe is authoritative for those fields.
2. **Mindbody-billed members:** When pushing status to HubSpot (`syncMemberToHubSpot`), the app skips writing `membership_status` for Mindbody-billed members to avoid a loop where Mindbody → HubSpot → App → HubSpot would cycle indefinitely.
3. **Visitor protection:** Users with `role = 'visitor'` are not overwritten to `role = 'member'` by the HubSpot sync.

## Queue Model

All outbound writes to HubSpot go through a PostgreSQL-backed job queue stored in the `hubspot_sync_queue` table. This decouples the user-facing request from the HubSpot API call.

### Supported Operations

| Operation       | Priority | Description                                      |
|-----------------|----------|--------------------------------------------------|
| `create_contact`| 5        | Find or create a HubSpot contact by email        |
| `update_contact`| 5        | Update contact membership status                 |
| `sync_tier`     | 2        | Push tier change to contact + deal properties     |
| `sync_company`  | 5        | Find-or-create company, associate with contact   |
| `sync_payment`  | 3        | Add Stripe payment as line item on member deal   |
| `sync_day_pass` | 3        | Add day-pass purchase as line item on member deal|
| `sync_member`   | 3        | Full member sync (currently disabled)            |
| `create_deal`   | 5        | Create membership deal (currently disabled)      |

### Enqueue Flow

1. A business operation (e.g., tier change, Stripe webhook) calls a helper in `server/core/hubspot/queueHelpers.ts` (e.g., `queueTierSync`, `queuePaymentSyncToHubSpot`).
2. The helper calls `enqueueHubSpotSync(operation, payload, options)` which inserts a row into `hubspot_sync_queue`.
3. Each job has an **idempotency key** built from the operation context (e.g., `tier_sync_<email>_<old>_to_<new>`). If a pending/processing job with the same key exists, the duplicate is skipped.
4. Priority is 1–10 (lower = higher priority). Tier syncs use priority 2; payments use 3; contact/company operations use 5.

### Processing

The queue scheduler (`server/schedulers/hubspotQueueScheduler.ts`) runs every **2 minutes**:

1. Recover stuck jobs (processing > 10 minutes → reset to failed with 5-minute retry).
2. Atomically claim up to 20 pending/retryable jobs using `FOR UPDATE SKIP LOCKED`.
3. Execute each job via `executeHubSpotOperation` which dynamically imports the handler module.
4. Mark succeeded jobs as `completed`; failed jobs get exponential backoff retry or go to `dead` state.

See [references/queue-processing.md](references/queue-processing.md) for full retry/backoff details.

## Data Flow: App → HubSpot

### Contact Properties Written

When the app creates or updates a HubSpot contact, it sets:

| App Field            | HubSpot Property         | Notes                                      |
|----------------------|--------------------------|--------------------------------------------|
| email                | email                    | Always lowercased                           |
| firstName / lastName | firstname / lastname     |                                             |
| phone                | phone                    |                                             |
| tier (denormalized)  | membership_tier          | Uses `denormalizeTierForHubSpot` mapping    |
| membership_status    | membership_status        | Skipped for Mindbody-billed members         |
| billing_provider     | billing_provider         | Custom enumeration property                 |
| lifecycle stage      | lifecyclestage           | `customer` for active, `other` for inactive |
| join date            | membership_start_date    | Midnight UTC timestamp                      |
| Stripe fields        | stripe_customer_id, etc. | Only pushed in live Stripe environments     |

### Tier Denormalization

The app stores normalized tier slugs (e.g., `core`, `premium-founding`). The `DB_TIER_TO_HUBSPOT` map in `server/core/hubspot/constants.ts` translates these to HubSpot dropdown labels (e.g., `Core Membership`, `Premium Membership Founding Members`).

### Company Sync

For corporate memberships, `syncCompanyToHubSpot` searches HubSpot by company name or email domain, creates the company if missing (handling 409 duplicates), then associates the contact with the company using association type 280.

### Product and Line Item Sync

- Products are mapped in the `hubspot_product_mappings` table (tier → HubSpot product ID).
- `addLineItemToDeal` creates a HubSpot line item, associates it with the deal (association type 20), and records it locally in `hubspot_line_items`.
- Line items carry discount percentage and reason, preserved across tier changes.
- Stripe payments and day-pass purchases are synced as line items on the member's existing deal.

### Deal Pipeline

The membership pipeline has these stages (defined in `server/core/hubspot/constants.ts`):

| Stage                    | ID              | Usage                    |
|--------------------------|-----------------|--------------------------|
| Day Pass / Tour Request  | 2414796536      | Initial inquiry          |
| Tour Booked              | 2413968103      | Tour scheduled           |
| Visited / Day Pass       | 2414796537      | Visited the club         |
| Application Submitted    | 2414797498      | Applied for membership   |
| Billing Setup            | 2825519819      | Payment being configured |
| Closed Won (Active)      | closedwon       | Active member            |
| Payment Declined         | 2825519820      | Payment issues           |
| Closed Lost              | closedlost      | Terminated/cancelled     |

Deal creation is currently disabled (functions return early). The pipeline infrastructure and stage sync remain active for existing deals.

## Data Flow: HubSpot → App

### Member Sync (Daily at 3 AM Pacific)

`syncAllMembersFromHubSpot` in `server/core/memberSync.ts` runs daily:

1. Fetch all contacts from HubSpot (paginated, 100 per page).
2. Skip contacts in the `sync_exclusions` table (permanently deleted members).
3. For each contact, upsert into `users` with `ON CONFLICT (email) DO UPDATE`.
4. **Tier normalization:** Only recognized tiers (matching `TIER_NAMES`) are written; unrecognized tiers log a warning and preserve the existing DB tier.
5. **Status protection:** Stripe-billed and visitor users are not overwritten.
6. **Notes sync:** Membership notes and messages from HubSpot are hashed; new notes create `member_notes` entries attributed to "HubSpot Sync (Mindbody)".
7. **Linked emails:** Merged contact IDs (`hs_merged_object_ids`) are batch-fetched and stored in `user_linked_emails` for email deduplication.
8. **Deal stage sync:** After the main sync, contacts with deal-relevant statuses get their deal stages updated in batches of 5 with 2-second delays.
9. **Status change notifications:** When a member's status changes to a problematic state (past_due, declined, etc.), the app notifies the member and staff, and starts a grace period for Mindbody members.

### HubSpot Contact Properties Read

The sync reads these HubSpot properties and maps them to local fields:

| HubSpot Property              | Local Field                | Notes                          |
|-------------------------------|----------------------------|--------------------------------|
| firstname / lastname          | first_name / last_name     | COALESCE with existing         |
| email                         | email                      | Primary key for upsert         |
| phone                         | phone                      |                                |
| membership_tier               | tier                       | Normalized via `normalizeTierName` |
| membership_status             | membership_status          | Lowercased                     |
| membership_discount_reason    | discount_code              |                                |
| mindbody_client_id            | mindbody_client_id         |                                |
| membership_start_date         | join_date                  | Preferred over createdate      |
| eh_email_updates_opt_in       | email_opt_in               | Parsed as boolean              |
| eh_sms_updates_opt_in         | sms_opt_in                 |                                |
| hs_sms_promotional            | sms_promo_opt_in           | Granular SMS consent           |
| hs_sms_customer_updates       | sms_transactional_opt_in   |                                |
| hs_sms_reminders              | sms_reminders_opt_in       |                                |
| address / city / state / zip  | street_address / city / state / zip_code |                  |
| date_of_birth                 | date_of_birth              | YYYY-MM-DD format              |
| stripe_delinquent             | stripe_delinquent          |                                |

### Form Submission Sync (Every 30 Minutes)

`syncHubSpotFormSubmissions` in `server/core/hubspot/formSync.ts`:

1. Fetch submissions from configured HubSpot form IDs (tour-request, membership, private-hire, event-inquiry, guest-checkin, contact).
2. Deduplicate by `hubspot_submission_id` (exact match) and by email+formType within a ±5 minute window (fuzzy match for locally-created submissions).
3. Extract standard fields (email, firstName, lastName, phone, message) and store remaining fields as JSON metadata.
4. Infer form type from page URL when multiple form types share the same HubSpot form ID.

See [references/sync-operations.md](references/sync-operations.md) for detailed field mappings and transformations.

## HubSpot Contact Cache (Routes Layer)

The `/api/hubspot/contacts` endpoint maintains an in-memory cache with two refresh strategies:

- **Full refresh:** Every 30 minutes, fetch all contacts and enrich with DB data (visit counts, join dates, booking history).
- **Incremental sync:** Every 5 minutes, fetch only contacts modified since last check via `lastmodifieddate` filter.

Contacts are enriched with: lifetime visits (bookings + events + wellness + walk-ins), computed join date (batch-import-aware logic with Nov 12, 2025 cutoff), and former-member classification.

## Key Invariants

1. **Never write membership_status to HubSpot for Mindbody-billed members** — prevents Mindbody ↔ HubSpot loop.
2. **Never overwrite Stripe-protected members' status/tier from HubSpot** — Stripe is authoritative.
3. **Never overwrite visitor role from HubSpot** — visitors must be explicitly converted.
4. **Placeholder emails are rejected** — `isPlaceholderEmail` check prevents syncing test/internal emails.
5. **Idempotency keys prevent duplicate queue jobs** — same operation for the same entity is deduplicated.
6. **Unrecoverable errors (401, 403, MISSING_SCOPES) go straight to dead** — no retry, staff notified immediately.
7. **Queue uses FOR UPDATE SKIP LOCKED** — safe for concurrent workers, no double-processing.
8. **Stripe fields only pushed in live Stripe environment** — sandbox Stripe data never reaches HubSpot.
9. **Sync exclusions list** — permanently deleted members are excluded from the inbound sync.

## Key Files

| File | Purpose |
|------|---------|
| `server/core/hubspot/queue.ts` | Queue engine: enqueue, process, retry, stats |
| `server/core/hubspot/queueHelpers.ts` | Typed helpers to enqueue specific operations |
| `server/core/hubspot/request.ts` | Rate-limit-aware request wrapper (p-retry) |
| `server/core/hubspot/members.ts` | Contact CRUD, deal creation, tier sync, cancellation |
| `server/core/hubspot/contacts.ts` | SMS preference sync, day-pass contact creation |
| `server/core/hubspot/companies.ts` | Company find-or-create and contact association |
| `server/core/hubspot/products.ts` | Product mapping lookups from DB |
| `server/core/hubspot/lineItems.ts` | Line item CRUD on deals |
| `server/core/hubspot/stages.ts` | Deal stage updates, contact status writes, property provisioning |
| `server/core/hubspot/constants.ts` | Pipeline IDs, stage IDs, status/tier/billing mappings |
| `server/core/hubspot/pipeline.ts` | Pipeline validation and stage existence checks |
| `server/core/hubspot/formSync.ts` | Form submission ingestion from HubSpot |
| `server/core/memberSync.ts` | Full inbound member sync from HubSpot |
| `server/core/hubspotQueueMonitor.ts` | Queue stats for admin dashboard |
| `server/core/stripe/hubspotSync.ts` | Payment and day-pass line item sync |
| `server/schedulers/hubspotQueueScheduler.ts` | Queue processor (every 2 min) |
| `server/schedulers/memberSyncScheduler.ts` | Daily member sync (3 AM Pacific) |
| `server/schedulers/hubspotFormSyncScheduler.ts` | Form sync (every 30 min) |
| `server/routes/hubspot.ts` | API routes, contact cache, webhook validation |

## Reference Files

- [Queue Processing](references/queue-processing.md) — retry strategy, backoff, dead letter handling, monitoring
- [Sync Operations](references/sync-operations.md) — field mappings, contact/company/product sync, form pipeline, deal management
