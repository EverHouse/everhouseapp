# Agent Incident Log

This file tracks every instance where the agent failed to follow explicit instructions, ignored documented rules, or deviated from established processes. Each entry includes what was missed, the impact, and estimated wasted agent usage.

---

## Incident #1 — 2026-01-13
**Rule Violated:** Don't make UI changes without understanding the existing layout
**What Happened:** Agent made layout changes to Tours and Updates tabs that had to be fully reverted. Changes were made without understanding the existing design, resulting in a complete rollback.
**Estimated Wasted Usage:** ~5 messages (implementation + user reporting breakage + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #2 — 2026-01-27
**Rule Violated:** Load fee-calculation skill before modifying billing logic
**What Happened:** Agent introduced incorrect fee calculations and duplicate bookings. Required 3 follow-up fix commits in the same session: "Fix incorrect fee calculations and duplicate bookings" → "Remove incorrect updated_at fields from booking fee snapshot updates" → "Fix fee calculation by correcting incorrect database join". Each fix uncovered the next problem.
**Estimated Wasted Usage:** ~8 messages (3 rounds of fix-test-fix cycle + user reporting issues)
**Corrective Action:** None documented at the time.

## Incident #3 — 2026-02-04
**Rule Violated:** Load booking-flow and checkin-flow skills before modifying check-in logic
**What Happened:** Agent broke the check-in button and spent an entire session trying to fix it — 10 consecutive commits over several hours: "Fix booking check-in and billing session creation issues" → "Fix Check In button not responding to clicks" → "Add logging and stop propagation" → "Fix button display" → "Improve booking check-in button functionality" → "Enable check-in for bookings without billing session" → "Fix booking check-in button functionality on the bookings page" → "Add logging and error handling" → "Replace broken check-in button with a working version from command console". This was a classic case of thrashing without understanding the architecture first.
**Estimated Wasted Usage:** ~15-20 messages (10 fix attempts + user waiting + diagnostic logging that shouldn't have been needed)
**Corrective Action:** None documented at the time. This is the single most expensive incident.

## Incident #4 — 2026-02-06
**Rule Violated:** Don't change email configuration without checking existing settings
**What Happened:** Agent changed the email sender domain, breaking email delivery. Had to be reverted: "Revert system emails back to the correct domain."
**Estimated Wasted Usage:** ~4 messages (original change + user reporting broken emails + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #5 — 2026-02-09 to 2026-02-10
**Rule Violated:** Load fee-calculation skill before modifying financial displays
**What Happened:** Agent introduced incorrect fee calculations in financial summary displays. Required fixes across two separate sessions: "Fix incorrect fee calculations in financial summary displays" (Feb 9) → "Fix incorrect fee calculation and display for bookings" (Feb 10). Same class of bug as Incident #2.
**Estimated Wasted Usage:** ~6 messages (2 sessions of fix cycles + user reports)
**Corrective Action:** None documented. Pattern of fee calculation bugs repeated.

## Incident #6 — 2026-02-20
**Rule Violated:** Load stripe-webhook-flow skill before modifying webhook handlers; test changes before deploying
**What Happened:** Agent added financial freeze guards to webhook update handlers that broke production webhook processing. Had to revert: "Revert financial freeze guards for webhook updates." The guards prevented legitimate Stripe webhooks from updating booking payment status.
**Estimated Wasted Usage:** ~6 messages (implementation + deploy + user reporting production breakage + investigation + revert)
**Corrective Action:** None documented at the time.

## Incident #7 — 2026-02-23
**Rule Violated:** Check database constraints before using status values
**What Happened:** Agent used 'completed' as a booking status in the data integrity "complete booking" endpoint, but the database CHECK constraint only allows: pending, approved, confirmed, declined, cancelled, cancellation_pending, attended, no_show, expired. This caused a 500 error on every "Complete Booking" click in the data integrity page. If the booking-flow skill had been loaded, the valid statuses would have been known.
**Estimated Wasted Usage:** ~4 messages (user reporting 500 error + investigation + fix + retest)
**Corrective Action:** Fixed to use 'attended' status. Added to booking-flow skill documentation.

## Incident #8 — 2026-02-24
**Rule Violated:** Changelog updates are mandatory after every session with user-facing changes
**What Happened:** Multiple sessions across Feb 23-24 produced 8 versions worth of changes (v8.13.0 through v8.20.0) without updating `src/data/changelog.ts` or `src/data/changelog-version.ts`. The changelog rule existed in replit.md but was buried in User Preferences and ignored. User had to explicitly call it out.
**Estimated Wasted Usage:** ~3 messages (user reminder, agent reviewing all commits, writing 8 changelog entries retroactively)
**Corrective Action:** Moved changelog rule to top of replit.md under mandatory section with bold header.

## Incident #9 — 2026-02-24
**Rule Violated:** Load relevant skills before making any code changes
**What Happened:** Agent repeatedly jumped into code changes without first reading the relevant SKILL.md files. User had to remind the agent multiple times across sessions. This is a systemic pattern, not a one-off — the same behavior has contributed to Incidents #2, #3, #5, #6, and #7.
**Estimated Wasted Usage:** ~2-4 messages per occurrence across multiple sessions. Cumulative cost is the highest of any pattern — estimated 20+ messages total across all sessions where skills were skipped.
**Corrective Action:** Added explicit skill mapping table and bold mandatory header at top of replit.md. Added incident log requirement.

---

## Summary

| Incident | Date | Category | Est. Wasted Messages |
|----------|------|----------|---------------------|
| #1 | Jan 13 | Unnecessary UI revert | ~5 |
| #2 | Jan 27 | Fee calc fix chain (3 attempts) | ~8 |
| #3 | Feb 4 | Check-in button thrashing (10 attempts) | ~15-20 |
| #4 | Feb 6 | Email domain revert | ~4 |
| #5 | Feb 9-10 | Fee calc fix chain (repeat) | ~6 |
| #6 | Feb 20 | Webhook guard revert | ~6 |
| #7 | Feb 23 | Invalid DB status value | ~4 |
| #8 | Feb 24 | Missed changelog updates | ~3 |
| #9 | Feb 24 | Skipped skill loading (systemic) | ~20+ |
| **Total** | | | **~71-76 messages** |

Most expensive pattern: **Not loading skills before coding** — directly caused or contributed to Incidents #2, #3, #5, #6, #7, and #9. If skills had been loaded first in every case, an estimated 40+ messages of rework could have been avoided.

---

*New entries must be added above the Summary section. Format: Incident number, date, rule violated, what happened, estimated wasted usage, corrective action taken.*
