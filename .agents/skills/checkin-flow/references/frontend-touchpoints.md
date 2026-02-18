# Frontend Check-In Touchpoints

## Staff Command Center Entry Points

The `StaffCommandCenter` component (`src/components/staff-command-center/StaffCommandCenter.tsx`) provides two check-in entry points:

### 1. Booking Check-In Button

Each booking card in the Command Center has a check-in action. When staff clicks it:

1. `handleCheckIn(booking)` fires.
2. Calls `checkInWithToast(bookingId)` from `useBookingActions`.
3. The hook sends `PUT /api/bookings/:id/checkin` with `{ status: 'attended' }`.
4. If the server returns HTTP 402 (`OUTSTANDING_BALANCE`), the result indicates `requiresPayment: true`.
5. The Command Center opens the `CheckinBillingModal` for fee settlement.
6. If the server returns HTTP 400 with `requiresSync`, the hook retries with `skipPaymentCheck: true`.
7. On success, query caches invalidate and the booking card updates.

### 2. QR Scanner Button

Staff taps the QR scan button to open `QrScannerModal`:

1. The modal initializes `Html5Qrcode` with the device's rear camera (`facingMode: 'environment'`).
2. On successful scan, `onScanSuccess(decodedText)` extracts the member ID.
3. The Command Center sends `POST /api/staff/qr-checkin { memberId }`.
4. On success, `CheckInConfirmationModal` displays:
   - Member name, tier badge, lifetime visit count.
   - Pinned staff notes (alerts about the member).
   - Membership status warnings.
5. On duplicate (HTTP 409), show "already checked in" toast.
6. Play sound effects: success sound for check-in, warning sound for errors.

## Unified Booking Sheet in Check-In Mode

The `UnifiedBookingSheet` (`src/components/staff-command-center/modals/UnifiedBookingSheet.tsx`) supports a `checkinMode` prop:

### Props Relevant to Check-In

```typescript
checkinMode?: boolean;           // Activate check-in mode
onCheckinComplete?: () => void;  // Callback after successful check-in
onCheckIn?: (bookingId: number) => void;  // Trigger check-in action
onCollectPayment?: (bookingId: number) => void;  // Open billing modal
onOpenBillingModal?: (bookingId: number) => void;  // Alternative billing trigger
```

### Check-In Mode Behavior

When `checkinMode = true` and `mode = 'manage'`:

1. The sheet loads in manage mode with roster data via `fetchRosterData`.
2. The save button label changes to **"Complete Check-In"** with a `how_to_reg` icon.
3. The save button spinner text changes to **"Checking In..."**.
4. `handleManageModeSave` calls the check-in flow instead of the regular save flow.

### Manage Mode Roster

The `ManageModeRoster` component displays:
- Owner with tier badge and membership status.
- Member participants with tier badges.
- Guest participants with fee amounts.
- Player count validation (`filledCount / totalCount`).
- Options to add/remove members, add guests, reassign owner.

## CheckinBillingModal

The `CheckinBillingModal` (`src/components/staff-command-center/modals/CheckinBillingModal.tsx`) is the primary billing interface during check-in.

### Lifecycle

1. **Open**: Triggered when check-in returns HTTP 402 or staff opens billing manually.
2. **Loading**: Fetches `GET /api/bookings/:id/staff-checkin-context`.
3. **Display**: Shows participant fee cards with payment actions.
4. **Action**: Staff performs payment actions via `PATCH /api/bookings/:id/payments`.
5. **Close**: After all fees settled, calls `onCheckinComplete` to finalize.

### State Management

```typescript
context: CheckinContext | null     // Full billing context from API
loading: boolean                    // Initial fetch in progress
error: string | null               // Error message display
actionInProgress: string | null    // Currently executing action ID
waiverReason: string               // Text input for waiver justification
showWaiverInput: number | 'all'    // Which participant's waiver input is visible
savedCardInfo: { hasSavedCard, cardLast4, cardBrand }  // Card on file status
paymentMethod: 'online' | 'terminal'  // Selected payment method
```

### Payment Actions

Each participant card shows contextual actions:

| Fee Status | Available Actions |
|------------|-------------------|
| Pending, fee > 0 | Confirm (cash), Waive (with reason), Use Guest Pass (guests only), Charge Saved Card |
| Pending, fee = 0 | Auto-confirmed (no action needed) |
| Paid | ✓ Paid badge |
| Waived | ✓ Waived badge (with review flag if unreviewed) |
| Prepaid online | ✓ Prepaid badge |

Bulk actions:
- **Confirm All**: Mark all pending participants as paid, create fee snapshot.
- **Waive All**: Mark all pending as waived, require reason, send bulk waiver email.

### Optimistic Updates

Payment actions use optimistic UI updates:
1. Immediately update local `context` state with the expected new status.
2. Send the API request.
3. On success, re-fetch context to confirm.
4. On failure, revert to the previous context state and show error toast.

### Saved Card Flow

1. On modal open, call `GET /api/stripe/staff/check-saved-card/:email`.
2. If `hasSavedCard = true`, show "Charge Card on File" button with last 4 digits.
3. On click, call `chargeCardWithToast` from `useBookingActions`:
   - Charges the member's saved card for all pending participant fees.
   - On success, re-fetch context and complete check-in.
   - On `noSavedCard`, update UI to remove the card option.

### Stripe Terminal Flow

1. Staff selects "Terminal" payment method tab.
2. `TerminalPayment` component handles the WisePOS E interaction.
3. On successful terminal charge, participants are marked as paid.

### Overage Payment

If the booking has unpaid overage (`hasUnpaidOverage = true`):
1. Display an overage section with the amount and "Collect Overage" button.
2. On click, create or retrieve a payment intent for the overage amount.
3. Show Stripe payment form or terminal for the overage specifically.
4. Overage intent cleanup runs on modal close/unmount.

## QrScannerModal

The `QrScannerModal` (`src/components/staff-command-center/modals/QrScannerModal.tsx`):

### Camera States

| State | UI |
|-------|-----|
| `idle` | Not yet started |
| `pending` | Requesting camera permission |
| `granted` | Scanner active, viewfinder visible |
| `denied` | Error message ("Error accessing camera") |

### Scan Flow

1. Open modal → wait 100ms → initialize `Html5Qrcode`.
2. Request camera list via `Html5Qrcode.getCameras()`.
3. Start scanning with environment-facing camera at 10fps.
4. On first successful decode, set `hasScannedRef` to prevent duplicates.
5. Call `onScanSuccess(decodedText)` → stop scanner → close modal.
6. Cleanup: stop scanner on modal close or component unmount.

## useBookingActions Hook

The `useBookingActions` hook (`src/hooks/useBookingActions.ts`) provides:

### checkInBooking(bookingId, options)

```typescript
interface CheckInOptions {
  status?: 'attended' | 'no_show' | 'cancelled';
  source?: string;
  skipPaymentCheck?: boolean;
}

interface CheckInResult {
  success: boolean;
  requiresPayment?: boolean;   // HTTP 402 - open billing modal
  requiresRoster?: boolean;    // Roster needs completion first
  requiresSync?: boolean;      // Retry with skipPaymentCheck
  error?: string;
}
```

Flow:
1. Send `PUT /api/bookings/:id/checkin`.
2. HTTP 402 → return `{ requiresPayment: true }`.
3. HTTP 400 with `requiresSync` → auto-retry with `skipPaymentCheck: true`.
4. Success → invalidate booking query caches.

### chargeCardOnFile(options)

```typescript
interface ChargeCardOptions {
  memberEmail: string;
  bookingId: number;
  sessionId: number;
  participantIds?: number[];
}
```

Charges the member's saved Stripe card for specified participants.

## UI States During Check-In

### Loading State
- Spinner with "Loading billing context..." while fetching checkin context.
- Skeleton cards for participant fee display.

### Verifying State
- Action buttons show spinner with action-specific text (e.g., "Confirming...").
- `actionInProgress` state disables other buttons to prevent concurrent actions.

### Error State
- Red error banner with retry button.
- Per-action error toasts for individual payment failures.

### Confirmed State
- Green checkmark badges on settled participants.
- "All Paid" summary when `totalOutstanding = 0`.
- Auto-close or manual close after completion.

### Warning States
- Membership status badge (expired, cancelled, past_due) on owner.
- Waiver review flags on guest participants.
- Pinned notes displayed in QR check-in confirmation.
