---
name: notification-system
description: "3-channel notification delivery system — in-app database, WebSocket real-time, and web push. Covers notifyMember, notifyAllStaff, push subscription lifecycle, daily reminders, morning closure notifications, broadcast events, frontend notification store, and notification sound hooks. Use when sending notifications, adding push support, debugging delivery failures, or modifying notification types."
---

# Notification System

## Overview

Deliver notifications through 3 channels in sequence: **database** (always) → **WebSocket** (real-time) → **push** (web push). An optional **email** channel exists but defaults to off.

Every notification starts as a database row, then fans out to real-time channels. Use `notifyMember()` as the single entry point for member notifications and `notifyAllStaff()` for staff-wide broadcasts.

## Key Files

| File | Purpose |
|---|---|
| `server/core/notificationService.ts` | Main entry: `notifyMember()`, `notifyAllStaff()`, convenience helpers, delivery orchestration |
| `server/core/websocket.ts` | WebSocket server, connection management, broadcast functions |
| `server/core/staffNotifications.ts` | Legacy staff notification helpers (DB-only, no WS/push) |
| `server/routes/notifications.ts` | REST API for notification CRUD |
| `server/routes/push.ts` | Push subscription endpoints, VAPID config, daily reminders, morning closures |
| `server/routes/bays/notifications.ts` | Recent activity feed (`GET /api/recent-activity`) |
| `src/stores/notificationStore.ts` | Zustand store for frontend notification state |
| `src/contexts/NotificationContext.tsx` | React context exposing `openNotifications()` |
| `src/services/pushNotifications.ts` | Frontend push subscription lifecycle |
| `src/hooks/useNotificationSounds.ts` | Sound playback on new notifications |

## notifyMember()

**File:** `server/core/notificationService.ts`

Main entry point for sending a notification to a single member. Accept a `NotificationPayload` and an options object.

```ts
notifyMember(payload: NotificationPayload, options?: {
  sendPush?: boolean;       // default: true
  sendWebSocket?: boolean;  // default: true
  sendEmail?: boolean;      // default: false
  emailSubject?: string;
  emailHtml?: string;
})
```

Execution order:
1. Validate required fields (`userEmail`, `title`, `message`, `type`).
2. **Deduplication check (v8.5.0):** Before inserting, query `notifications` for an existing row with the same `title`, `user_email`, and `related_id` created within the last 60 seconds. If a duplicate is found, skip the insert and return early. This prevents multiple code paths (e.g., check-in handlers) from sending the same notification to a member.
3. Insert to `notifications` table (database channel — always runs first).
4. If `sendWebSocket` is true, call `sendNotificationToUser()` from `websocket.ts`.
5. If `sendPush` is true, call `deliverViaPush()` which looks up `push_subscriptions` by email.
6. If `sendEmail` is true AND `emailSubject` + `emailHtml` are provided, call `deliverViaEmail()` via Resend.

Return a `NotificationResult` with `notificationId`, `deliveryResults[]`, and `allSucceeded`.

## notifyAllStaff()

**File:** `server/core/notificationService.ts`

Send a notification to every active staff member.

```ts
notifyAllStaff(title, message, type, options?: {
  relatedId?: number;
  relatedType?: string;
  sendPush?: boolean;      // default: true
  sendWebSocket?: boolean; // default: true
  url?: string;
})
```

Steps:
1. Query all active staff from `staff_users` where `is_active = true`.
2. Batch-insert notification rows for every staff email.
3. If `sendWebSocket`, call `broadcastToStaff()` from `websocket.ts`.
4. If `sendPush`, call `deliverPushToStaff()` which joins `push_subscriptions` with `users` on role `admin`/`staff`.

## NotificationType

80+ string literal types organized by domain:

| Category | Types |
|---|---|
| General | `info`, `success`, `warning`, `error`, `system` |
| Booking | `booking`, `booking_approved`, `booking_declined`, `booking_reminder`, `booking_cancelled`, `booking_cancelled_by_staff`, `booking_cancelled_via_trackman`, `booking_invite`, `booking_update`, `booking_updated`, `booking_confirmed`, `booking_auto_confirmed`, `booking_checked_in`, `booking_created`, `booking_participant_added`, `booking_request` |
| Closure | `closure`, `closure_today`, `closure_created` |
| Wellness | `wellness_booking`, `wellness_enrollment`, `wellness_cancellation`, `wellness_reminder`, `wellness_class`, `wellness` |
| Events | `event`, `event_rsvp`, `event_rsvp_cancelled`, `event_reminder` |
| Tours | `tour`, `tour_scheduled`, `tour_reminder` |
| Payments | `payment_method_update`, `payment_success`, `payment_failed`, `payment_receipt`, `payment_error`, `outstanding_balance`, `fee_waived` |
| Membership | `membership_renewed`, `membership_failed`, `membership_past_due`, `membership_cancelled`, `membership_terminated`, `membership_cancellation` |
| Billing | `billing_alert`, `billing_migration` |
| Passes | `guest_pass`, `day_pass` |
| Trackman | `trackman_booking`, `trackman_unmatched`, `trackman_cancelled_link` |
| Terminal | `terminal_refund`, `terminal_dispute`, `terminal_dispute_closed`, `terminal_payment_canceled` |
| Staff/Admin | `announcement`, `new_member`, `member_status_change`, `card_expiring`, `staff_note`, `account_deletion`, `funds_added`, `trial_expired`, `waiver_review`, `cancellation_pending`, `cancellation_stuck`, `bug_report`, `import_failure`, `integration_error`, `attendance` |

Add new types to the `NotificationType` union in `notificationService.ts`.

## Convenience Functions

| Function | Wraps |
|---|---|
| `notifyPaymentSuccess(email, amount, description, opts?)` | `notifyMember()` with type `payment_success`, optional email channel |
| `notifyPaymentFailed(email, amount, reason, opts?)` | `notifyMember()` with type `payment_failed`, optional email channel |
| `notifyFeeWaived(email, amount, reason, bookingId?)` | `notifyMember()` with type `fee_waived` |
| `notifyOutstandingBalance(email, amount, description, opts?)` | `notifyMember()` with type `outstanding_balance`, optional email channel |

All format the dollar amount as `$X.XX` and set appropriate `relatedType`/`relatedId`.

## WebSocket Layer

**File:** `server/core/websocket.ts`

- Initialize with `initWebSocketServer(server)` on path `/ws`.
- Session-based authentication: parse `connect.sid` cookie using `cookie-signature.unsign()` for cryptographic verification → look up session in DB → extract user email and role.
- Fallback: unauthenticated clients can send an `auth` message with optional `sessionId` field (for mobile/React Native clients that cannot attach cookies); max 3 attempts within 10s timeout. When `sessionId` is provided in the auth message, it is verified directly against the session store instead of re-reading cookies from the upgrade request.
- Connection map: `Map<email, ClientConnection[]>` — supports multiple connections per user.
- Staff tracking: `Set<string>` of staff emails for targeted broadcasts. On `ws.on('close')`, if remaining connections exist for a user, check `filtered.some(c => c.isStaff)` — if no remaining connection is a staff session, the user is removed from `staffEmails`. This prevents false-positive staff presence after a staff tab closes but a member tab remains open.
- Session revalidation: every 5 minutes, all connections are re-verified against the database. Expired or revoked sessions are terminated automatically. Uses a dedicated connection pool (`max: 20`) to handle reconnection storms during deploys.
- Heartbeat: every 30s, ping all connections. Terminate unresponsive ones. The heartbeat handler revalidates sessions when the 5-minute interval has elapsed (tracked via `lastSessionCheck` per connection), using the same `debounceKey` pattern that includes the action type to prevent cross-action debounce collisions.
- Origin validation: allow Replit domains, localhost, production domains, and `ALLOWED_ORIGINS` env var.
- Frontend reconnection: member WebSocket hook (`useWebSocket.ts`) uses randomized jitter (2-5s delay) for reconnection to prevent thundering herd. Staff WebSocket hook (`useStaffWebSocket.ts`) uses exponential backoff with `Math.pow(2, attempt)` scaling up to 30s max delay.

### Broadcast Functions

| Function | Target | Message type |
|---|---|---|
| `sendNotificationToUser(email, notification)` | Single user | `notification` |
| `broadcastToStaff(notification)` | Staff connections only | `notification` |
| `broadcastToAllMembers(notification)` | All connected users | `notification` |
| `broadcastBookingEvent(event)` | Staff only | `booking_event` |
| `broadcastAnnouncementUpdate(action, announcement?)` | All users | `announcement_update` |
| `broadcastAvailabilityUpdate(data)` | All users | `availability_update` |
| `broadcastWaitlistUpdate(data)` | All users | `waitlist_update` |
| `broadcastDirectoryUpdate(action)` | Staff only | `directory_update` |
| `broadcastMemberStatsUpdated(email, data)` | Member + staff | `member_stats_updated` |
| `broadcastClosureUpdate(action, closureId?)` | All users | `closure_update` |
| `broadcastBillingUpdate(data)` | Member + staff | `billing_update` |
| `broadcastTierUpdate(data)` | Member + staff | `tier_update` |
| `broadcastMemberDataUpdated(emails)` | Staff only | `member_data_updated` |
| `broadcastDayPassUpdate(data)` | Staff only | `day_pass_update` |
| `broadcastCafeMenuUpdate(action)` | All users | `cafe_menu_update` |
| `broadcastDataIntegrityUpdate(action, details?)` | Staff only | `data_integrity_update` |

See `references/websocket-architecture.md` for full details.

## Push Notification Layer

**File:** `server/routes/push.ts`

- Configure VAPID keys from `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` env vars.
- Call `webpush.setVapidDetails('mailto:hello@everclub.app', publicKey, privateKey)` at module load.
- Store subscriptions in `push_subscriptions` table (columns: `user_email`, `endpoint`, `p256dh`, `auth`).
- On HTTP 410 response from push endpoint, delete the stale subscription.

### Key Functions

| Function | Purpose |
|---|---|
| `sendPushNotification(email, payload)` | Send push to one user's subscriptions |
| `sendPushNotificationToStaff(payload)` | Send push to all staff (join with `users` on role) |
| `sendPushNotificationToAllMembers(payload)` | Send push + in-app to all members |
| `isPushNotificationsEnabled()` | Check if VAPID keys are configured |

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/push/vapid-public-key` | None | Return VAPID public key |
| `POST` | `/api/push/subscribe` | Authenticated | Save push subscription |
| `POST` | `/api/push/unsubscribe` | Authenticated | Remove push subscription |
| `POST` | `/api/push/test` | Authenticated | Send test push to current user |
| `POST` | `/api/push/send-daily-reminders` | Staff/Admin | Trigger daily reminders manually |
| `POST` | `/api/push/send-morning-closure-notifications` | Staff/Admin | Trigger morning closure alerts manually |

See `references/delivery-channels.md` for channel-level details.

## Scheduled Notifications

### sendDailyReminders()

**Defined in:** `server/routes/push.ts`  
**Triggered by:** `server/schedulers/dailyReminderScheduler.ts`  
**Time:** 6 PM Pacific

Query tomorrow's confirmed events, approved bookings, and confirmed wellness enrollments. For each:
1. Batch-insert in-app notification rows.
2. Send push notification per user.
3. Send WebSocket notification per user via `sendNotificationToUser()`.

### sendMorningClosureNotifications()

**Defined in:** `server/routes/push.ts`  
**Triggered by:** `server/schedulers/morningClosureScheduler.ts`  
**Time:** 8 AM Pacific

Find facility closures starting today that are published (`needsReview = false`) and active. Idempotent: check for existing `closure_today` notifications with matching `relatedId` before sending. For each new closure:
1. Create in-app notifications for all members.
2. Send push notifications to all member subscriptions.

## Frontend Architecture

### NotificationContext (`src/contexts/NotificationContext.tsx`)

Expose `openNotifications(tab?)` to open the notification panel from anywhere.

### notificationStore (`src/stores/notificationStore.ts`)

Zustand store managing:
- `notifications[]`, `unreadCount`, `isLoading`, `lastFetched`
- `fetchNotifications(email)` — GET `/api/notifications`
- `fetchUnreadCount(email)` — GET `/api/notifications?unread_only=true`
- `addNotification(n)` — prepend and increment unread
- `markAsRead(id)` / `markAllAsRead()` — update local state
- `setNotifications(list)` — bulk set with auto-computed unread count

### pushNotifications service (`src/services/pushNotifications.ts`)

- `subscribeToPush(email)` — request permission, register service worker, fetch VAPID key, subscribe via Push API, POST to `/api/push/subscribe`.
- `unsubscribeFromPush()` — unsubscribe via Push API, POST to `/api/push/unsubscribe`.
- `isSubscribedToPush()` — check current subscription status.
- `registerServiceWorker()` — register `/sw.js`.

### useNotificationSounds (`src/hooks/useNotificationSounds.ts`)

Play contextual sounds on new notifications. Maintain a `seenIds` set; on first load, seed the set silently. On subsequent calls, detect new unread notifications and play the mapped sound.

Sound maps:
- **Staff:** booking/event_rsvp/wellness_enrollment → `newBookingRequest`; cancellations → `bookingCancelled`.
- **Member:** approvals/confirmations → `bookingApproved`; declined → `bookingDeclined`; cancelled → `bookingCancelled`.
- Fallback: `notification` sound for unmapped types.

## Notification API Endpoints

**File:** `server/routes/notifications.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/notifications` | Authenticated | Fetch notifications (optional `user_email`, `unread_only` params). Limit 50. Staff can query other users. |
| `GET` | `/api/notifications/count` | Authenticated | Get unread count |
| `PUT` | `/api/notifications/:id/read` | Authenticated | Mark single notification as read |
| `PUT` | `/api/notifications/mark-all-read` | Authenticated | Mark all notifications as read |
| `DELETE` | `/api/notifications/dismiss-all` | Authenticated | Delete all notifications for user |
| `DELETE` | `/api/notifications/:id` | Authenticated | Delete single notification |

## Recent Activity Feed

**File:** `server/routes/bays/notifications.ts`

`GET /api/recent-activity` — staff-only endpoint with 24-hour lookback. Aggregate:
- Notification records for the requesting user.
- Booking activity (created, approved, attended, cancelled).
- Walk-in check-ins.

Return sorted by timestamp, limited to 20 items.

## Rules

1. Always use `notifyMember()` from `notificationService.ts` — never insert directly into the `notifications` table for member notifications.
2. Email channel requires both `emailSubject` and `emailHtml` in options; otherwise the email step is silently skipped.
3. Push notifications require `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` environment variables. If not set, push delivery returns `{ success: false, error: 'VAPID keys not configured' }`.
4. Add new notification types to the `NotificationType` union in `notificationService.ts`.
5. Use `notifyAllStaff()` from `notificationService.ts` (not `staffNotifications.ts`) for full 3-channel delivery. The `staffNotifications.ts` version only does DB inserts.
6. Handle `relatedId` defensively — it must be a valid number or null. Never pass strings or undefined.
7. WebSocket broadcasts are fire-and-forget. If no connections exist for the target, the notification still persists in the database.
8. WebSocket `parseSessionId()` must use `cookie-signature.unsign()` for cryptographic verification — never raw string extraction (e.g., `s:` prefix stripping without signature check). Invalid signatures must be rejected.
9. WebSocket debounce keys must include the action type (e.g., `ws_revalidate_${email}` vs `ws_notify_${email}`) to prevent cross-action debounce collisions.
10. On `ws.close`, always check `filtered.some(c => c.isStaff)` on remaining connections — do not assume remaining connections inherit staff status from the closed connection.
11. The session revalidation pool must use `max: 20` (not 5) to handle reconnection storms during deploys without exhausting connections.
