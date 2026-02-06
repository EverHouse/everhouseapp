## 2026-02-06 - Safety Checks in useMemo for Async Data
**Learning:** When memoizing complex data transformations that depend on asynchronous query results, failing to handle the initial 'undefined' or loading state can lead to runtime crashes during the first render, even if fallbacks are defined elsewhere.
**Action:** Always include explicit safety checks or early returns inside `useMemo` hooks when dealing with potentially undefined data sources, ensuring the transformation logic only runs on valid data structures.
