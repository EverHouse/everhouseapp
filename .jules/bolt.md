## 2025-05-22 - Dashboard Memoization Anti-pattern
**Learning:** Using time-sensitive functions like `getNowTimePacific()` directly in a component body or as a dependency for `useMemo` negates memoization benefits because they change on every render (or every second).
**Action:** Use `useState` and `useEffect` with `setInterval` to create a stable heartbeat state (e.g., updating every 60s) for time-based UI logic. This allows `useMemo` to remain stable between heartbeat updates.
