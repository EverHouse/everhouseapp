# Queue Processing

## Queue Table

The `hubspot_sync_queue` table stores all outbound HubSpot operations. Each row contains:

- `operation` — one of: `create_contact`, `update_contact`, `create_deal`, `sync_member`, `sync_tier`, `sync_company`, `sync_day_pass`, `sync_payment`
- `payload` — JSON blob with operation-specific parameters
- `priority` — 1–10 (lower = higher priority, default 5)
- `status` — `pending`, `processing`, `completed`, `failed`, `dead`
- `retry_count` / `max_retries` — tracks retry progress (default max: 5)
- `idempotency_key` — prevents duplicate pending/processing jobs for the same logical operation
- `last_error` — stores the error message from the most recent failure
- `next_retry_at` — timestamp for when a failed job becomes eligible for retry
- `completed_at` — timestamp when the job finished successfully

## How `processHubSpotQueue` Works

The processor runs every 2 minutes via `server/schedulers/hubspotQueueScheduler.ts`.

### Step 1: Recover Stuck Jobs

Call `recoverStuckProcessingJobs()` which resets any job that has been in `processing` status for more than 10 minutes. These jobs are assumed to be from a crashed server instance. They get `status = 'failed'`, incremented `retry_count`, and `next_retry_at = NOW() + 5 minutes`.

### Step 2: Atomically Claim Jobs

```sql
UPDATE hubspot_sync_queue
SET status = 'processing', updated_at = NOW()
WHERE id IN (
  SELECT id FROM hubspot_sync_queue
  WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= NOW()))
  ORDER BY priority ASC, created_at ASC
  LIMIT 20
  FOR UPDATE SKIP LOCKED
)
RETURNING id, operation, payload, retry_count, max_retries
```

Key aspects:
- `FOR UPDATE SKIP LOCKED` prevents race conditions if multiple workers run concurrently — each worker only claims unlocked rows.
- Jobs are ordered by priority (ascending, so priority 1 runs before priority 5) then by creation time (FIFO within same priority).
- Batch size is 20 jobs per cycle.
- Failed jobs are only re-claimed when `next_retry_at <= NOW()`, implementing the backoff delay.

### Step 3: Execute Each Job

For each claimed job, call `executeHubSpotOperation(operation, payload)` which dynamically imports the appropriate handler module to avoid circular dependencies:

- `create_contact` → `members.findOrCreateHubSpotContact`
- `update_contact` → `stages.updateContactMembershipStatus`
- `sync_tier` → `members.syncTierToHubSpot`
- `sync_company` → `companies.syncCompanyToHubSpot`
- `sync_payment` → `stripe/hubspotSync.syncPaymentToHubSpot`
- `sync_day_pass` → `stripe/hubspotSync.syncDayPassToHubSpot`
- `create_deal` / `sync_member` — currently disabled (log and skip)

### Step 4: Handle Results

**On success:** Mark job as `completed` with `completed_at = NOW()`.

**On failure:** Classify the error:

1. **Unrecoverable errors** (401, 403, MISSING_SCOPES): Mark as `dead` immediately. Notify all staff via `notifyAllStaff` with an `integration_error` alert. No retries.
2. **Recoverable errors** (rate limits, network issues, 5xx): Increment `retry_count`. If under `max_retries`, schedule retry with exponential backoff. Otherwise, mark as `dead` and notify staff.

## Retry Strategy: Exponential Backoff

The `getNextRetryTime` function calculates the delay:

```
delay = min(baseDelay × 2^retryCount, maxDelay)
```

- Base delay: 1 minute (60,000 ms)
- Max delay: 1 hour (3,600,000 ms)
- Default max retries: 5

| Retry # | Delay    |
|---------|----------|
| 1       | 2 min    |
| 2       | 4 min    |
| 3       | 8 min    |
| 4       | 16 min   |
| 5       | 32 min   |

After exhausting all retries, the job moves to `dead` status and staff receive a notification with the job ID, operation type, retry count, and last error message.

## Dead Letter Handling

Jobs reach `dead` status in two ways:

1. **Unrecoverable error on first attempt** — 401/403/MISSING_SCOPES errors skip all retries.
2. **Max retries exhausted** — after 5 failed attempts with backoff.

Dead jobs remain in the table for auditing. Staff are notified via `notifyAllStaff` with:
- Job ID and operation type
- Last error message
- Guidance that manual intervention may be required
- For scope errors: a link to the HubSpot scopes configuration page

## HubSpot API Rate Limit Handling

In addition to the queue-level retry, each individual HubSpot API call is wrapped in `retryableHubSpotRequest` (from `server/core/hubspot/request.ts`) which uses the `p-retry` library:

- Retries: 5
- Min timeout: 1 second
- Max timeout: 30 seconds
- Factor: 2 (exponential)
- Only rate limit errors (429, RATELIMIT_EXCEEDED) trigger retries
- All other errors abort immediately via `AbortError`

This means a single queue job can internally retry HubSpot API calls up to 5 times for rate limits before the job itself is considered failed.

## Queue Monitoring

### Stats Endpoint

`getQueueStats()` in `server/core/hubspot/queue.ts` returns counts of pending, processing, failed, dead, and completed-in-last-24-hours jobs.

### Dashboard Monitor

`getHubSpotQueueMonitorData()` in `server/core/hubspotQueueMonitor.ts` provides:

- Aggregate counts by status (pending, failed, processing, completed in 24h)
- List of up to 20 most recent failed jobs with error details, retry count, and next retry time
- Average processing time (in ms) for completed jobs in the last 24 hours
- Queue lag — how long the oldest pending item has been waiting

### Scheduler Tracking

The queue scheduler records each run to `schedulerTracker` for the admin monitoring dashboard, including success/failure status and error messages.

## Startup Behavior

On application startup, the queue scheduler:

1. Waits 15 seconds, then ensures required HubSpot properties exist (e.g., `billing_provider` enumeration).
2. Waits 30 seconds, then runs the first queue processing cycle.
3. After that, processes every 2 minutes via `setInterval`.

## Idempotency

Each queue helper generates a deterministic idempotency key:

- Payment sync: `payment_sync_<paymentIntentId>`
- Day pass sync: `day_pass_sync_<paymentIntentId>`
- Member creation: `member_creation_<email>`
- Tier sync: `tier_sync_<email>_<oldTier>_to_<newTier>` (spaces replaced with underscores)

Before inserting, `enqueueHubSpotSync` checks for existing pending/processing jobs with the same key and returns the existing job ID if found.
