# Even House Feature Roadmap

*Last updated: January 2026*
*For team presentation and planning*

---

## Current Features (What We Have)

### Member Experience
| Feature | Status | Notes |
|---------|--------|-------|
| Golf Simulator Booking | ✅ Complete | Request & Hold system with staff approval |
| Booking History | ✅ Complete | Full history in bottom nav (bookings, events, wellness) |
| Add to Calendar (Events) | ✅ Complete | Works for club events |
| Add to Calendar (Golf) | ❌ Missing | Code exists, needs UI button on booking confirmation |
| Real-time Notifications | ✅ Complete | In-app alerts + email |
| Member Dashboard | ✅ Complete | Upcoming bookings, events, usage stats |
| Digital Membership Card | ✅ Complete | On dashboard with tier, status, tags |
| Member Directory | ✅ Complete | Search and view other members |
| Profile Management | ✅ Complete | Personal info, preferences |
| Wellness Page | ✅ Complete | Links to spa/wellness booking |
| Events Page | ✅ Complete | Browse and RSVP to club events |
| Dark/Light Themes | ✅ Complete | User preference |
| PWA (Installable App) | ✅ Complete | Works like native app on phones |

### Staff/Admin Experience
| Feature | Status | Notes |
|---------|--------|-------|
| Staff Command Center | ✅ Complete | Today's schedule, pending requests, bay status |
| Quick Actions | ✅ Complete | Common tasks at a glance |
| Alerts/Notices | ✅ Complete | Items needing attention |
| Member Directory | ✅ Complete | Full profiles with history, notes, communication logs |
| Content Management | ✅ Complete | FAQs, Gallery, Events |
| Bug Reports | ✅ Complete | View member-reported issues |
| Inquiries | ✅ Complete | Contact form submissions |
| Training Guide | ✅ Complete | Built-in staff training documentation |
| Error Alerts | ✅ Complete | Email notifications for system issues |
| Automated Cleanup | ✅ Complete | Weekly maintenance of old data |

### Integrations
| Integration | Status | Purpose |
|-------------|--------|---------|
| Google Calendar | ✅ Complete | 4-way sync (Golf, Conference, Events, Wellness) |
| HubSpot CRM | ✅ Complete | Contact and lead management |
| Eventbrite | ✅ Complete | Automatic event import |
| MindBody | ✅ Complete | Conference room sync |
| Resend | ✅ Complete | Email notifications |
| Apple Messages | ✅ Complete | Direct messaging support |

---

## Planned Features - Member Experience

### Priority 1: You Want These

#### Add to Calendar for Golf Bookings
**What it does:** After a booking is confirmed, members tap a button to add it to their iPhone/Google calendar automatically.

**Current state:** The calendar file generator already exists and works for events. Just needs a button added to booking confirmations.

**Effort:** Small (1-2 hours)

---

#### Arrival Notifications (Geofencing)
**What it does:** When a member arrives at the club (within ~100 meters), staff automatically get a notification showing:
- Member name and photo
- Today's booking details
- Any VIP notes or preferences

**Considerations:**
- Members must opt-in to location sharing
- Uses more phone battery
- Privacy-sensitive - needs clear explanation to members
- Works best with newer phones

**Effort:** Medium (needs location API integration)

---

#### Kisi Door Access Integration
**What it does:** Members can unlock the club door directly from the Even House app instead of using the separate Kisi app.

**How it works:**
- Kisi has a public API we can integrate with
- Button in app says "Unlock Door"
- Could tie access to active membership status
- Could log entry/exit times automatically

**Considerations:**
- Needs Kisi API credentials
- Security review recommended
- Could replace physical key cards entirely

**Effort:** Medium

---

### Priority 2: Eventually

#### Mobile Food & Drink Ordering
**What it does:** Members order food and drinks to their simulator bay without leaving or calling staff.

**How it works:**
- Menu displayed in app
- Select items, add notes
- Staff/kitchen gets notification
- Order delivered to bay

**What's needed:**
- Menu management in admin portal
- Kitchen notification system
- Order tracking
- Payment integration (optional - could bill to account)

**Effort:** Large

---

#### Waitlist for Full Slots
**What it does:** When a preferred time is fully booked, members join a waitlist and get auto-notified if a spot opens.

**How it works:**
- "Join Waitlist" button appears on full slots
- If someone cancels, first person on waitlist gets notified
- They have X minutes to claim before it goes to next person

**Effort:** Medium

---

### Lower Priority - Nice to Have

| Feature | Description | Effort |
|---------|-------------|--------|
| Guest Pass Management | Digital guest pass requests and tracking | Medium |
| Group Booking | Book for multiple people at once | Medium |
| Member-to-Member Connection | Find playing partners with similar interests | Medium |
| In-App Payments | Pay dues, view statements, buy event tickets | Large |
| Feedback/Surveys | Collect member feedback after visits | Small |

---

## Planned Features - Staff Experience

### High Value for Boutique Club

#### Daily Briefing Screen
**What it does:** A "morning dashboard" that shows staff everything they need to know for the day.

**What it shows:**
- Who's coming today (with photos so staff recognize members)
- VIP notes for each visitor ("John always wants coffee ready")
- Birthdays and membership anniversaries this week
- Any special requests or notes from previous shift
- Weather (affects golf simulator demand)

**Why it matters:** Staff can greet members by name and anticipate needs before they ask.

**Effort:** Medium

---

#### Shift Handover Notes
**What it does:** Staff can leave notes for the next shift about anything important.

**Examples:**
- "Bay 2 trackman was acting up - IT coming tomorrow"
- "Sarah called, running 10 min late for her 3pm"
- "We're low on sparkling water"
- "New member James touring tomorrow at 2pm"

**How it works:**
- Simple note-taking area in staff portal
- Notes persist for 24-48 hours then archive
- Can tag notes as "Urgent" or "FYI"

**Why it matters:** Continuity between shifts without verbal handoffs that get forgotten.

**Effort:** Small

---

#### Member Preferences / VIP Notes
**What it does:** Quick-access preferences for each member that show up automatically when relevant.

**What's tracked:**
- Favorite drink
- Preferred bay
- Dietary restrictions
- Communication preferences
- Special occasions (birthday, anniversary)
- Any allergies or accessibility needs

**Where it shows:**
- Daily briefing
- When member checks in
- Member profile drawer
- Booking confirmation screen

**Why it matters:** Small personal touches that make members feel valued.

**Effort:** Medium

---

#### Manual Check-In Tracking
**What it does:** Staff can log when members arrive and leave, building visit history.

**How it works:**
- Quick "Check In" button when member arrives
- Optional "Check Out" when they leave
- Automatically tracks duration of visit
- Builds lifetime visit statistics

**Why it matters:** Know who's in the building, track visit patterns, simpler than geofencing.

**Effort:** Small

---

### Analytics & Reporting

#### Usage Dashboard
**What it shows:**
- Most popular booking times (heat map)
- Busiest days of week
- Which members book most often
- Bay utilization rates (% of time booked vs available)
- Month-over-month trends

**Why it matters:** Data-driven decisions about hours, staffing, pricing.

**Effort:** Medium

---

#### Member Engagement Tracking
**What it shows:**
- Members who haven't visited in 30+ days (at-risk)
- New members who haven't made first booking
- Event attendance patterns
- Booking frequency by tier

**Why it matters:** Proactive outreach to keep members engaged.

**Effort:** Medium

---

### Operations

#### Maintenance Log
**What it does:** Track equipment issues and repairs.

**How it works:**
- Log issues ("Bay 3 projector flickering")
- Assign to staff or external vendor
- Track status (Open, In Progress, Resolved)
- Attach photos if needed
- See maintenance history per bay

**Why it matters:** Nothing falls through the cracks, accountability for repairs.

**Effort:** Medium

---

#### Quick Message Templates
**What it does:** Pre-written messages for common situations that staff can send with one tap.

**Examples:**
- "Your booking is confirmed for [date] at [time]"
- "Unfortunately we need to reschedule your booking due to..."
- "We noticed you haven't visited in a while - we'd love to see you!"
- "Happy birthday! Enjoy a complimentary [drink] on your next visit"

**How it works:**
- Templates with placeholder fields
- Auto-fill member name, booking details
- Send via email (and eventually SMS)

**Effort:** Small

---

## Implementation Recommendations

### If Starting Tomorrow
1. **Add to Calendar for Golf** - Quick win, code exists
2. **Shift Handover Notes** - Simple, high daily value
3. **Member Preferences** - Makes personal service easier

### Next Quarter
4. **Daily Briefing Screen** - Combines several small features
5. **Manual Check-In Tracking** - Builds data for analytics
6. **Kisi Integration** - Depends on Kisi API access

### Future
7. **Arrival Notifications** - Wait for member feedback on privacy
8. **Mobile Ordering** - Larger project, needs kitchen workflow
9. **Usage Dashboard** - Build after check-in data exists

---

## Industry Comparison

### Where Even House Excels
- **4-way calendar sync** - Most clubs do 1-2 calendars
- **Built-in staff training** - Uncommon feature
- **Request & Hold booking** - Better control for boutique club
- **Real-time notifications** - Modern, responsive experience
- **PWA experience** - Works like native app

### Features Big Club Apps Have (That We May Not Need)
- GPS rangefinder/shot tracking (TrackMan handles this)
- Tournament management software
- Reciprocal club networks
- Complex billing/invoicing systems
- Video content libraries

---

## Notes

- Even House is a boutique club focused on personal relationships
- Not every feature from big country club apps makes sense here
- Prioritize features that enhance member experience without adding complexity
- Staff time is valuable - features should save time, not create work
