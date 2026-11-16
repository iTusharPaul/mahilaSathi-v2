# mahilaSathi — Current State & Implementation Plan

_Last updated: 2026-11-12 (start of Phase 0)_

## 1. Repository inspection

### `mahilaSathiV2/` (this repository)

Empty at the start of Phase 0: no source, no git history, no configuration.
Everything in this repository is built fresh.

### `../mahilaSathi/` (previous prototype, "NightWise")

A sibling folder holds an earlier hackathon prototype called **NightWise**. It
is a reference only. Nothing is copied wholesale. Findings:

| Area | What exists in v1 | Decision for v2 |
|---|---|---|
| Geography | Bengaluru-focused, city names hardcoded | Rebuild as an NCR geographic registry with polygons (Phase 1) |
| Database | Ad hoc `CREATE TABLE IF NOT EXISTS` at boot | Replace with versioned, checksummed SQL migrations (Phase 0) |
| Nexconn | Working server token issue (`POST /v4/auth/access-token/issue`, SHA1 signature headers) and client `NCEngine` usage with `@nexconn/chat@26.2.1` | Reuse as a **reference** for real SDK calls in Phase 2, after re-checking the current docs |
| Nexconn fallback | Silently falls back to a `BroadcastChannel` "simulation" when keys are missing | Not acceptable. v2 uses an explicitly labelled development adapter that is visible in the UI |
| Client config | Nexconn app key baked into the bundle through `VITE_*` env | v2 serves public runtime config from the API. The client bundle reads no secrets and no provider keys from env |
| Scoring | Score engine and opening-hours evaluation exist | Rewrite against the spec (factor contract, unknown-factor redistribution, confidence) in Phase 3, with tests |
| Tests | Smoke test only | Unit, integration and security tests from Phase 0 onwards |

Toolchain known to work on this machine (from the v1 lockfile): Node 22,
`better-sqlite3@11.10`, `tsx@4`, `vitest@2`, `@nexconn/*@26.2.1`.

## 2. Architecture decisions

- **Monorepo with npm workspaces**: `shared/`, `server/`, `client/`. `shared` compiles to ESM and holds Zod schemas, types and constants that both sides use.
- **Single deployable**: Express serves `/api/*` and the built SPA from `client/dist`, with SPA fallback for client routes.
- **Database**: SQLite through `better-sqlite3`, using WAL mode and foreign keys. Migrations are plain SQL files in `database/migrations/NNNN_name.sql`, applied in a transaction and recorded in `schema_migrations` with a SHA-256 checksum. If an applied migration is later edited, startup stops. Repository functions are the only code that touches SQL, so a later move to Postgres/PostGIS stays contained.
- **Geospatial readiness**: Coordinates are stored as numeric `lat`/`lng` columns with bounding-box columns and indexes, plus GeoJSON for polygons. They are never packed into opaque strings. H3 cell ids are used for aggregation. This maps directly onto PostGIS later.
- **Config**: All env vars are parsed with Zod at boot. The app fails fast with actionable messages. Production refuses weak or missing secrets and refuses the mock OTP provider outside demo mode.
- **Public runtime config**: `GET /api/config` returns only non-secret values, such as whether demo mode is on and whether each provider is configured. It never returns key values.
- **Observability**: `pino` structured logs with request ids. Phone numbers, coordinates, tokens and cookies are redacted.
- **Security baseline**: `helmet` headers, strict CORS allow-list, JSON body size limits, API rate limiting, and a central error handler that never leaks stack traces in production.
- **Frontend**: React 18, Vite, TypeScript, Tailwind (design tokens as CSS variables with light and dark themes), React Router, TanStack Query and Zustand. MapLibre arrives in Phase 3. Fonts are self-hosted, so the app makes no third-party font requests.

## 3. Phase plan

| Phase | Scope | Gate (acceptance evidence) |
|---|---|---|
| **0 Foundation** | Workspaces, shared package, config validation, logging, error handling, migrations, health/ready, static serving, design system and app shell | Typecheck and build pass; migration tests; API tests for health/ready/404/headers; secret-scan test on the client bundle; production server serves SPA and API from one port |
| **1 Auth & Geography** | OTP auth (dev provider labelled), sessions, profile, emergency contacts, NCR boundary dataset with source and version, registry tables, point-in-polygon, Geoapify geocoding behind a provider interface, coverage metadata, seeded neighbourhoods | Auth integration tests; inside/outside-NCR and cross-state resolution tests |
| **2 Nexconn** | Server token issue, SDK lifecycle layer, neighbourhood/Guardian/Journey Room channels, `MS:` custom messages, block/report, moderation hooks | Two demo users exchange messages; privacy tests on circle access and block bypass |
| **3 Routing & Scoring** | Geoapify routing alternatives, Places/Overpass, opening hours, segmentation, Night Activity Score with confidence and explanations, caching with freshness | Scoring unit tests (redistribution, confidence, low-activity stretch); cross-state routing test |
| **4 Journeys, Walk Together, Pulse** | Trip state machine, check-ins, shares, corridor identity, matching with mutual consent, H3 pulse aggregation with decay and anti-abuse | State machine, privacy-trim, corridor and decay tests |
| **5 SOS & Hardening** | Durable SOS events, delivery attempts, retries via a DB-backed job runner, acknowledgements, restart recovery, audit logs | Idempotency, retry, restart-recovery and authorisation tests |
| **6 Polish & Deploy** | Responsive UI, a11y, empty/loading/error states, demo seed across NCR, README, e2e run | Demo script runs end to end in two windows |

Work proceeds one phase at a time. A phase is marked complete only with test
output or a working demonstration.

## 4. Open inputs needed from the project owner

These are not needed for Phase 0:

1. **Geoapify API key** (Phase 1/3). Without it, geocoding and routing run on a clearly labelled synthetic demo adapter.
2. **Nexconn app key and secret** (Phase 2). Without them, chat runs on a labelled development adapter that is never presented as production messaging.
3. **NCR boundary dataset** (Phase 1). The plan is to derive district polygons from an openly licensed source (OSM / geoBoundaries) and filter them to the districts listed in the NCR Planning Board's notified constituent areas. Source URL, licence and retrieval date go in `ncr_boundaries`.
