## 2025-01-24 - Stable Time References for Memoization
**Learning:** Using dynamic time-based values (like `getNowTimePacific()`) directly in component renders or as dependencies for `useMemo` triggers unnecessary re-renders and re-computations on every tick. This negates the benefits of memoization.
**Action:** Lift the time reference into a state variable that updates at a controlled, slower interval (e.g., every 60 seconds). Use this stable state variable as a dependency for `useMemo` and `useCallback`, ensuring that expensive filtering and sorting logic only runs when significant time has passed.

## 2025-01-24 - React.memo with Hooks
**Learning:** `React.memo` is ineffective if the component consumes hooks that trigger re-renders internally (like `useLocation` or data-fetching hooks).
**Action:** When optimizing such components, either move the hook usage to a parent and pass the data as props, or accept that `React.memo` will only prevent re-renders caused by parent changes, not by the component's own hook-triggered updates.
