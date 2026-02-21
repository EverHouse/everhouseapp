# Ever Club Members App

A private members club application for golf and wellness centers.

## Features

- **Public Pages**: Landing, Membership, Gallery, Cafe Menu, FAQ, Contact
- **Member Portal**: Dashboard, Book Golf Simulators, Events, Wellness, Announcements
- **Staff Portal**: Member management, Booking approvals, Event administration
- **Admin Tools**: Full CRUD for all content, role management, data sync

## Tech Stack

- **Frontend**: React 19, Vite, Tailwind CSS
- **Backend**: Express.js, PostgreSQL
- **Integrations**: Google Calendar, HubSpot CRM, Resend Email

## Development

1. Install dependencies: `npm install`
2. Start the dev server: `npm run dev`
3. Start the API server: `npm run server`

The app runs on port 5000 (frontend) and port 3001 (API).

## Codebase Orientation

### High-level architecture

- **`src/`**: React client application (public website, member app, and staff/admin interfaces).
- **`server/`**: Express API server, schedulers, integrations, and route handlers.
- **`shared/`**: Shared schema exports and model definitions used across client/server boundaries.
- **`drizzle/`**: Drizzle migration metadata.
- **`tests/`**: Vitest test suites.

### Frontend structure (`src/`)

- **Entrypoints**: `src/main.tsx` mounts the app and registers the service worker; `src/App.tsx` owns routing, route guards, app-level providers, and global UI wiring.
- **Pages**:
  - `src/pages/Public/*` = marketing/public pages and auth callbacks.
  - `src/pages/Member/*` = member-only product flows (dashboard, booking, events, wellness, profile).
  - `src/pages/Admin/*` = staff/admin operational tooling and tabbed command surfaces.
- **State and data layers**:
  - `src/contexts/*` provides domain-specific context providers (auth, members, events, announcements, bookings, theme, etc.).
  - `src/stores/*` uses Zustand for focused client state.
  - `src/lib/queryClient.ts` configures React Query.
- **Reusable UI**: `src/components/*` holds shared components, motion primitives, and staff command-center modules.

### Backend structure (`server/`)

- **Entrypoint**: `server/index.ts` starts HTTP health endpoints first, then initializes Express, middleware, route registration, startup tasks, schedulers, and WebSocket infrastructure.
- **Route registration**: `server/loaders/routes.ts` mounts domain routers for auth, members, events, billing, notifications, data integrity, and other integrations.
- **Core services**:
  - `server/core/db.ts` manages Postgres connection pooling and retry utilities.
  - `server/core/logger.ts` and middleware provide request/event logging patterns.
  - `server/core/*` and `server/supabase/*` contain integration-specific server logic.
- **Operational concerns**:
  - `server/schedulers/*` runs background jobs.
  - `server/scripts/*` contains one-off maintenance scripts.

### Important patterns for newcomers

1. **Multiple app surfaces in one frontend**: public, member, and admin experiences all live in the same Vite app, with role-aware route guards.
2. **Provider composition first**: most data access comes from composed context providers through `useData()` and related hooks.
3. **Thin route loader, thick domain routers**: `registerRoutes()` centralizes mount order while implementation stays in per-domain route modules.
4. **Shared schema contract**: `shared/schema.ts` exports model modules used to keep server and client aligned.
5. **Dev topology**: run frontend and backend together (`npm run dev` + `npm run server`, or `npm run dev:all`) and rely on Vite proxying `/api` and `/ws` to the server.

### Suggested learning path

1. **Start at runtime boundaries**: read `src/main.tsx`, `src/App.tsx`, and `server/index.ts`.
2. **Trace one end-to-end feature**: e.g., booking or announcements from page -> context/hook -> API route -> DB call.
3. **Study auth/session flow**: understand how `AuthDataContext`, protected routes, and `/api/auth` endpoints interact.
4. **Learn key integrations**: Supabase auth/realtime, Stripe billing routes, and HubSpot sync points.
5. **Review production safeguards**: graceful shutdown, health/readiness endpoints, rate limiting, retries, and scheduler lifecycle.
