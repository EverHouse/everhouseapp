---
name: hubspot-sync
description: HubSpot CRM synchronization system — queue-based sync of contacts, deals, memberships, products, line items, form submissions, and deal pipeline stages between the Ever Club Members App and HubSpot. Covers contact sync, queue processing, two-way safeguards, and form submission ingestion.
---

# HubSpot Synchronization System

**App DB is primary brain.** HubSpot provides profile fill-in data only. The app controls `membership_status`, `tier`, `role`, and `billing_provider`.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Queue engine | `server/core/hubspot/queue.ts` | Enqueue, process, retry, stats |
| Queue helpers | `server/core/hubspot/queueHelpers.ts` | Typed enqueue functions |
| Contact CRUD | `server/core/hubspot/members.ts` | Contact create/update, tier sync, cancel |
| SMS/day-pass contacts | `server/core/hubspot/contacts.ts` | SMS prefs, day-pass creation |
| Company sync | `server/core/hubspot/companies.ts` | Company find-or-create, associate |
| Deal stage management | `server/core/hubspot/stages.ts` | Status writes, property provisioning |
| Constants/mappings | `server/core/hubspot/constants.ts` | Tier slugs → HubSpot labels |
| Discount rules | `server/core/hubspot/discounts.ts` | Max-wins rule (not additive) |
| Admin discount CRUD | `server/core/hubspot/admin.ts` | Discount rules, billing audit |
| Request wrapper | `server/core/hubspot/request.ts` | Rate-limit-aware p-retry |
| Form submissions | `server/core/hubspot/formSync.ts` | Form ingestion from HubSpot; `resolveFormId()` (async) uses 4-tier fallback: env var → admin setting → auto-discovered → hardcoded |
| Full member sync | `server/core/memberSync.ts` | Daily inbound reconciliation |
| Payment line items | `server/core/hubspot/queueHelpers.ts` | Stripe → HubSpot line items (via queue) |
| Queue monitor | `server/core/hubspotQueueMonitor.ts` | Admin dashboard stats |
| Queue scheduler | `server/schedulers/hubspotQueueScheduler.ts` | Every 2 min |
| Member sync scheduler | `server/schedulers/memberSyncScheduler.ts` | Daily 3 AM Pacific |
| Form sync scheduler | `server/schedulers/hubspotFormSyncScheduler.ts` | Every 30 min |
| Routes + cache | `server/routes/hubspot.ts` | API, contact cache, webhooks |

## Decision Trees

### Data direction — which way does it flow?

```
App → HubSpot (write)
├── Status/tier/billing_provider → always pushed (app is authoritative)
├── Stripe fields → only in live Stripe environment
├── Payments/day passes → line items on member deal (via queue)
└── Company association → find-or-create + associate (via queue)

HubSpot → App (read)
├── Webhook (primary, real-time)
│   ├── Status/tier → STRIPE WINS guard, visitor protection
│   ├── Profile fields → COALESCE (fill-in only, never overwrite)
│   ├── Overwrite fields → membership_discount_reason
│   └── Opt-in preferences → always overwrite (HubSpot authoritative)
├── Daily sync (safety net, 3 AM Pacific)
│   ├── Same rules as webhook
│   └── MindBody exception: can update status for active MindBody members
└── Form submissions (every 30 min)
    └── Deduplicate by hubspot_submission_id + fuzzy ±5 min window
```

### MindBody member HubSpot status changes

```
MindBody-billed active member's HubSpot status changes to non-active
├── migration_status = 'pending'? → SKIP cascade (stay active during Stripe migration)
└── Not pending → Deactivation cascade:
    ├── tier → NULL (saved to last_tier)
    ├── billing_provider → 'stripe'
    └── Push changes back to HubSpot
```

## Hard Rules

1. **App DB is primary brain.** HubSpot CANNOT overwrite `membership_status`, `tier`, `role`, or `billing_provider` for Stripe-billed members.
2. **STRIPE WINS rule.** When `billing_provider = 'stripe'`, Stripe is authoritative. Skip HubSpot status/tier updates.
3. **Visitor protection.** `role = 'visitor'` never overwritten to `'member'` by sync.
4. **Profile fields use COALESCE.** HubSpot fills gaps, never overwrites existing app data.
5. **MindBody exception.** Only MindBody-billed active members allow HubSpot status updates. Non-active transition triggers deactivation cascade.
6. **Migration-pending skip.** `migration_status = 'pending'` blocks deactivation cascade.
7. **Idempotency keys prevent duplicate queue jobs.** Same operation for same entity is deduplicated.
8. **Unrecoverable errors go straight to dead.** 401, 403, `MISSING_SCOPES` — no retry, staff notified.
9. **Queue uses `FOR UPDATE SKIP LOCKED`.** Safe for concurrent workers.
10. **Stripe fields only pushed in live Stripe environment.** Sandbox data never reaches HubSpot.
11. **Sync exclusions table.** Permanently deleted members excluded from inbound sync.
12. **Placeholder emails rejected.** `isPlaceholderEmail` check prevents syncing test/internal emails.
13. **Tier denormalization required.** Use `DB_TIER_TO_HUBSPOT` map in `constants.ts` when pushing tiers.
14. **Never write membership_status to HubSpot for MindBody-billed members.** Prevents MindBody ↔ HubSpot loop.

## Anti-Patterns (NEVER)

1. NEVER overwrite status/tier from HubSpot for Stripe-billed members.
2. NEVER overwrite visitor role from HubSpot sync.
3. NEVER write membership_status to HubSpot for MindBody-billed members.
4. NEVER skip the sync exclusions check on inbound sync.
5. NEVER push Stripe fields (customer ID, subscription ID) in sandbox environments.

## Cross-References

- **Member lifecycle/status rules** → `member-lifecycle` skill
- **Stripe webhook triggers** → `stripe-webhook-flow` skill
- **Queue scheduler** → `scheduler-jobs` skill
- **Data integrity (HubSpot checks)** → `data-integrity-monitoring` skill

## Detailed Reference

- **[references/queue-processing.md](references/queue-processing.md)** — Retry strategy, backoff, dead letter, monitoring, operation priorities.
- **[references/sync-operations.md](references/sync-operations.md)** — Field mappings, contact/company/product sync, form pipeline, deal management.

---

## Queue Operations

| Operation | Priority | Description |
|---|---|---|
| `sync_tier` | 2 | Push tier change to contact + deal |
| `sync_payment` | 3 | Stripe payment → line item on deal |
| `sync_day_pass` | 3 | Day-pass → line item on deal |
| `create_contact` | 5 | Find or create contact by email |
| `update_contact` | 5 | Update contact membership status |
| `sync_company` | 5 | Find-or-create company, associate contact |
| `sync_member` | 3 | Full member sync (currently disabled) |
| `create_deal` | 5 | Create membership deal (currently disabled) |

Queue scheduler: every 2 min, claim up to 50 jobs, exponential backoff on failure.

## Contact Properties Written (App → HubSpot)

| App Field | HubSpot Property | Notes |
|---|---|---|
| email | email | Always lowercased |
| tier | membership_tier | `denormalizeTierForHubSpot` mapping |
| membership_status | membership_status | Always pushed |
| billing_provider | billing_provider | Custom enum |
| lifecycle | lifecyclestage | `customer` (active) / `other` (inactive) |
| join date | membership_start_date | UTC midnight timestamp |

## Contact Properties Read (HubSpot → App)

| HubSpot Property | Local Field | Rule |
|---|---|---|
| firstname/lastname | first_name/last_name | COALESCE |
| membership_tier | tier | Normalize via `normalizeTierName` |
| membership_status | membership_status | Lowercased, protection rules apply |
| mindbody_client_id | mindbody_client_id | COALESCE |
| eh_email_updates_opt_in | email_opt_in | Boolean, always overwrites |
| eh_sms_updates_opt_in | sms_opt_in | Boolean, always overwrites |
| address/city/state/zip | street_address/city/state/zip_code | COALESCE |

## Deal Pipeline Stages

| Stage | ID | Usage |
|---|---|---|
| Day Pass / Tour Request | 2414796536 | Initial inquiry |
| Tour Booked | 2413968103 | Tour scheduled |
| Visited / Day Pass | 2414796537 | Visited the club |
| Application Submitted | 2414797498 | Applied |
| Billing Setup | 2825519819 | Payment config |
| Closed Won (Active) | closedwon | Active member |
| Payment Declined | 2825519820 | Payment issues |
| Closed Lost | closedlost | Terminated/cancelled |

Deal creation is currently disabled. Pipeline infrastructure and stage sync remain active for existing deals.

## Contact Cache

In-memory cache at `/api/hubspot/contacts`, full refresh every 30 min. Webhook-driven invalidation resets timestamp to 0. Contacts enriched with: lifetime visits, computed join date, former-member classification.

## Directory Sync Push

The admin directory sync (`server/routes/directorySync.ts`) pushes active-access members to HubSpot using `pushMembersDirectly()` — a direct function call (not HTTP) that processes members in batches of `PUSH_BATCH_SIZE = 5` concurrent calls. Filters: `membership_status IN ('active', 'trialing', 'past_due')`. Placeholder emails are skipped. After push, `invalidateHubSpotContactsCache()` clears the contacts cache. Push errors are tracked per-member and surfaced in the admin UI as `pushErrors` count. The standalone `/api/hubspot/push-members-to-hubspot` endpoint uses the same filter.
