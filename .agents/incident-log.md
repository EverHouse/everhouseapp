# Agent Incident Log

This file tracks every instance where the agent failed to follow explicit instructions, ignored documented rules, or deviated from established processes. Each entry includes what was missed, the impact, and estimated wasted agent usage.

---

## Incident #1 — 2026-01-13
**Rule Violated:** Don't make UI changes without understanding the existing layout
**What Happened:** Agent made layout changes to Tours and Updates tabs that had to be fully reverted. Changes were made without understanding the existing design, resulting in a complete rollback.
**Estimated Wasted Usage:** ~5 messages (implementation + user reporting breakage + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #2 — 2026-01-14
**Rule Violated:** Understand root cause before applying fixes; don't thrash
**What Happened:** Agent broke page scrolling and spent an entire session thrashing trying to fix it. **14+ consecutive fix commits** in one session: "Fix scrolling issue on member directory page" → "Improve scroll locking mechanism" → "Restore scroll functionality" → "Fix scrolling issue by ensuring page overflow" → "Restore original scroll behavior" → "Fix scrolling issues by clearing overflow states" → "Temporarily disable pull-to-refresh" → "Remove unnecessary overflow cleanup" → "Fix scrolling bugs and prevent memory leaks" → "Fix scrolling issues in menu overlay" → "Improve scrolling behavior and modal management" → "Allow the page to scroll" → "Ensure pages consistently allow vertical scrolling" → "Fix page scrolling issues" → "Prevent splash screen from blocking scroll events." Each attempt introduced new problems.
**Estimated Wasted Usage:** ~20-25 messages (14 fix attempts + user going back and forth reporting issues)
**Corrective Action:** None documented at the time.

## Incident #3 — 2026-01-22
**Rule Violated:** Don't make experimental UI changes without understanding Safari rendering; research before coding
**What Happened:** Agent attempted to style the Safari bottom toolbar with 6 rapid-fire commits in one session: "Make the footer transparent in the Safari pop-up browser" → "Update color themes and add gradient behind bottom navigation" → "Remove the gradient from the bottom navigation area" (literally undoing the previous commit) → plus 3 more attempts. The gradient was added then immediately removed — pure thrashing.
**Estimated Wasted Usage:** ~8 messages (6 attempts + user feedback)
**Corrective Action:** None documented. Problem persisted through multiple future sessions.

## Incident #4 — 2026-01-23
**Rule Violated:** Test security changes before deploying; understand session flow before adding middleware
**What Happened:** Agent added CSRF protection that broke login and all form submissions across the app. Required emergency removal: "Remove CSRF protection to resolve login and form submission errors" → "Remove CSRF tokens and add Trackman booking linking." Users couldn't log in until the revert.
**Estimated Wasted Usage:** ~6 messages (implementation + user reporting broken login + investigation + 2 revert commits)
**Corrective Action:** None documented at the time.

## Incident #5 — 2026-01-24
**Rule Violated:** Don't thrash on CSS layout; research Safari safe areas before coding
**What Happened:** Agent attempted to fix drawer safe area padding with 4 consecutive commits in quick succession: "Improve drawer display by adjusting safe area padding" → "Improve drawer layout to correctly handle safe area padding" → "Improve drawer display on mobile devices by extending background into safe areas" → "Adjust drawer layout to correctly display content within safe areas." Each attempt shifted the problem around without resolving it.
**Estimated Wasted Usage:** ~6 messages (4 attempts + user feedback)
**Corrective Action:** None documented.

## Incident #6 — 2026-01-27
**Rule Violated:** Load fee-calculation skill before modifying billing logic
**What Happened:** Agent introduced incorrect fee calculations and duplicate bookings. Required 3 follow-up fix commits in the same session: "Fix incorrect fee calculations and duplicate bookings" → "Remove incorrect updated_at fields from booking fee snapshot updates" → "Fix fee calculation by correcting incorrect database join." Each fix uncovered the next problem.
**Estimated Wasted Usage:** ~8 messages (3 rounds of fix-test-fix cycle + user reporting issues)
**Corrective Action:** None documented at the time.

## Incident #7 — 2026-01-29
**Rule Violated:** Research Safari theme-color behavior before trial-and-error coding
**What Happened:** Agent tried to fix Safari toolbar color with **6 consecutive commits** all within ~30 minutes: "Update browser toolbar colors to match page backgrounds" → "Improve Safari toolbar appearance to match page backgrounds" → "Update Safari browser bar color to match page background dynamically" → "Improve Safari toolbar appearance and transparency with dynamic tinting" → "Improve toolbar color accuracy for Safari users" → "Improve Safari toolbar color detection with fixed element and media queries" → "Set public pages to light toolbar and member pages to match device theme." Pure trial-and-error without understanding Safari's theme-color meta tag behavior.
**Estimated Wasted Usage:** ~10 messages (7 attempts + user feedback each time)
**Corrective Action:** None documented. Problem continued into Jan 31 and Feb sessions.

## Incident #8 — 2026-01-31 to 2026-02-02
**Rule Violated:** Same as #7 — still trial-and-error on Safari toolbar without researching
**What Happened:** Safari toolbar issue continued across 3 more days with 5+ additional commits: "Remove theme-color meta tags" → "Improve page display behind Safari's toolbar" → "Ensure Safari toolbar shows correct background color" → "Improve how Safari toolbar color is displayed" → "Add a real element to fix Safari toolbar color issues" → "Update Safari toolbar to match device theme and preserve loading screen." The agent kept trying different approaches without ever researching how Safari actually handles theme-color.
**Estimated Wasted Usage:** ~8 messages (5+ attempts across multiple sessions)
**Corrective Action:** None documented.

## Incident #9 — 2026-02-04
**Rule Violated:** Load booking-flow and checkin-flow skills before modifying check-in logic
**What Happened:** Agent broke the check-in button and spent an entire session trying to fix it — **10 consecutive commits** over several hours: "Fix booking check-in and billing session creation issues" → "Fix Check In button not responding to clicks" → "Add logging and stop propagation" → "Fix button display" → "Improve booking check-in button functionality" → "Enable check-in for bookings without billing session" → "Fix booking check-in button functionality on the bookings page" → "Add logging and error handling" → "Replace broken check-in button with a working version from command console." Classic thrashing without understanding the architecture first.
**Estimated Wasted Usage:** ~15-20 messages (10 fix attempts + user waiting + diagnostic logging that shouldn't have been needed)
**Corrective Action:** None documented at the time.

## Incident #10 — 2026-02-06
**Rule Violated:** Don't change email configuration without checking existing settings
**What Happened:** Agent changed the email sender domain, breaking email delivery. Had to be reverted: "Revert system emails back to the correct domain."
**Estimated Wasted Usage:** ~4 messages (original change + user reporting broken emails + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #11 — 2026-02-09 to 2026-02-10
**Rule Violated:** Load fee-calculation skill before modifying financial displays (repeat of #6)
**What Happened:** Agent introduced incorrect fee calculations in financial summary displays. Required fixes across two separate sessions: "Fix incorrect fee calculations in financial summary displays" (Feb 9) → "Fix incorrect fee calculation and display for bookings" (Feb 10). Same class of bug as Incident #6, same root cause.
**Estimated Wasted Usage:** ~6 messages (2 sessions of fix cycles + user reports)
**Corrective Action:** None documented. Third time fee calculations were broken.

## Incident #12 — 2026-02-12
**Rule Violated:** Research Safari toolbar behavior before coding; don't thrash; recognize when you're going in circles
**What Happened:** THE WORST INCIDENT. Agent spent an entire evening session on Safari toolbar/status bar tinting with **22+ consecutive commits** over ~4 hours, all thrashing: "Adjust footer padding to align with Safari's display" → "Make Safari toolbar transparent" → "Restore green top toolbar color" → "Extend header to appear behind Safari's toolbar" → "Fix header positioning to correctly tint Safari toolbars" → "Restore green status bar tint" → "Update color settings" → "Make status bar and splash screen appear green" → "Add Safari-specific toolbar tinting" → "Improve Safari toolbar appearance by adjusting tinting elements" → "Add bottom content visibility behind browser toolbars" → "Improve visibility of content behind bottom toolbar" → "Restore light tint to bottom toolbar" → "Adjust header background to fix toolbar color" → "Restore correct toolbar tinting and content visibility" → "Adjust dark mode status bar to match header color" → "Darken background color in dark mode" → "Update dark mode status bar to match header color exactly" → "Hide the green tinting element on desktop devices" → "Adjust orb gradient position to fix status bar color mismatch" → "Remove decorative orb gradients from the application layout." The agent literally added things, removed them, re-added them, and went in circles for hours.
**Estimated Wasted Usage:** ~30-40 messages (22 attempts + constant user feedback loop). **This is the single most expensive incident.**
**Corrective Action:** None documented at the time.

## Incident #13 — 2026-02-18 to 2026-02-19
**Rule Violated:** Load hubspot-sync skill; understand the root cause of HubSpot form sync errors instead of repeatedly patching logging
**What Happened:** HubSpot form sync kept logging "access denied" errors. Agent made 3+ attempts to fix it across sessions without understanding the actual auth flow: "Limit repetitive logging for HubSpot form sync access denied errors" → "Update form sync to use private app token for HubSpot access" → "Improve HubSpot form sync error handling and logging." Each attempt just shuffled the logging or token used without solving the underlying permission issue. The errors continued until Feb 23 when backup token fallback was finally added.
**Estimated Wasted Usage:** ~8 messages across 3 sessions (investigation + fixes that didn't work + user following up)
**Corrective Action:** Eventually resolved with proper backup token fallback on Feb 23.

## Incident #14 — 2026-02-20
**Rule Violated:** Load stripe-webhook-flow skill before modifying webhook handlers; test changes before deploying
**What Happened:** Agent added financial freeze guards to webhook update handlers that broke production webhook processing. Had to revert: "Revert financial freeze guards for webhook updates." The guards prevented legitimate Stripe webhooks from updating booking payment status.
**Estimated Wasted Usage:** ~6 messages (implementation + deploy + user reporting production breakage + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #15 — 2026-02-23
**Rule Violated:** Check database constraints before using status values; load booking-flow skill
**What Happened:** Agent used 'completed' as a booking status in the data integrity "complete booking" endpoint, but the database CHECK constraint only allows: pending, approved, confirmed, declined, cancelled, cancellation_pending, attended, no_show, expired. This caused a 500 error on every "Complete Booking" click. If the booking-flow skill had been loaded, the valid statuses would have been known.
**Estimated Wasted Usage:** ~4 messages (user reporting 500 error + investigation + fix + retest)
**Corrective Action:** Fixed to use 'attended' status.

## Incident #16 — 2026-02-24
**Rule Violated:** Changelog updates are mandatory after every session with user-facing changes
**What Happened:** Multiple sessions across Feb 23-24 produced 8 versions worth of changes (v8.13.0 through v8.20.0) without updating the changelog files. User had to explicitly call it out.
**Estimated Wasted Usage:** ~3 messages (user reminder, agent reviewing all commits, writing 8 changelog entries retroactively)
**Corrective Action:** Moved changelog rule to top of replit.md under mandatory section.

## Incident #17 — 2026-02-24
**Rule Violated:** Load relevant skills before making any code changes (systemic pattern)
**What Happened:** Agent repeatedly jumped into code changes without first reading the relevant SKILL.md files across many sessions. This is a systemic pattern, not a one-off — directly contributed to Incidents #6, #9, #11, #13, #14, and #15.
**Estimated Wasted Usage:** Cumulative cost is the highest of any pattern — estimated 30+ messages total across all sessions where skills were skipped.
**Corrective Action:** Added explicit skill mapping table and bold mandatory header at top of replit.md. Added incident log requirement.

---

## Summary

| # | Date | Category | Est. Wasted Messages |
|---|------|----------|---------------------|
| 1 | Jan 13 | UI revert (Tours/Updates tabs) | ~5 |
| 2 | Jan 14 | Scroll fix thrashing (14 attempts) | ~20-25 |
| 3 | Jan 22 | Safari toolbar thrashing (6 attempts) | ~8 |
| 4 | Jan 23 | CSRF broke login (emergency revert) | ~6 |
| 5 | Jan 24 | Drawer safe area thrashing (4 attempts) | ~6 |
| 6 | Jan 27 | Fee calc fix chain (3 attempts) | ~8 |
| 7 | Jan 29 | Safari toolbar thrashing (7 attempts) | ~10 |
| 8 | Jan 31–Feb 2 | Safari toolbar continued (5+ attempts) | ~8 |
| 9 | Feb 4 | Check-in button thrashing (10 attempts) | ~15-20 |
| 10 | Feb 6 | Email domain revert | ~4 |
| 11 | Feb 9-10 | Fee calc fix chain repeat | ~6 |
| 12 | Feb 12 | Safari toolbar mega-thrash (22 attempts) | **~30-40** |
| 13 | Feb 18-19 | HubSpot form error patching (3 sessions) | ~8 |
| 14 | Feb 20 | Webhook guard revert | ~6 |
| 15 | Feb 23 | Invalid DB status value | ~4 |
| 16 | Feb 24 | Missed changelog updates | ~3 |
| 17 | Feb 24 | Skipped skill loading (systemic) | ~30+ |
| **Total** | | | **~177-207 messages** |

### Top 3 Most Expensive Patterns

1. **Safari toolbar thrashing** (Incidents #3, #7, #8, #12): ~56-66 messages across 4+ sessions. Agent never researched how Safari handles theme-color and viewport-fit, just kept trial-and-erroring CSS changes.

2. **UI/UX thrashing without understanding root cause** (Incidents #2, #5, #9): ~41-51 messages. Agent broke something then made 10-14 consecutive attempts to fix it without stepping back to understand the architecture.

3. **Skipping skill loading → billing/webhook bugs** (Incidents #6, #11, #13, #14, #15): ~32+ messages. Same class of bugs repeated because skills weren't loaded to understand established patterns.

---

*New entries must be added above the Summary section. Format: Incident number, date, rule violated, what happened, estimated wasted usage, corrective action taken.*
