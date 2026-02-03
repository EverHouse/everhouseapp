## 2026-02-03 - Stable Time/Date Pattern for Performance
**Learning:** When using useMemo for time-sensitive calculations, a direct dependency on a value that changes every render (like getNowTimePacific()) negates the optimization.
**Action:** Use useState and useEffect with setInterval to create a stable state variable that updates at a slower, controlled interval (e.g., every 60 seconds), allowing useMemo to be effective.
