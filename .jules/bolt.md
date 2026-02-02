## 2026-02-02 - Memoization of time-sensitive derived state
**Learning:** In components like `Dashboard.tsx` that derive multiple lists and statistics from various data sources AND current time, calling `getNowTimePacific()` or `getTodayString()` directly in the render body or as a direct `useMemo` dependency causes the entire derivation chain to re-execute on every render (if time changed) or prevents effective memoization.
**Action:** Use a stable `currentTime` state updated via `setInterval` (e.g., every 60s) to provide a stable reference for `useMemo` dependencies. This ensures that heavy calculations like array merging, sorting, and filtering only occur when data actually changes or when a significant time boundary is crossed.

## 2026-02-02 - React.memo for list items in high-frequency update pages
**Learning:** Shared UI components like `GlassRow` that are used in long lists on pages with multiple real-time data sources (via TanStack Query) should always be wrapped in `React.memo`.
**Action:** Proactively memoize pure functional components used in lists to prevent redundant re-renders when the parent component updates due to any of its many data queries.
