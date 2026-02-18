# Sync Operations

## Contact Sync (App → HubSpot)

### Find or Create Contact

`findOrCreateHubSpotContact` in `server/core/hubspot/members.ts`:

1. Reject placeholder emails via `isPlaceholderEmail` check.
2. Search HubSpot contacts by email (lowercased) using `searchApi.doSearch`.
3. If found, return the existing contact ID.
4. If not found, create a new contact with these properties:
   - `email` (lowercased)
   - `firstname`, `lastname`, `phone`
   - `membership_status` = `Active`
   - `lifecyclestage` = `customer`
   - `membership_tier` (denormalized via `denormalizeTierForHubSpot`)
5. Handle 409 Conflict by extracting the existing ID from the error body.

### SMS Preference Sync

`syncSmsPreferencesToHubSpot` in `server/core/hubspot/contacts.ts`:

1. Search for contact by email.
2. Map app fields to HubSpot SMS consent properties:
   - `smsPromoOptIn` → `hs_sms_promotional`
   - `smsTransactionalOptIn` → `hs_sms_customer_updates`
   - `smsRemindersOptIn` → `hs_sms_reminders`
3. Update the contact with only non-null preferences.

### Day Pass Purchase Sync (Non-Member Contacts)

`syncDayPassPurchaseToHubSpot` in `server/core/hubspot/contacts.ts`:

1. Search for existing contact by email.
2. If not found, create a new contact with `lifecyclestage = 'lead'` and `hs_lead_status = 'NEW'`.
3. Handle 409 duplicate by re-querying.
4. Add a note to the contact with purchase details (product name, amount, date).

### Tier Sync to HubSpot

`syncTierToHubSpot` in `server/core/hubspot/members.ts` (dispatched via queue operation `sync_tier`):

1. Denormalize the tier slug to a HubSpot dropdown label.
2. Look up the user's `hubspot_id` from the local DB.
3. Update the HubSpot contact with:
   - `membership_tier` — the denormalized tier label
   - `lifecyclestage` — `customer` if active, `other` if not
   - `billing_provider` — mapped from local billing_provider field
4. Also update the `membership_tier` property on the member's primary deal if one exists.

### Full Member Sync to HubSpot

`syncMemberToHubSpot` in `server/core/hubspot/stages.ts`:

1. Search for the contact by email; create if missing (when `createIfMissing = true`).
2. Build a properties object from the input fields:
   - `membership_status` → mapped via `DB_STATUS_TO_HUBSPOT_STATUS` (skipped for Mindbody-billed members)
   - `billing_provider` → mapped via `DB_BILLING_PROVIDER_TO_HUBSPOT`
   - `membership_tier` → denormalized
   - `membership_start_date` → midnight UTC timestamp
   - Stripe fields (`stripe_customer_id`, `stripe_delinquent`, etc.) → only pushed in live Stripe environments
   - `membership_billing_type` → group billing role
3. Attempt to update all properties; if some properties don't exist in HubSpot, retry with only valid ones.

## Company Sync

`syncCompanyToHubSpot` in `server/core/hubspot/companies.ts` (dispatched via queue operation `sync_company`):

1. Extract domain from user email if not provided.
2. Search HubSpot companies by name or domain.
3. If not found, create company with `name` and `domain` properties.
4. Handle 409 duplicates by extracting existing company ID.
5. Search for the user's contact by email.
6. Associate contact with company using HubSpot v4 associations API (association type ID 280 = company-to-contact).

## Product and Line Item Sync

### Product Mapping

`getProductMapping` in `server/core/hubspot/products.ts`:

- Look up `hubspot_product_mappings` table by `tierName` or `productType`.
- Returns the HubSpot product ID, product name, and unit price.
- Products are categorized by type: `membership`, `pass`, `fee`, `day_pass`.

### Add Line Item to Deal

`addLineItemToDeal` in `server/core/hubspot/lineItems.ts`:

1. Look up the product mapping to get unit price.
2. Calculate discounted price: `unitPrice × (1 - discountPercent / 100)`.
3. Create a HubSpot line item with:
   - `hs_product_id` — the HubSpot product ID
   - `quantity` — typically 1
   - `price` — the discounted unit price
   - `name` — product name
   - `hs_discount_percentage` and `discount_reason` (if discount applies)
4. Associate the line item with the deal (association type ID 20 = line-item-to-deal).
5. Record the line item locally in `hubspot_line_items` table.
6. Create a billing audit log entry.

### Remove Line Item from Deal

`removeLineItemFromDeal` in `server/core/hubspot/lineItems.ts`:

1. Look up local line item record.
2. Archive the line item in HubSpot via `lineItems.basicApi.archive`.
3. Delete the local record from `hubspot_line_items`.
4. Create an audit log entry.

### Stripe Payment Sync

`syncPaymentToHubSpot` in `server/core/stripe/hubspotSync.ts` (dispatched via queue operation `sync_payment`):

1. Find the member's deal by email in `hubspot_deals`.
2. Look up a product mapping by type (`pass` for guest fees, `fee` for other fees).
3. Create a line item with the payment amount and associate it with the deal.
4. Record in `hubspot_line_items` and `billing_audit_log`.

### Day Pass Line Item Sync

`syncDayPassToHubSpot` in `server/core/stripe/hubspotSync.ts` (dispatched via queue operation `sync_day_pass`):

1. Find existing deal for the email; skip if no deal exists (non-member purchases are not synced as line items).
2. Look up product mapping for `day_pass` type.
3. Create line item and associate with deal.
4. Record locally.

## Deal Pipeline Management

### Pipeline Stages

Defined in `server/core/hubspot/constants.ts`, the membership pipeline stages are:

- **Day Pass / Tour Request** (2414796536) — initial lead
- **Tour Booked** (2413968103) — scheduled tour
- **Visited / Day Pass** (2414796537) — completed visit
- **Application Submitted** (2414797498) — applied
- **Billing Setup** (2825519819) — payment configuration
- **Closed Won (Active)** (closedwon) — active member
- **Payment Declined** (2825519820) — billing issues
- **Closed Lost** (closedlost) — terminated/cancelled

### Status-to-Stage Mapping (Mindbody)

`MINDBODY_TO_STAGE_MAP` maps Mindbody statuses to pipeline stages:

- `active` → Closed Won
- `pending`, `declined`, `suspended`, `expired`, `froze`, `frozen`, `past_due`, `pastdue`, `paymentfailed` → Payment Declined
- `terminated`, `cancelled`, `non-member`, `nonmember` → Closed Lost

### Deal Stage Sync

`syncDealStageFromMindbodyStatus` in `server/core/hubspot/stages.ts`:

1. Validate the membership pipeline exists in HubSpot (cached for 1 hour).
2. Map the Mindbody status to a target stage.
3. Find the member's primary deal locally; create one for legacy members if missing (currently disabled).
4. Skip if deal is already at the target stage.
5. Update deal stage in HubSpot and contact membership_status.
6. For churned members (terminated/cancelled): remove all line items from the deal and clear `membership_tier` on the contact.

### Tier Change Handling

`handleTierChange` in `server/core/hubspot/members.ts`:

1. Find the member's primary deal.
2. Look up old and new product mappings.
3. Remove the old tier's line item from HubSpot (preserving discount info).
4. Add the new tier's line item with the preserved discount.
5. Update `membership_tier` on both the deal and contact.
6. Create an audit log entry recording the change.

### Membership Cancellation

`handleMembershipCancellation` in `server/core/hubspot/members.ts`:

1. Find the member's deal.
2. Remove all line items from the deal.
3. Move the deal to Closed Lost stage.
4. Update the contact: set `membership_status = 'cancelled'` and clear `membership_tier`.
5. Create an audit log entry.

## Form Submission Sync (HubSpot → App)

`syncHubSpotFormSubmissions` in `server/core/hubspot/formSync.ts`, runs every 30 minutes:

### Configured Form Types

| Form Type       | Environment Variable              | Usage                     |
|-----------------|-----------------------------------|---------------------------|
| tour-request    | HUBSPOT_FORM_TOUR_REQUEST         | Tour scheduling requests  |
| membership      | HUBSPOT_FORM_MEMBERSHIP           | Membership inquiries      |
| private-hire    | HUBSPOT_FORM_PRIVATE_HIRE         | Private event inquiries   |
| event-inquiry   | HUBSPOT_FORM_EVENT_INQUIRY        | Event-related inquiries   |
| guest-checkin   | HUBSPOT_FORM_GUEST_CHECKIN        | Guest check-in forms      |
| contact         | HUBSPOT_FORM_CONTACT              | General contact forms     |

### Sync Pipeline

1. Get HubSpot access token from the integration.
2. For each unique form ID, fetch submissions from the last 30 days via `form-integrations/v1/submissions/forms/{formId}` (paginated, 50 per page).
3. Deduplicate each submission:
   - **Exact match:** Check if `hubspot_submission_id` (conversionId) already exists in `form_submissions`.
   - **Fuzzy match:** Check if a local submission exists with the same email, form type, and creation time within ±5 minutes. If found, backfill the `hubspot_submission_id` on the existing record.
4. For new submissions, extract:
   - Standard fields: `email`, `firstname`, `lastname`, `phone`, `message` (or `comments` / `inquiry_details`)
   - All other fields stored as JSON in `metadata`
   - `pageUrl` stored in metadata for type inference
5. Insert into `form_submissions` with status `new`.

### Form Type Inference

When multiple form types share the same HubSpot form ID, `inferFormTypeFromPageUrl` examines the submission's page URL to determine the correct type based on URL keywords (e.g., "private-hire", "event", "tour", "membership", "contact", "checkin").

## Member Sync from HubSpot (Inbound)

`syncAllMembersFromHubSpot` in `server/core/memberSync.ts`, runs daily at 3 AM Pacific:

### Properties Fetched

The sync reads 29+ properties from each HubSpot contact, including:
- Identity: `firstname`, `lastname`, `hs_calculated_full_name`, `email`, `phone`, `company`
- Membership: `membership_tier`, `membership_status`, `membership_discount_reason`, `membership_start_date`
- Integration: `mindbody_client_id`, `createdate`, `hs_merged_object_ids`
- Preferences: `eh_email_updates_opt_in`, `eh_sms_updates_opt_in`, `hs_sms_promotional`, `hs_sms_customer_updates`, `hs_sms_reminders`
- Content: `membership_notes`, `message`, `total_visit_count`
- Demographics: `address`, `city`, `state`, `zip`, `date_of_birth`
- Billing: `stripe_delinquent`

### Upsert Logic

For each contact:

1. Skip if email is in `sync_exclusions` table.
2. Resolve email aliases via `resolveUserByEmail` (handles linked emails).
3. Skip non-transacting non-members (no `mindbody_client_id` and status `non-member`) to avoid creating unnecessary user records.
4. Normalize tier: only write recognized tiers; unrecognized ones log a warning and preserve the existing DB value.
5. Upsert into `users` with email as conflict target:
   - **Protected fields (Stripe/visitor):** `membership_status`, `tier`, `tierId`, `role` are NOT overwritten.
   - **COALESCE fields:** `firstName`, `lastName`, `phone`, `streetAddress`, `city`, `state`, `zipCode`, `dateOfBirth` only overwrite if the new value is non-null.
   - **Opt-in fields:** Only overwrite if the HubSpot value is non-null.
   - Always set: `hubspotId`, `mindbodyClientId`, `lastSyncedAt`.

### Post-Sync Processing

1. **Status change detection:** Compare old and new `membership_status`; notify member and staff if status became problematic.
2. **HubSpot ID collision detection:** Find other users sharing the same `hubspot_id` and create `user_linked_emails` entries.
3. **Notes sync:** Hash combined `membership_notes` + `message` content; create new `member_notes` entries only when content changes.
4. **Merged contacts:** Batch-fetch emails from `hs_merged_object_ids` and store as linked emails.
5. **Deal stage sync:** Process contacts with deal-relevant statuses in throttled batches (5 concurrent, 2s between batches).

### Join Date Logic

`computeHubSpotJoinDate` in `server/routes/hubspot.ts` handles a batch-import cutoff:

- Contacts created on or before Nov 12, 2025 were batch-imported; use `membership_start_date` as the real join date.
- Contacts created after Nov 12, 2025 are real Mindbody syncs; use DB `join_date` if available, otherwise `createdate`.
- `joined_on` (manually set by staff) always takes highest priority.

## Deal Pipeline & Stages

### Pipeline Architecture

The membership pipeline in HubSpot contains 8 stages defined in `server/core/hubspot/constants.ts`:

| Stage                    | Stage ID        | Usage                                    |
|--------------------------|-----------------|------------------------------------------|
| Day Pass / Tour Request  | 2414796536      | Initial inquiry stage for prospects      |
| Tour Booked              | 2413968103      | Tour has been scheduled                  |
| Visited / Day Pass       | 2414796537      | Prospect completed a visit or day pass   |
| Application Submitted    | 2414797498      | Membership application submitted         |
| Billing Setup            | 2825519819      | Payment method being configured          |
| Closed Won (Active)      | closedwon       | Active member (terminal stage)           |
| Payment Declined         | 2825519820      | Payment processing failed                |
| Closed Lost              | closedlost      | Terminated/cancelled member (terminal)   |

### Pipeline Validation

`validateMembershipPipeline` in `server/core/hubspot/pipeline.ts`:

1. Checks if the Membership Pipeline exists in HubSpot (by ID or label match).
2. Fetches all stages in the pipeline and caches them for 1 hour.
3. Validates that all required stage IDs are present in HubSpot.
4. Returns detailed results: pipeline existence, valid stages, missing stages.
5. **Note:** Pipeline validation is cached to avoid repeated HubSpot API calls; cache is valid for 1 hour.

### Status-to-Stage Mapping

`MINDBODY_TO_STAGE_MAP` in `server/core/hubspot/constants.ts` maps Mindbody membership statuses to deal stages:

- `active` → Closed Won (active member)
- `pending`, `declined`, `suspended`, `expired`, `froze`, `frozen`, `past_due`, `pastdue`, `paymentfailed` → Payment Declined (billing issues)
- `terminated`, `cancelled`, `non-member`, `nonmember` → Closed Lost (churned)

This mapping drives automatic deal stage sync whenever a member's status changes.

### Deal Stage Updates

`updateDealStage` in `server/core/hubspot/stages.ts`:

1. Updates the `dealstage` property in HubSpot.
2. Records the stage change locally in `hubspot_deals` table.
3. Logs the previous and new stage in `billing_audit_log` with metadata.
4. Skips the update if the deal is already at the target stage.

### Deal Stage Sync from Status

`syncDealStageFromMindbodyStatus` in `server/core/hubspot/stages.ts`:

1. Validates the membership pipeline exists (uses cached validation).
2. Maps the Mindbody status to a target stage using `MINDBODY_TO_STAGE_MAP`.
3. Updates the deal to the target stage.
4. Updates the contact's `membership_status` property to match.
5. **For churned members** (terminated/cancelled): removes all line items from the deal and clears `membership_tier` on the contact.
6. Creates audit log entries recording status change triggers and categories (recovery, churned, payment issue).

### Contact Membership Status

`updateContactMembershipStatus` in `server/core/hubspot/stages.ts`:

1. Updates the `membership_status` property on a HubSpot contact.
2. Uses `MINDBODY_TO_CONTACT_STATUS_MAP` to map normalized Mindbody status to valid HubSpot contact status values (e.g., `active` → `Active`, `terminated` → `Terminated`).
3. Called when deal stage changes or during member sync operations.

## Discount Rules

### Discount Calculation (Max-Wins Rule)

`calculateTotalDiscount` in `server/core/hubspot/discounts.ts`:

1. Takes a list of member tags (e.g., `['referral', 'staff']`).
2. Queries the `discountRules` table for all active rules matching the member's tags.
3. **Max-wins approach:** Returns only the highest-percentage discount; discounts do **NOT** stack or accumulate.
   - Example: A member with both `referral` (10%) and `staff` (20%) gets 20%, not 30%.
4. Returns the final discount percent (capped at 100%) and the list of applied rule tags.

### Get Applicable Discounts

`getApplicableDiscounts` in `server/core/hubspot/discounts.ts`:

1. Queries all active discount rules for the given member tags.
2. Returns an array of matching rules with their tags and discount percentages.
3. Used by `calculateTotalDiscount` to determine the best-fit discount.

### Admin Discount Rule CRUD

`getAllDiscountRules`, `updateDiscountRule` in `server/core/hubspot/admin.ts`:

- **Read:** `getAllDiscountRules()` fetches all discount rules, sorted by discount percent.
- **Update:** `updateDiscountRule(discountTag, discountPercent, description)` updates an existing rule's percent and description, and sets `updatedAt` timestamp.
- Rules are stored in the `discountRules` table with fields: `discountTag`, `discountPercent`, `description`, `isActive`, `updatedAt`.

### Billing Audit Log

`getBillingAuditLog` in `server/core/hubspot/admin.ts`:

1. Queries the `billing_audit_log` table by member email.
2. Returns up to 50 recent entries (configurable limit) sorted by creation date (newest first).
3. Logs all discount applications, line item changes, deal stage changes, and other billing events.
4. Used by admin staff to audit member billing history.

## Constants and Mapping

### Key Constants from `server/core/hubspot/constants.ts`

#### DB_STATUS_TO_HUBSPOT_STATUS

Maps app member status values to valid HubSpot contact membership_status property values:

```
active → Active
trialing → trialing
past_due → past_due
inactive → Suspended
cancelled → Terminated
expired → Expired
terminated → Terminated
former_member → Terminated
pending → Pending
suspended → Suspended
frozen → Froze
non-member → Non-Member
deleted → Terminated
```

**Usage:** When syncing a member's status to HubSpot, the app normalizes the DB status using this map to ensure it matches HubSpot's expected enum values.

#### DB_BILLING_PROVIDER_TO_HUBSPOT

Maps app billing provider values to HubSpot billing_provider property values:

```
stripe → stripe
mindbody → mindbody
manual → manual
comped → Comped
none → None
family_addon → stripe
```

**Usage:** When updating a contact's billing provider in HubSpot, the app translates the local DB provider to the HubSpot equivalent.

#### DB_TIER_TO_HUBSPOT

Maps normalized tier slugs to HubSpot membership_tier dropdown labels:

```
core, core membership → Core Membership
core-founding, core_founding → Core Membership Founding Members
premium, premium membership → Premium Membership
premium-founding, premium_founding → Premium Membership Founding Members
social, social membership → Social Membership
social-founding, social_founding → Social Membership Founding Members
vip, vip membership → VIP Membership
corporate, corporate membership → Corporate Membership
group-lessons, group_lessons → Group Lessons Membership
```

**Usage:** When syncing a member's tier to HubSpot, the app denormalizes the tier slug into a human-readable dropdown label. The reverse mapping (reading from HubSpot) uses `normalizeTierName` in `server/utils/tierUtils.ts`.

### Other Key Constants

- **HUBSPOT_STAGE_IDS:** Enum-like object containing all deal stage IDs.
- **MINDBODY_TO_STAGE_MAP:** Maps Mindbody membership statuses to deal stages (detailed above).
- **MINDBODY_TO_CONTACT_STATUS_MAP:** Maps Mindbody statuses to HubSpot contact membership_status values.
- **ACTIVE_STATUSES:** `['active', 'trialing', 'past_due']` — statuses considered "in good standing".
- **CHURNED_STATUSES:** `['terminated', 'cancelled', 'non-member']` — statuses indicating member has left.
- **INACTIVE_STATUSES:** `['pending', 'declined', 'suspended', 'expired', 'froze', 'frozen']` — statuses with billing or account issues.
