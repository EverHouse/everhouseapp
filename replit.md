# Ever Club Members App

## Overview
The Ever Club Members App is a private members club application designed for golf and wellness centers. Its core function is to streamline golf simulator bookings, wellness service appointments, and club event management. The application aims to enhance member engagement, optimize operational workflows, and deliver a unified digital experience. The long-term objective is to establish this application as a central digital hub for private members clubs, providing extensive tools for membership management, facility booking, and community building to improve member satisfaction and operational efficiency.

## User Preferences
- **Skill-Driven Development**: We have an extensive library of custom skills installed. Before answering questions, debugging, or modifying any system, you MUST identify and load the relevant skill (e.g., booking-flow, stripe-webhook-flow, fee-calculation, react-dev). Rely on your skills as the single source of truth for architectural rules.
- **Communication Style**: The founder is non-technical. Always explain changes in plain English, focusing on the business/member impact. Avoid unnecessary technical jargon.
- **Development Approach**: Prefer iterative development. Ask before making major architectural changes. Write functional, clean code (utilize your clean-code skill).

## System Architecture

### Core Architecture & Data Flow
- **Camel-to-Snake Boundary Map**: `snake_case` for PostgreSQL tables/columns, `camelCase` for Drizzle schemas, API JSON payloads, and React/TypeScript frontend. Raw DB rows must not be leaked in API responses.
- **TypeScript Mismatches**: Fix underlying schema or DTOs; avoid `as any`.
- **SQL Security**: Use Drizzle ORM query builders or parameterized `sql` template literals; raw string-interpolated SQL is forbidden.

### UI/UX & Interaction Standards
- **Design System**: Liquid Glass UI system.
- **Sheet/Modal Design**: Consists of a Header (title and close "X"), a scrollable Body for data entry, and a Sticky Footer for primary/secondary actions.
- **Button Hierarchy**: Primary actions (e.g., "Collect", "Check In"), secondary actions (Reschedule, Cancel as ghost links), and destructive actions (e.g., "Void All Payments"). Buttons in scrollable bodies must have `type="button"`.
- **Fee Recalculation**: Roster changes trigger server-side fee recalculation with subtle visual feedback (loading states) on the Financial Summary.

### System Non-Negotiables
- **Timezone**: All date/time operations must use Pacific Time (`America/Los_Angeles`).
- **Audit Logging**: All staff actions must be logged using `logFromRequest()`.
- **API/Frontend Consistency**: API response field names must exactly match frontend TypeScript interfaces.

### UI/UX & Frontend
- **Design & Styling**: Liquid Glass UI, Tailwind CSS v4, dark mode.
- **Interactions & Motion**: Spring-physics, drag-to-dismiss.
- **React & Framework**: React 19, Vite, state management (Zustand/TanStack).

### Core Domain
- **Booking & Scheduling**: "Request & Hold" model, unified participants, calendar sync, auto no-show scheduler.
- **Fees & Billing**: Unified fee service, dynamic pricing, prepayment, guest fees, "one invoice per booking" architecture.
- **Database & Data Integrity**: PostgreSQL, Supabase Realtime, Drizzle ORM with CASCADE constraints on `wellness_enrollments.class_id` and `booking_participants.session_id`.
- **Member Lifecycle & Check-In**: Membership tiers, QR/NFC check-in, onboarding.

### Enforced Code Conventions
- **Error Handling**: Empty catch blocks are banned; every `catch` must re-throw, log via `logger.debug`/`logger.warn`, or use `safeDbOperation()`.
- **Timezone**: All `toLocaleDateString()` calls must include `timeZone: 'America/Los_Angeles'`.
- **Authentication**: All mutating API routes (POST/PUT/PATCH/DELETE) must have authentication protection.
- **Stripe Webhook Safety**: Webhook handlers modifying member status must include a `billing_provider` guard to prevent overwrites from other systems.
- **Booking Race Condition Guards**: `approveBooking()`, `declineBooking()`, and `checkinBooking()` implement status guards and optimistic locking to prevent race conditions and ensure data integrity.

## Recent Changes
- **2026-02-23**: Fixed `logger.debug` missing method in `server/core/logger.ts` (was causing 230+ runtime errors across 28 files)
- **2026-02-23**: Fixed day pass purchase insert failures — `stripe_customer_id` column made nullable to support guest checkouts without a Stripe customer. Unsafe `as string` casts replaced with safe extraction in `webhooks.ts` and `dayPasses.ts`.
- **2026-02-23**: Fixed audit log insert failures for system actions — all `logSystemAction()` calls in `webhooks.ts` were using wrong field names (`entityType`/`entityId` instead of `resourceType`/`resourceId`), causing NOT NULL constraint violations on `resource_type`.
- **2026-02-23**: Full app audit — fixed ~20 unsafe Stripe type casts across webhooks/routes, created reusable `getCustomerId()`/`getPaymentIntentId()` helpers in `server/types/stripe-helpers.ts`. Fixed unauthenticated tour confirm endpoint. Fixed job queue Date serialization (ISO strings + `::timestamptz`). Fixed HubSpot FormSync 401 error spam. Fixed `broadcastBillingUpdate` wrong call signature. Fixed `InvoiceResult` missing `customerId` (invoice notifications weren't sending). Production booking expiry will self-fix on next deploy (constraint already correct in code).
- **2026-02-23**: Second-pass verification fixes — Fixed booking auto-complete scheduler crash (`bp.updated_at` → `bs.updated_at`, column only exists on booking_sessions). Added `'billing'` to notification type CHECK constraint and NotificationType union (was blocking all billing notifications in production). Fixed audit log `checkout_session_expired` using invalid `resourceType: 'checkout_session'` → `'checkout'`.
- **2026-02-23**: Added `'refunded'` to `participant_payment_status` PostgreSQL enum — cancellation was failing because `bookingStateService.cancelBooking()` sets `paymentStatus: 'refunded'` on paid participants, but the enum only had `pending/paid/waived`. This blocked cancellation of all bookings with paid participants.
- **2026-02-23**: Fixed Stripe Email Mismatch notification spam — merged users retained `stripe_customer_id` causing webhook handlers to match archived users and fire false alerts. Fixed `userMerge.ts` to clear all external IDs (Stripe, HubSpot) when archiving secondary users, added merged-user guard in `handleCustomerUpdated`, and added startup cleanup for existing affected users.
- **2026-02-23**: Fixed discount_code tracking across all 9 coupon flows — removed duplicate GET /api/stripe/coupons route (was causing empty coupon dropdown), added discount_code persistence to: staff discount endpoint (memberBilling.ts), subscription.created webhook, subscription.updated webhook, and family group billing (groupBilling.ts). Both webhook handlers now check item-level discounts (e.g., FAMILY20 coupon) when subscription-level discounts are empty, preventing incorrect NULL overwrites.
- **2026-02-23**: Performance optimization — reduced initial JS bundle from 545KB to 327KB (40% reduction). Lazy-loaded html5-qrcode (327KB) via dynamic import in QrScannerModal and RedeemPassCard. Split changelog.ts (7,437 lines) into lazy-loaded module. Added 16 database indexes across 8 high-traffic tables. Removed duplicate LOWER(email) index.

## External Dependencies
- **Stripe**: For terminal payments, subscriptions, and webhooks (billing authority).
- **HubSpot**: For two-way data synchronization and form submissions.
- **Communications**: In-app notifications, push notifications, and email via Resend.
- **Other**: Trackman (Booking CSV/webhooks), Eventbrite, Google Sheets, OpenAI Vision (ID scanning).