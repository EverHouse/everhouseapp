---
name: notification-system
description: "3-channel notification delivery system — in-app database, WebSocket real-time, and web push. Covers notifyMember, notifyAllStaff, push subscription lifecycle, daily reminders, morning closure notifications, broadcast events, frontend notification store, and notification sound hooks. Use when sending notifications, adding push support, debugging delivery failures, or modifying notification types."
---

# Notification System

Deliver through 3 channels in sequence: **database** (always) → **WebSocket** (real-time) → **push** (web push). Optional **email** channel defaults to off.

## File Map

| Task | Primary File(s) | When to touch |
|---|---|---|
| Send member notification | `server/core/notificationService.ts` | `notifyMember()` — single entry point |
| Send staff-wide notification | `server/core/notificationService.ts` | `notifyAllStaff()` |
| WebSocket server/broadcasts | `server/core/websocket.ts` | Connection mgmt, broadcast functions |
| Legacy staff notifications | `server/core/staffNotifications.ts` | DB-only (no WS/push) |
| Notification CRUD API | `server/routes/notifications.ts` | REST endpoints |
| Push subscription endpoints | `server/routes/push.ts` | VAPID, subscribe, daily reminders |
| Recent activity feed | `server/routes/bays/notifications.ts` | `GET /api/recent-activity` |
| Frontend notification state | `src/stores/notificationStore.ts` | Zustand store |
| Notification panel context | `src/contexts/NotificationContext.tsx` | `openNotifications()` |
| Frontend push subscription | `src/services/pushNotifications.ts` | Subscribe/unsubscribe |
| Notification sounds | `src/hooks/useNotificationSounds.ts` | Sound playback on new notifs |

## Decision Trees

### Sending a notification — which function?

```
Who receives it?
├── Single member → notifyMember(payload, options?)
│   ├── Synthetic email? → Skipped automatically (v8.81.0)
│   ├── Duplicate within 60s? → Skipped (dedup check)
│   └── Channels: DB → WebSocket → Push → (optional Email)
├── All staff → notifyAllStaff(title, message, type, options?)
│   └── Uses INNER JOIN with users table (excludes deleted staff)
└── All members → sendPushNotificationToAllMembers(payload)
    └── Push + in-app to all members
```

### Adding a new notification type

```
1. Add to NotificationType union in notificationService.ts
2. Use notifyMember() or notifyAllStaff() — never insert into notifications table directly
3. Add sound mapping in useNotificationSounds.ts (staff and/or member map)
4. If scheduled → add to appropriate scheduler
```

## Push Notification Enrichment (v8.87.14)

All push notifications are enriched with semantic tags, deep links, and consistent icon/badge assets. This enables iOS notification grouping, sound on replacement (`renotify: true`), and proper deep linking on tap.

**PushPayload interface** (`notificationService.ts`):
```
{ title, body, icon, badge, url?, tag? }
```

**`buildPushTag(type, relatedId?)`** — Generates semantic tags for iOS grouping:
- `booking-{id}`, `wellness-{id}`, `event-{id}`, `announcement-{id}`, `payment-{id}`, `closure-{id}`, `tour-{id}`, `alert` (general)

**`buildDeepLink(type, url?)`** — Automatic URL derivation by notification type:
- Booking → `/dashboard/bookings`, Wellness → `/wellness`, Events → `/events`, Payments → `/dashboard/billing`, Guest passes → `/dashboard/guest-passes`, Tours → `/admin?tab=tours`

**Constants:** `PUSH_ICON = '/icon-192.png'`, `PUSH_BADGE = '/badge-72.png'`

**Service worker** (`public/sw.js`):
- Uses `/icon-192.png` for notification icon, `/badge-72.png` for badge (72x72 monochrome)
- Tag-based grouping with `renotify: true` for iOS vibrate/sound on replacement
- `requireInteraction: false` for auto-dismiss
- Click handler: prefers existing client at target URL → navigates any existing client → `openWindow()` fallback

**All push call sites updated** with `tag` and `url` parameters: booking events, approval/decline/cancel flows, wellness enrollment, event RSVP, guest passes, Trackman notifications, closures, roster linking, daily reminders.

## Apple Wallet Pass Notification Channel (v8.87.16)

In addition to PWA web push, Apple Wallet passes with `changeMessage` fields provide a 4th visible notification channel. When a pass is updated via APN silent push, iOS shows a lock-screen notification for any field whose value changed, using the field's `changeMessage` template (e.g., "Bay changed to Bay 3").

**Membership pass changeMessage fields:** `tier` (secondaryFields), `status` (auxiliaryFields), `guestPasses` (backFields), `tierName` (backFields).

**Booking pass changeMessage fields:** `eventDate`, `eventTime` (primaryFields), `bayName`, `duration` (secondaryFields), `playerCount`, `bookingStatus` (auxiliaryFields).

**PWA push dedupe (v8.87.16):** `shouldDedupeForWalletPass()` in `notificationService.ts` checks the correct pass serial before skipping PWA push:
- **Booking types** (`BOOKING_WALLET_TYPES`): checks `EVERBOOKING-{relatedId}` — only skips push if the *specific booking* has a registered wallet pass. Requires `relatedId` (booking ID) to be set.
- **Membership types** (`MEMBERSHIP_WALLET_TYPES`): checks `EVERCLUB-{userId}` — skips push if the member has a registered membership wallet pass.
In-app database and WebSocket notifications are always delivered regardless.

**Booking dedupe types:** `booking_approved`, `booking_update(d)`, `booking_confirmed`, `booking_auto_confirmed`, `booking_cancelled*`, `booking_checked_in`.
**Membership dedupe types:** `membership_renewed`, `membership_past_due`, `membership_cancelled`, `membership_terminated`, `membership_cancellation`, `member_status_change`, `membership_tier_change`, `guest_pass`.

**Notification type alignment (v8.87.16):** Tier changes now use `membership_tier_change` (was `system`). Membership status changes (pause, restore, suspend) now use `member_status_change` (was `system`). This enables proper dedupe matching and deep-link routing.

## WebSocket Notification Data Contract (v8.87.90)

`deliverViaWebSocket` sends: `{ type: 'notification', title, message, data: { eventType, notificationType, relatedId, relatedType } }`.

The frontend `useWebSocket` handler checks `data.eventType` to trigger `bookingEvents.emit()` for dashboard refresh. **Both `eventType` and `notificationType` must be present** — `eventType` for the frontend event check, `notificationType` for backwards compatibility.

## Hard Rules

1. **Always use `notifyMember()` from `notificationService.ts`.** NEVER insert directly into the `notifications` table.
2. **Use `notifyAllStaff()` not `staffNotifications.ts`.** Legacy version only does DB inserts — no WebSocket, no push.
3. **Email requires both `emailSubject` AND `emailHtml`.** Otherwise email step silently skips.
4. **Push requires VAPID env vars.** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. If not set, push returns error.
5. **`relatedId` must be number or null.** Never pass strings or undefined.
6. **WebSocket is fire-and-forget.** No connection = notification still persists in DB.
7. **WebSocket auth uses `cookie-signature.unsign()`.** NEVER raw string extraction. Invalid signatures must be rejected.
8. **WebSocket debounce keys must include action type.** E.g., `ws_revalidate_${email}` vs `ws_notify_${email}` — prevents cross-action collisions.
9. **On `ws.close`, check remaining connections for staff status.** `filtered.some(c => c.isStaff)` — don't assume remaining connections inherit staff.
10. **Session revalidation pool: `max: 20`** (not 5) to handle reconnection storms during deploys.
11. **Prevent duplicate WebSocket registrations.** Check `!existing.some(c => c.ws === ws)` before pushing to clients map.
12. **`staff_register` handler needs DB fallback.** Mobile clients authenticating via `{ type: 'auth', sessionId }` have empty `req`. Fall back to direct DB lookup of user role.
13. **Synthetic email guard (v8.81.0).** `isSyntheticEmail()` blocks notifications to `@trackman.local`, `@visitors.evenhouse.club`, `private-event@`, `classpass-*`.
14. **Deduplication (v8.5.0).** Same `title` + `user_email` + `related_id` within 60 seconds → skip.
15. **Staff deletion safety (v8.81.0).** All fan-out paths use INNER JOIN with `users` table. Deleted/archived staff with orphaned `staff_users` rows are excluded.
16. **Push payloads must include icon + badge (v8.87.14).** All `deliverViaPush` and `deliverPushToStaff` calls enrich payloads with `PUSH_ICON` and `PUSH_BADGE` defaults. Always include `tag` (via `buildPushTag`) and `url` (via `buildDeepLink`) for proper iOS grouping and deep linking.
17. **Wallet pass dedupe (v8.87.16).** When adding new notification types that correspond to wallet pass field changes, add them to `BOOKING_WALLET_TYPES` or `MEMBERSHIP_WALLET_TYPES` in `notificationService.ts` to prevent duplicate alerts for members with wallet passes.

## Anti-Patterns (NEVER)

1. NEVER insert directly into the `notifications` table for member notifications.
2. NEVER use `staffNotifications.ts` for new code — use `notifyAllStaff()`.
3. NEVER strip `s:` prefix from session cookies without cryptographic verification.
4. NEVER assume remaining WebSocket connections inherit staff status from a closed connection.

## Cross-References

- **Booking event notifications** → `booking-flow` skill
- **Check-in notifications** → `checkin-flow` skill
- **Scheduled reminders** → `scheduler-jobs` skill
- **Billing migration notifications** → `member-lifecycle` skill
- **Status change source attribution** → See below

## Detailed Reference

- **[references/delivery-channels.md](references/delivery-channels.md)** — Channel-level details: push subscription lifecycle, email delivery, VAPID config, daily reminders, morning closures.
- **[references/websocket-architecture.md](references/websocket-architecture.md)** — Connection management, heartbeat, reconnection, broadcast function table, session revalidation.

---

## notifyMember() Signature

```ts
notifyMember(payload: NotificationPayload, options?: {
  sendPush?: boolean;       // default: true
  sendWebSocket?: boolean;  // default: true
  sendEmail?: boolean;      // default: false
  emailSubject?: string;
  emailHtml?: string;
})
```

## notifyAllStaff() Signature

```ts
notifyAllStaff(title, message, type, options?: {
  relatedId?: number;
  relatedType?: string;
  sendPush?: boolean;      // default: true
  sendWebSocket?: boolean; // default: true
  url?: string;
})
```

## Convenience Functions

| Function | Wraps |
|---|---|
| `notifyPaymentSuccess(email, amount, description, opts?)` | `notifyMember()` with type `payment_success` |
| `notifyPaymentFailed(email, amount, reason, opts?)` | `notifyMember()` with type `payment_failed` |
| `notifyFeeWaived(email, amount, reason, bookingId?)` | `notifyMember()` with type `fee_waived` |
| `notifyOutstandingBalance(email, amount, description, opts?)` | `notifyMember()` with type `outstanding_balance` |

## WebSocket Broadcast Functions

| Function | Target | Message type |
|---|---|---|
| `sendNotificationToUser(email, notification)` | Single user | `notification` | **SYNCHRONOUS** — returns `NotificationDeliveryResult`, NOT a Promise. Do NOT chain `.catch()` — it will throw TypeError at runtime. Errors are handled internally (ws.send wrapped in try/catch). (v8.87.75) |
| `broadcastToStaff(notification)` | Staff only | `notification` |
| `broadcastToAllMembers(notification)` | All users | `notification` |
| `broadcastBookingEvent(event)` | Staff only | `booking_event` |
| `broadcastAvailabilityUpdate(data)` | All users | `availability_update` |
| `broadcastMemberStatsUpdated(email, data)` | Member + staff | `member_stats_updated` |
| `broadcastClosureUpdate(action, closureId?)` | All users | `closure_update` |
| `broadcastBillingUpdate(data)` | Member + staff | `billing_update` |
| `broadcastBookingRosterUpdate(data)` | Member + staff | `booking_roster_update` |
| `broadcastDataIntegrityUpdate(action, details?)` | Staff only | `data_integrity_update` |
| `broadcastAnnouncementUpdate(action, announcement?)` | All users | `announcement_update` |
| `broadcastWaitlistUpdate(data)` | All users | `waitlist_update` |
| `broadcastDirectoryUpdate(action)` | Staff only | `directory_update` |
| `broadcastTierUpdate(data)` | Member + staff | `tier_update` |
| `broadcastMemberDataUpdated(emails)` | Staff only | `member_data_updated` |
| `broadcastDayPassUpdate(data)` | Staff only | `day_pass_update` |
| `broadcastCafeMenuUpdate(action)` | All users | `cafe_menu_update` |

## NotificationType Categories

80+ types: `info`, `success`, `warning`, `error`, `system`, `booking_*` (16 types), `closure_*`, `wellness_*`, `event_*`, `tour_*`, `payment_*`, `membership_*`, `billing_*`, `guest_pass`, `day_pass`, `trackman_*`, `terminal_*`, `staff/admin types` (announcement, new_member, staff_note, bug_report, etc.).

Add new types to the `NotificationType` union in `notificationService.ts`.

## Anti-Patterns (NEVER)

1. NEVER chain `.catch()` on `sendNotificationToUser()` — it is SYNCHRONOUS (returns `NotificationDeliveryResult`, NOT a Promise). Chaining `.catch()` throws `TypeError: .catch is not a function` at runtime (v8.87.75).
2. NEVER `await` the result of `sendNotificationToUser()` — it is synchronous. `await` on a non-Promise works but misleads readers.
3. NEVER assume broadcast functions throw on failure — they catch errors internally and log them.

## Status Change Source Attribution

Notification messages include a source string showing HOW the change originated:

| Source | Attribution |
|---|---|
| HubSpot sync | `billing_provider`/`data_source` priority chain → "via MindBody", "via Stripe", "via App", "via HubSpot sync" |
| Stripe webhook | Implicit from event type: "paused (frozen)", "resumed", "reactivated" |
| Staff action | Audit-logged with staff email. Member sees action, not staff identity. |

## Scheduled Notifications

| Scheduler | Time | What |
|---|---|---|
| Daily Reminders | 6 PM Pacific | Tomorrow's events, bookings, wellness |
| Morning Closures | 8 AM Pacific | Today's facility closures (idempotent) |

## Notification API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/notifications` | Fetch (limit 50, optional filters) |
| `GET` | `/api/notifications/count` | Unread count |
| `PUT` | `/api/notifications/:id/read` | Mark read |
| `PUT` | `/api/notifications/mark-all-read` | Mark all read |
| `DELETE` | `/api/notifications/dismiss-all` | Delete all for user |
| `DELETE` | `/api/notifications/:id` | Delete single |
