# Bolt's Journal ⚡

## 2025-02-04 - Stabilizing Time-Dependent Memoization
**Learning:** When using `useMemo` for time-sensitive calculations (like filtering upcoming items), a direct dependency on a value that changes every render (e.g., `getNowTimePacific()`) will negate the optimization.
**Action:** Use `useState` and `useEffect` with `setInterval` to create a stable state variable that updates at a slower, controlled interval (e.g., every 60 seconds). This keeps the dashboard accurate but allows `useMemo` to skip redundant calculations for 59 out of 60 renders.

## 2025-02-04 - O(N*M) vs O(N+M) in Frontend Filtering
**Learning:** Using `.some()` inside a `.filter()` on two large arrays (like deduplicating booking requests against calendar events) leads to O(N*M) complexity, which can be noticeable on slower mobile devices.
**Action:** Convert the comparison array into a `Set` for O(1) lookups, achieving O(N+M) total complexity. This is a high-impact, low-effort optimization for data-heavy components.
