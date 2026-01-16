# Ever House Mobile App - API Documentation & Setup Guide

## Overview
This document provides everything needed to create a native iOS mobile app for Ever House members, connecting to the existing backend API while keeping the brand design intact.

---

## Backend API

**Base URL:** `https://8f86e24a-c4d1-4638-b2f2-be7ccdf90b51-00-ako6beffjd5y.worf.replit.dev`

> Note: This is the development URL. When deploying, use the production URL.

---

## API Endpoints

### Authentication
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/request-otp` | POST | Request email OTP code |
| `/api/auth/verify-otp` | POST | Verify OTP and login |
| `/api/auth/session` | GET | Get current user session |
| `/api/auth/logout` | POST | Log out |

### Bookings (Golf Simulators)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resources` | GET | Get available bays/simulators |
| `/api/availability` | GET | Get available time slots |
| `/api/availability/batch` | POST | Batch check availability |
| `/api/bookings` | GET | Get member's bookings |
| `/api/bookings` | POST | Request a new booking |
| `/api/bookings/:id/member-cancel` | PUT | Cancel own booking |
| `/api/bookings/:id/participants` | GET | Get booking roster |
| `/api/bookings/:id/participants` | POST | Add member to roster |
| `/api/bookings/:id/invite/accept` | POST | Accept booking invite |
| `/api/bookings/:id/invite/decline` | POST | Decline booking invite |

### Events & RSVPs
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | Get upcoming events |
| `/api/rsvps` | GET | Get member's RSVPs |
| `/api/rsvps` | POST | RSVP to an event |
| `/api/rsvps/:event_id/:email` | DELETE | Cancel RSVP |

### Wellness Classes
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wellness-classes` | GET | Get available classes |
| `/api/wellness-enrollments` | GET | Get member's enrollments |
| `/api/wellness-enrollments` | POST | Enroll in a class |
| `/api/wellness-enrollments/:id/:email` | DELETE | Cancel enrollment |

### Member Profile
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/members/:email/details` | GET | Get member profile |
| `/api/members/me/preferences` | GET | Get notification preferences |
| `/api/members/me/preferences` | PATCH | Update preferences |
| `/api/guest-passes/:email` | GET | Get guest pass balance |
| `/api/waivers/status` | GET | Check waiver status |
| `/api/waivers/sign` | POST | Sign waiver |

### Notifications & Announcements
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notifications` | GET | Get notifications |
| `/api/notifications/:id/read` | PUT | Mark as read |
| `/api/announcements` | GET | Get announcements |
| `/api/announcements/banner` | GET | Get active banner |
| `/api/closures` | GET | Get club closures |

### Payments
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/member/balance` | GET | Get outstanding balance |
| `/api/member/balance/pay` | POST | Create payment intent for balance |
| `/api/member/balance/confirm` | POST | Confirm balance payment |
| `/api/member/invoices/:invoiceId/pay` | POST | Pay specific invoice |
| `/api/member/invoices/:invoiceId/confirm` | POST | Confirm invoice payment |

---

## Priority Features for Mobile

### Phase 1: Core Experience (Launch)
1. **Login** - Email OTP authentication
2. **Dashboard** - Upcoming bookings, events, balance alerts
3. **Book Golf** - Date picker, time slots, bay selection
4. **My Bookings** - View, manage roster, cancel
5. **Profile** - View tier, guest passes, notification settings

### Phase 2: Engagement (Post-launch)
6. **Events** - Browse events, RSVP, add to calendar
7. **Wellness** - View/enroll in classes
8. **History** - Past bookings, payments, RSVPs
9. **Push Notifications** - Booking confirmations, reminders

### Phase 3: Enhanced (Future)
10. **Guest Check-in** - Pre-register guests for visits
11. **Payment** - Pay outstanding balances
12. **Waiver Signing** - Digital waiver for minors

---

## Design System: Ever House Brand + Native Mobile

### Brand Identity
- **Name:** Ever House
- **Logo:** EH monogram
- **Style:** Liquid Glass (iOS-inspired glassmorphism)

### Color Palette
| Color | Hex | Usage |
|-------|-----|-------|
| Deep Green | `#1B4332` | Primary brand, headers, CTAs |
| Lavender | `#9F7AEA` | Accents, highlights, tier badges |
| Bone | `#F5F5DC` | Light backgrounds, cards |
| Background Dark | `#0A0A0A` | Dark mode background |
| Background Light | `#FAFAFA` | Light mode background |

### Typography
| Type | Font | Usage |
|------|------|-------|
| Headlines | Playfair Display | Page titles, welcome banners |
| Body/UI | Inter | All other text, buttons, labels |

### Native Mobile Optimization

**Buttons:**
- Use native iOS button styles with Ever House colors
- Primary buttons: Deep Green (#1B4332) background with white text
- Secondary buttons: Transparent with Deep Green border
- Add subtle haptic feedback on tap
- Standard 44pt minimum touch target

**Navigation:**
- Bottom tab bar with 5 tabs: Home, Book, Events, Wellness, Profile
- Use SF Symbols for tab icons (they're native to iOS)
- Deep Green tint for active tab, gray for inactive

**Lists & Cards:**
- Use native iOS list styles with glassmorphism overlays
- Card backgrounds: semi-transparent with blur (matches Liquid Glass aesthetic)
- Standard iOS swipe-to-delete for cancellable items

**Forms & Inputs:**
- Native iOS text fields with Ever House color accents
- Deep Green cursor and selection color
- Standard iOS keyboard behaviors

**Modals & Sheets:**
- Use native iOS sheet presentation (drag to dismiss)
- Glassmorphism background blur
- Standard corner radius (16pt for sheets)

**Animations:**
- Follow iOS spring animations for natural feel
- Subtle parallax on scroll
- Staggered list item animations

### Theme Support
- Light, Dark, and System modes
- Glassmorphism effects adapt to theme:
  - Light mode: white/bone glass with subtle shadows
  - Dark mode: dark glass with glow effects

---

## Mobile App Creation Prompt

Use this prompt when creating the new mobile app project in Replit:

---

**Build a native iOS mobile app for Ever House, a private members golf and wellness club. The app connects to our existing backend API.**

**Core Features:**

1. **Login:** Email-based OTP authentication (user enters email, receives code, verifies to login). Session persisted.

2. **Dashboard:** 
   - Welcome banner with member name and tier badge (use Playfair Display for "Welcome back, [Name]")
   - Upcoming bookings with date, time, bay name
   - RSVP'd events
   - Outstanding balance alert with "Pay Now" action
   - Quick action buttons: Book Golf, Events, Wellness

3. **Book Golf Simulator:**
   - Horizontal date picker (today + 7 days)
   - Time slot grid showing available 60-minute slots
   - Request booking flow with notes field
   - Show tier-based booking limits

4. **My Bookings:**
   - List of upcoming/pending bookings
   - Booking detail with roster management (add members/guests)
   - Cancel booking with confirmation
   - Accept/decline booking invitations from other members

5. **Events:**
   - Filterable event list by category
   - Event cards with date, time, location
   - RSVP button with confirmation
   - Add to calendar option

6. **Wellness:**
   - Two tabs: Classes and MedSpa
   - Class cards with instructor, time, spots remaining
   - Enroll/unenroll functionality
   - External MedSpa booking link

7. **Profile:**
   - Member info with tier badge and tags
   - Guest pass balance display
   - Push notification toggle
   - Email/SMS preferences
   - Privacy settings with waiver signing

**Design System:**

Brand colors:
- Primary/CTA: Deep Green #1B4332
- Accent: Lavender #9F7AEA  
- Light surface: Bone #F5F5DC
- Dark background: #0A0A0A

Typography:
- Headlines: Playfair Display (elegant serif for "Welcome back", page titles)
- Body/UI: Inter (clean sans-serif for everything else)

Native optimization:
- Use native iOS buttons with Deep Green color, not custom styled buttons
- Standard iOS navigation patterns (bottom tabs, back buttons)
- Native iOS form inputs with Deep Green accents
- SF Symbols for icons
- Haptic feedback on interactions
- iOS sheet presentations for modals
- Pull-to-refresh on all list screens

Glassmorphism ("Liquid Glass"):
- Semi-transparent card backgrounds with blur effect
- Works in both light and dark modes
- Subtle shadows in light mode, glow effects in dark mode

**Technical:**
- Backend API URL: `https://8f86e24a-c4d1-4638-b2f2-be7ccdf90b51-00-ako6beffjd5y.worf.replit.dev`
- All times are in Pacific timezone (America/Los_Angeles)
- Handle offline gracefully with cached data
- Push notifications via Expo Push
- Support light/dark/system themes

---

## Notes

- The web app remains the primary interface for staff/admin functions
- The mobile app is member-facing only
- Both apps share the same backend database and authentication system
- Session tokens work across both platforms
