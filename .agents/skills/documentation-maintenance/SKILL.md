# Documentation Maintenance Skill

Use this skill after EVERY task that changes code behavior, fixes bugs, or adds features. This is mandatory — the user requires documentation to stay current with every change.

## Trigger Conditions
Activate after completing ANY code change that:
- Adds or modifies a feature
- Fixes a bug
- Changes API behavior
- Modifies database schema
- Updates architectural patterns
- Changes UI/UX behavior

## Required Steps (in order)

### 1. Update Changelog (`src/data/changelog.ts`)
- Add a new `ChangelogEntry` at the TOP of the array (newest first)
- If a same-day entry already exists for the same theme, append to its `changes` array
- Version bumping rules:
  - **Patch** (8.X.Y → 8.X.Y+1): Bug fixes, small improvements
  - **Minor** (8.X.0 → 8.X+1.0): New features, significant changes
  - **Major**: Reserved for breaking changes (rare)
- Write changes in **member-facing language** — describe the impact, not the code:
  - Good: "Fix: Your name now displays correctly after signing in with Google"
  - Bad: "Fix: resolveUserByEmail now returns firstName from OAuth profile data"
- Prefix each change with `Feature:`, `Fix:`, or `Improvement:`
- Use em-dash (—) to separate the what from the why

### 2. Update Changelog Version (`src/data/changelog-version.ts`)
- Update both `version` and `date` to match the new changelog entry
- This controls the "What's New" badge in the app

### 3. Update Developer Changelog (`docs/CHANGELOG.md`)
- Add a new version entry at the TOP (newest first)
- Include technical details: files changed, patterns used, root causes
- This is the single source of truth for detailed change history
- Format: `## [version] - date` with categorized bullet points

### 4. Update `replit.md`
- **Version number**: Update `**Current Version**:` at the top
- **Architecture sections**: If the change affects architecture (new patterns, new services, schema changes), update the relevant section
- Do NOT add change-by-change entries — replit.md is for architecture and rules only, not a changelog

### 5. Update Custom Skills (when applicable)
If the change establishes or modifies:
- A booking flow → update `.agents/skills/booking-flow/SKILL.md`
- Fee calculation → update `.agents/skills/fee-calculation/SKILL.md`
- Check-in flow → update `.agents/skills/checkin-flow/SKILL.md`
- Guest pass logic → update `.agents/skills/guest-pass-system/SKILL.md`
- Notification system → update `.agents/skills/notification-system/SKILL.md`
- Member lifecycle → update `.agents/skills/member-lifecycle/SKILL.md`
- Stripe webhooks → update `.agents/skills/stripe-webhook-flow/SKILL.md`
- HubSpot sync → update `.agents/skills/hubspot-sync/SKILL.md`
- Data integrity → update `.agents/skills/data-integrity-monitoring/SKILL.md`
- Scheduler/jobs → update `.agents/skills/scheduler-jobs/SKILL.md`
- Booking imports → update `.agents/skills/booking-import-standards/SKILL.md`
- A new pattern that doesn't fit existing skills → create a new skill

## Example Changelog Entry
```typescript
{
  version: "8.85.1",
  date: "2026-03-14",
  title: "Dashboard Performance & Guest Pass Display",
  changes: [
    "Feature: Dashboard now loads 40% faster — booking and event data fetched in parallel instead of sequentially",
    "Fix: Guest pass count on your profile now updates immediately after check-in — previously required a page refresh to see the updated balance",
    "Improvement: Booking cards show a subtle loading indicator while confirming your reservation",
  ]
}
```

## Verification
Before considering documentation complete:
- [ ] `src/data/changelog.ts` has the new entry at the top
- [ ] `src/data/changelog-version.ts` version and date match
- [ ] `docs/CHANGELOG.md` has the new developer-facing entry at the top
- [ ] `replit.md` version number updated (architecture sections updated if applicable)
- [ ] Relevant custom skills updated (if applicable)
