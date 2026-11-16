# mahilaSathi

**Safer journeys. Stronger together.**

mahilaSathi is a mobile-first night travel companion and community safety platform for women across the
entire National Capital Region (Delhi, Haryana, Uttar Pradesh and Rajasthan NCR). It compares routes by a
transparent, contextual **Night Activity Score**. Users can share journeys with trusted contacts, connect
with other travelling women only with mutual consent, join neighbourhood communities, and raise a durable SOS.

> mahilaSathi provides context and assistance. It never guarantees personal safety and is not a substitute
> for emergency services. In an emergency in India, call **112**.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation: workspaces, config validation, logging, migrations, health/ready, single deployable, design system | **Done.** See [Phase 0 evidence](#phase-0-evidence) |
| 1 | Auth (OTP) & NCR geography: sign-in, profile, emergency contacts, NCR registry, area resolution, onboarding | **Done.** See [Phase 1 evidence](#phase-1-evidence) |
| 2 | Community: neighbourhood channels, journey rooms, Guardian Circle, block/report, moderation (Nexconn + labelled development relay) | **Done.** See [Phase 2 evidence](#phase-2-evidence). Live Nexconn messaging confirmed in Phase 6 |
| 3 | Routing & Night Activity Score: Geoapify routes, places, opening hours, transparent scoring, map | **Done.** See [Phase 3 evidence](#phase-3-evidence) |
| 4 | Journeys (state machine, check-ins, Guardian sharing, live location), Walk Together (mutual consent), Community Pulse & incident reports | **Done.** See [Phase 4 evidence](#phase-4-evidence) |
| 5 | SOS & safety hardening: durable SOS with retries, acknowledgements, user-set escalation, restart recovery; audit log; privacy controls; security suite | **Done.** See [Phase 5 evidence](#phase-5-evidence) |
| 6 | Polish, demo & deployment: code splitting, map interactions, accessibility and responsive fixes, demo mode with fictional accounts, Docker deployment, end-to-end demo test | **Done.** See [Phase 6 evidence](#phase-6-evidence) |

The full plan and the inspection notes for the previous prototype are in
[docs/00-current-state-and-plan.md](docs/00-current-state-and-plan.md).

> **Production readiness, honestly.** Everything above works end to end locally, including Web Push
> notifications. One provider a public launch needs doesn't exist yet: a real **OTP/SMS provider**. The
> server therefore refuses to start in production without `DEMO_MODE=true`. Both development adapters are
> labelled on screen: OTP codes are shown in the app, and SMS is recorded in Moderation → SMS outbox. Treat
> any deployment today as a demo or pilot, not a public safety service.

## Quick start (demo)

```bash
npm install
```

```bash
cp .env.example .env
```

In `.env`:
- **Required:** `DEMO_MODE=true`.
- **Recommended for a full local demo:**
  - `JWT_SECRET` (32+ random characters), so sign-ins survive dev restarts;
  - `ADMIN_TOKEN`, for the moderator screen;
  - `SMS_PROVIDER=mock`, so SOS texts appear in the SMS outbox;
  - `PUSH_PROVIDER=webpush` with a VAPID key pair from `npx web-push generate-vapid-keys`.
- **Optional:** Geoapify and Nexconn keys. Without them, routes are labelled synthetic and chat uses the labelled development relay.

Then reset the local database to fresh demo data, and start the app:

```bash
npm run demo:reset
```

`demo:reset` deletes `DATABASE_PATH` and seeds the demo accounts (stop the dev server first). `npm run demo:seed` adds them without deleting anything. With a Geoapify key, also assess data coverage for every curated neighbourhood (about a minute, results cached):

```bash
npm run coverage:assess
```

```bash
npm run dev
```

Open http://localhost:5173. The sign-in screen lists the demo accounts when demo mode is on. Tap one, then enter the development code shown on screen (no SMS is sent).

| Account | Phone | Role |
|---|---|---|
| **Lotus-42** | 90000 00042 | Traveller. Home: Cyber City, Gurugram. Has a Guardian Circle and a fictional emergency contact |
| **Jasmine-17** | 90000 00017 | Lotus's guardian. Home: Saket, Delhi |
| **Neem-08** | 90000 00008 | Walking companion for Walk Together. Home: Saket |

These are fictional people. Their profiles, chat names, reports and SOS alerts are all labelled as demo. Their activity never counts towards the Community Pulse. `npm run demo:seed` refuses to run unless `DEMO_MODE=true`.

### Demo script

Use two browser windows (or one normal and one private window). The script works with or without live keys.

**Window A: Lotus-42**
1. Plan **Cyber City (Gurugram) → Saket (South Delhi)** by cab. This route crosses from Haryana into Delhi. Compare the routes, sort them, and open "How this score was worked out" for the factors and confidence. Tap a route or a place dot on the map.
2. Start Neem's walk so there is someone to match with:
   ```bash
   npm run demo:companion
   ```
3. Plan a **walk from Green Park Market to Select Citywalk**, then tap **Start this journey**.
4. Share the journey with the circle (*Approximate*), then tap **Start journey**.
5. Under **Walk Together**, tap **Look for company**. Review the match with Neem-08 and accept it. The pair chat opens once Neem accepts too (sign in as Neem in a third window).
6. In **Community**, open the Cyber City channel and post a neighbourhood update.
7. Tap **I've arrived** to complete the journey.

**Window B: Jasmine-17**
1. Open **Journeys → Shared with me** to see Lotus's journey at the level she allowed. Tap **I'm keeping an eye on this**.
2. Open the **Guardian Circle** chat to see the journey updates, each marked "[Demo]".
3. Open the **Saket** neighbourhood channel and view the community update. Use ⋮ to report it or block its author.

**Also demonstrate**
- **Noida → Delhi:** plan Sector 62, Noida → Connaught Place. This route crosses from Uttar Pradesh into Delhi.
- **Report an issue:** Community → **Area pulse & reports**.
- **SOS in demo mode:** as Lotus, hold the SOS button. Jasmine's screen shows "DEMO SOS (not real)", and every message the SOS sends starts with "DEMO, not a real emergency". End it with **False alarm**.

## Technology stack

| Layer | Choice |
|---|---|
| Client | React 18, TypeScript, Vite 6, Tailwind CSS 3, React Router 6 (route-level code splitting), TanStack Query 5, Zustand, MapLibre GL 5 (lazy-loaded), `@nexconn/chat` 26.2.1 (lazy-loaded) |
| Server | Node.js 22, Express 5, TypeScript, Zod, better-sqlite3, pino, helmet |
| Shared | `@mahilasathi/shared`: Zod schemas and types used by both sides; every API response is validated on the client |
| Data | SQLite with checksummed migrations. H3 (`h3-js`) for corridors and the Pulse. `opening_hours` for hours |
| Providers | Geoapify (geocoding, routing, places, map tiles), OpenStreetMap/Overpass (cameras), Nexconn (chat). Each has a labelled development adapter |
| Tests | Vitest and Supertest (unit, integration, end to end through the HTTP API, security) |

## Architecture

```
mahilaSathiV2/
  shared/            @mahilasathi/shared: Zod schemas, types, constants (compiled to ESM)
  server/            @mahilasathi/server: Express 5 + TypeScript API, serves client/dist in production
    src/config/      env parsing & validation (fails fast with actionable messages)
    src/db/          SQLite connection + checksummed migration runner
    src/middleware/  request ids, error envelope, rate limiting, validation helpers
    src/repositories SQL access (the only place SQL lives)
    src/routes/      HTTP routers (thin; business logic lives in services)
    src/services/    business logic, grouped by domain
    src/cli/         db:migrate / db:status / db:backup, demo:seed / demo:companion, geo/buildNcrBoundaries (dataset pipeline)
    src/jobs/        maintenance (journey delays, expiry, retention, Pulse decay) and the SOS worker (deliveries every 3 s, escalation every 10 s)
  client/            @mahilasathi/client: React 18 + Vite + Tailwind + React Router + TanStack Query + Zustand
    src/components/  ui/ (design system) and layout/ (app shell, bottom nav)
    src/features/    auth, community (chat transports, channel view), journeys, neighbourhoods, profile, routing (map, cards), sos, system
    src/pages/       auth, onboarding, home, plan, journeys, community, sos, profile
    src/services/    typed API client; validates every response with shared schemas
  database/
    migrations/      NNNN_name.sql, applied in order, checksummed, never edited once applied
    geodata/ncr/     NCR district polygons + manifest (source, licence, SHA-256) and curated places
  tests/             unit/ integration/ security/ (Vitest + Supertest)
  scripts/           check-client-secrets.mjs
  Dockerfile, docker-compose.yml   single-container deployment
  docs/              plan, data classification, methodology docs
```

Key decisions:

- **One deployable.** Express serves `/api/*` and the built SPA, with deep-link fallback, from one port.
- **No secrets in the browser.** The client reads no environment variables at all. Vite's `envPrefix` is set to a prefix nothing uses. Public runtime settings come from `GET /api/config`, which returns provider *modes* (`live`, `dev-adapter`, `disabled`) and never key values. A security test builds the bundle with planted secrets and asserts none appear.
- **Honest integrations.** When Geoapify, Nexconn or an OTP provider is not configured, a clearly labelled development adapter stands in, and the UI shows that. Unsupported providers are rejected at startup instead of being faked.
- **Migrations, not ad hoc schema.** Each migration runs in a transaction. If an applied migration is edited or missing, startup stops. Checksums ignore CRLF/LF differences.
- **Privacy in logs.** Request logs record the path only (no query strings). Phone numbers, coordinates, tokens and cookies are redacted.
- **Opaque, revocable sessions.** Sign-in issues a random token in an `HttpOnly; SameSite=Lax` cookie (`Secure` in production). Only its hash is stored, so logout and account deletion revoke it server-side. State-changing requests from foreign origins are rejected.
- **Community via a provider seam.** Neighbourhood channels, journey rooms and Guardian Circles are Nexconn `GroupChannel`s whose membership only our server grants. Plain text goes browser → Nexconn and is checked by our pre-messaging webhook. `MS:` structured messages are validated and sent by our server. Without Nexconn keys, a development relay with the same rules stands in and is labelled in the UI. See [docs/community-architecture.md](docs/community-architecture.md).
- **Night Activity Score, explainable and honest.** Eight factors with the specified weights. Unknown data is excluded and its weight redistributed, never counted as zero; confidence drops with every gap; a score is withheld when too little is known. Places are only counted as open if their mapped hours say so at the time you pass. See [docs/night-activity-score.md](docs/night-activity-score.md).
- **SOS is a durable backend workflow, and it never overstates delivery.** The event, its recipients and every delivery job are written in one transaction, then sent by a server worker (not the browser) with retries, leases and restart recovery. Statuses separate "accepted by a channel" from "confirmed", and a channel that isn't set up is shown as not sent. Escalation rules are the user's own. mahilaSathi does not contact the police or emergency services and says so. See [docs/sos.md](docs/sos.md).
- **Journeys, Walk Together and the Pulse are private by construction.** Guardians see only what the share level allows, and nothing location-related after arrival. Walk Together compares H3 corridors with 300 m trimmed from each end, shows pseudonyms only, and opens a chat only after both people accept. The Community Pulse needs 3 distinct contributors per cell, caps each contributor, decays over time and down-weights new or unreliable accounts. Reports about people stay hidden until a moderator verifies them. See [docs/journeys-walk-together-pulse.md](docs/journeys-walk-together-pulse.md).
- **Geography from polygons, not lists.** NCR membership, state and district come from point-in-polygon against official-constituent district boundaries. See [docs/geography.md](docs/geography.md).

## Requirements

- Node.js 20.11+ (developed on 22; see `.nvmrc`)
- npm 10+

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

The defaults work for local development. See [Environment variables](#environment-variables).

## Development

```bash
npm run dev
```

This runs the shared package watcher, the API on http://localhost:8080 (tsx watch) and Vite on
http://localhost:5173. Vite proxies `/api` to the API. Open http://localhost:5173.

### Signing in locally (development OTP)

With `OTP_PROVIDER=mock`, which is the only provider so far, no SMS is sent. After you enter any valid
Indian mobile number (e.g. `98765 43210`), the sign-in screen shows the 6-digit code in a box labelled
"Development sign-in: no SMS was sent". Codes are random per request, never hardcoded. They expire after
5 minutes and allow 5 attempts. Each number can request a code every 30 s, at most 3 times per 15 minutes.
The server refuses the mock provider in production unless `DEMO_MODE=true`.

## Database

SQLite at `DATABASE_PATH` (default `./data/mahilasathi.db`, resolved from the repository root). The server
applies pending migrations and loads the versioned NCR geography (`database/geodata/ncr`) on startup;
both steps are idempotent. To manage them by hand:

```bash
npm run db:migrate
```

```bash
npm run db:status
```

Take a consistent online backup (safe while the server runs):

```bash
npm run db:backup -- ./backups/mahilasathi.db
```

To change the schema, add a new file `database/migrations/NNNN_description.sql`. Never edit an applied one.

## Production build & start

```bash
npm run build
```

```bash
NODE_ENV=production JWT_SECRET=... ADMIN_TOKEN=... npm start
```

The server listens on `PORT` (default 8080) and serves both the API and the client.

- `GET /api/health` is liveness. It always returns 200 while the process is serving.
- `GET /api/ready` is readiness. It returns 503 if the database is unusable, migrations are pending or NCR geography is not loaded.

## API (so far)

| Area | Endpoints | Auth |
|---|---|---|
| System | `GET /api/health`, `GET /api/ready`, `GET /api/config` | public |
| Auth | `POST /api/auth/send-otp`, `POST /api/auth/verify-otp`, `POST /api/auth/logout`, `GET /api/auth/me` | public / session |
| User | `GET, PATCH, DELETE /api/users/me`, `GET, PATCH /api/users/me/preferences` | session |
| Emergency contacts | `GET, POST /api/users/me/emergency-contacts`, `PATCH, DELETE /api/users/me/emergency-contacts/:id` | session, owner-scoped |
| Geography | `GET /api/geo/search`, `/reverse`, `/resolve` | session (user input; may call a paid provider) |
| Geography | `GET /api/geo/neighbourhoods`, `/districts`, `/coverage`, `/boundaries` | public reference data |
| Community | `GET /api/community/session`, `/channels`, `/channels/:id`, `/channels/:id/members`, `/neighbourhoods`, `/journey-rooms`; `POST /api/community/channels` (journey room), `/channels/:id/join`, `/channels/:id/leave`, `/neighbourhoods/:id/join`, `/channels/:id/updates` (MS:InfraUpdate); `GET, POST /api/community/channels/:id/messages` (development relay only) | session, membership-checked |
| Guardian Circle | `GET, POST /api/circles`, `POST /api/circles/:id/invite`, `POST /api/circles/accept`, `POST /api/circles/:id/accept`, `DELETE /api/circles/:id/invites/:inviteId`, `DELETE /api/circles/:id/members/:userId` | session; non-members get 404 |
| Safety | `GET /api/users/me/blocks`, `POST, DELETE /api/users/:id/block`, `POST /api/moderation/messages/:id/report`, `POST /api/reports` | session |
| Moderation | `GET /api/moderation/queue`, `POST /api/moderation/reports/:id/resolve` | `X-Admin-Token` (disabled without `ADMIN_TOKEN`) |
| Webhook | `POST /api/webhooks/nexconn` | Nexconn signature; only when Nexconn is configured |
| Routes | `POST /api/routes/plan`, `POST /api/routes/compare`, `GET /api/routes/:id`, `GET /api/routes/:id/explanation` | session; plans are owner-only |
| Map tiles | `GET /api/map/tiles/:style/:z/:x/:y.png` (proxied from Geoapify; key stays server-side) | session |
| Journeys | `POST, GET /api/trips`, `GET /api/trips/active`, `GET /api/trips/:id`, `PATCH /api/trips/:id/status`, `POST /api/trips/:id/checkin`, `POST, DELETE /api/trips/:id/share`, `PUT /api/trips/:id/location-sharing`, `POST /api/trips/:id/location` | session; owner-only (others get 404) |
| Guardian view | `GET /api/trips/shared`, `GET /api/trips/shared/:shareId`, `POST /api/trips/shared/:shareId/acknowledge` | session; active guardians of the circle only |
| Walk Together | `POST /api/walk-together/request`, `GET, DELETE /api/walk-together/trips/:tripId`, `GET /api/walk-together/matches`, `POST /api/walk-together/matches/:id/accept`, `/reject`, `/cancel` | session; the two people involved only |
| Community Pulse & reports | `GET /api/community/pulse?lat&lng`, `POST, GET /api/community/reports`, `GET /api/community/reports/mine` | session; aggregated, reporter never shown |
| Report moderation | `GET /api/moderation/community-reports`, `POST /api/moderation/community-reports/:id/review` | `X-Admin-Token` |
| SOS | `POST /api/sos` (idempotent), `GET /api/sos/active`, `GET /api/sos/history`, `GET /api/sos/received`, `GET /api/sos/:id`, `POST /api/sos/:id/acknowledge`, `POST /api/sos/:id/cancel`, `POST /api/sos/:id/location`, `PUT /api/sos/:id/location-sharing`, `GET, PATCH /api/users/me/sos-settings` | session; owner changes, alerted guardians read and respond, everyone else gets 404 |
| Privacy | `GET /api/users/me/export`, `POST /api/users/me/stop-location-sharing`, `DELETE /api/trips/history` | session |
| Push | `GET /api/push/config`, `POST, DELETE /api/push/subscriptions`, `POST /api/push/test` | session; endpoints must be real browser push services |
| Dev SMS outbox | `GET /api/moderation/dev-sms` (only with `SMS_PROVIDER=mock`) | `X-Admin-Token` |
| Audit log | `GET /api/moderation/audit?action=&actorId=&targetType=&targetId=&before=&limit=` | `X-Admin-Token` |
| Moderator screen | `/moderation` in the app: open reports (with pseudonyms and context) and decisions, area-report review, and the audit log with filters | `X-Admin-Token`, entered on the page and held in that tab's memory only |

Request and response shapes are Zod schemas in `shared/src/schemas`. Errors always use
`{ error: { code, message, requestId, details? } }`.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run check:secrets
```

`npm run check:secrets` scans `client/dist` for secret values from `.env` and for server-only variable names. Run it after a build.

Check live provider keys without printing them:

```bash
npm run check:providers
```

Current suites:

- `tests/unit`: config validation, migration runner, geometry (point-in-polygon, holes, distances, areas, simplification), phone normalisation, NCR registry (inside/outside NCR, cross-state, missing neighbourhoods, boundary uncertainty, seeding)
- `tests/integration`: system endpoints, error envelope, headers, CORS, single-deployable serving; OTP auth (limits, lockout, expiry, reuse, hashing, provider failure); sessions (logout, expiry, CSRF); profile, preferences, emergency contacts (cross-user isolation), account deletion; geo search with live/fake/failing providers, resolve, boundaries, coverage; community: two-user messaging, provisioning without duplicates, membership limits, contact-info/rate/duplicate policy, MS:InfraUpdate validation, journey room lifecycle, block (including bypass via a new room), reports, automatic pause, moderator review; Guardian Circle privacy (404 to outsiders), single-use and number-bound invites, expiry, owner/guardian permissions, block separation; Nexconn: request signing, host failover, error codes, token issue under pseudonym, no partial state on provider failure, signed webhook decisions; route planning: cross-state plans, NCR/time/mode validation, no-route vs outage, place-data failure → unknown factors and withheld score, caching with freshness, synthetic labelling, owner-only plans, deletion with the account, Geoapify normalisation, category mapping, tile proxy gating
- `tests/unit/scoring.test.ts`: specified weights, preference re-weighting, weighted score, redistribution of unknown factors, confidence, withholding, Community Pulse cold start, IST opening-hours evaluation (past midnight, 24/7, unknown), pass-by-time evaluation, longest gap, road-class share, turns, explanations, rankings, duplicate-route detection
- `tests/unit/journeys.test.ts`: journey state machine (every allowed and forbidden transition), corridor cells with 300 m trimming, overlap and direction, Pulse decay, 3-contributor threshold, per-contributor cap, expiry, contributor buckets
- `tests/integration/journeys.api.test.ts`:
  - a full journey from start to arrival;
  - guardian views at each share level (no location at `status`, area only at `approximate`, exact point and route at `precise`, nothing location-related after arrival);
  - strangers get 404 everywhere;
  - `MS:JourneyStatus` in the circle chat without coordinates;
  - delay detection with grace, "I'm OK" resume, escalation (needs a share; can't be cancelled);
  - expiry of journeys never started, and retention (12 h guardian view, 24 h live points, 30-day endpoints);
  - owner-only routes;
  - Walk Together: pseudonym-only matching, opposite direction and blocks excluded, mutual acceptance before the chat opens, contact details blocked in the pair chat, stale-withdraw protection, withdrawal when a journey ends, short and driving journeys refused;
  - reports: labels, duplicates, outside-NCR, hidden allegations, token-protected verification;
  - Pulse: only after 3 contributors, signals only on the trimmed corridor, used in route scoring;
  - account deletion removes journeys, reports and signals
- `tests/integration/demo.test.ts`: demo data refused without `DEMO_MODE`; idempotent fictional accounts; demo labels on members, reports and SOS ("DEMO, not a real emergency"); demo activity kept out of the Pulse; the walking companion matches
- `tests/integration/demoScript.e2e.test.ts`: the full two-window demo script, all three cross-state pairs, and a new user from sign-up to a completed journey
- `tests/unit/sos.test.ts`: SOS state machine, retry/backoff bounds, request and settings validation
- `tests/integration/sos.api.test.ts`:
  - one durable SOS per activation (same key, or while active, returns the same SOS);
  - circle alert accepted vs in-app delivery confirmed only when the guardian's app loads it;
  - `MS:SosAlert` without coordinates; outsiders get 404 and guardians can't modify;
  - acknowledgement prevents escalation; escalation to contacts when nobody responds; SMS `unavailable` when not set up, never faked;
  - SMS retries with 10/30 s backoff, give-up after 5 tries with an attempt log, permanent errors not retried;
  - chat outage retried; **recovery of a job left mid-send by a crash, after a restart on the same database**;
  - location only at the chosen detail, immediate stop, nothing stored at `none`;
  - settings validation, data export (own data only), stop-all-sharing, clear history, token-protected audit log with injection-safe filters, deletion with the account
- `tests/security`:
  - the production bundle contains no server secrets;
  - `authorization.test.ts`, one place for the specification's list: private trips, other people's circles, block bypass through a new channel, no coordinates in any shared channel or public endpoint, SOS changes by others, and a burst of 5 concurrent activations creating one incident

## Environment variables

All variables are read by the **server** only. See [.env.example](.env.example) for the annotated list.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Default 8080 |
| `NODE_ENV` | no | `development` (default), `test`, `production` |
| `LOG_LEVEL` | no | Default `info` (`silent` in test) |
| `CORS_ORIGINS` | no | Comma-separated origins, e.g. the Vite dev server |
| `DATABASE_PATH` | no | Default `./data/mahilasathi.db`; `:memory:` for throwaway runs |
| `JWT_SECRET` | production | ≥ 32 chars. In development an ephemeral secret is generated, with a warning |
| `ADMIN_TOKEN` | production | ≥ 32 chars |
| `GEOAPIFY_API_KEY` | no | Enables street-level place search, routing, place data and map tiles. Without it, search uses the local NCR gazetteer and routes are labelled synthetic straight lines |
| `NEXCONN_APP_KEY` / `NEXCONN_APP_SECRET` | no | Set both or neither. The secret never leaves the server. Without them, community chat uses the labelled development relay |
| `NEXCONN_AREA` | no | `sg` (default) or `na`; selects the documented primary/backup Server API hosts |
| `NEXCONN_API_HOST` | no | Overrides the Server API host |
| `OTP_PROVIDER` | no | Only `mock` exists today. Production refuses `mock` unless `DEMO_MODE=true` |
| `PUSH_PROVIDER` | no | `none` (default) or `webpush` (Web Push standard). With `webpush`, set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npx web-push generate-vapid-keys`). `VAPID_SUBJECT` (a `mailto:` or `https:` contact) is optional |
| `SMS_PROVIDER` | no | SMS to emergency contacts during an SOS. `none` (default): nothing is sent and SOS screens say so. `mock`: a labelled development adapter that records the text locally and sends nothing (refused in production unless `DEMO_MODE=true`). No real SMS provider is integrated |
| `DEMO_MODE` | no | Turns on demo mode: `npm run demo:seed` and `demo:companion` work, the sign-in screen lists the demo accounts, the header shows "Demo mode", and the mock OTP/SMS adapters are allowed in production. Required in production until a real OTP provider exists. Every SOS is then labelled a demo, whoever raises it |
| `DEMO_AUTOSEED` | no | With `DEMO_MODE=true`, creates the demo accounts at every start. For hosts whose disk resets (Render free). Default `false` |
| `TRUST_PROXY` | no | Production only: reverse-proxy hops in front of the server, used for per-IP rate limits. Default `1` |
| `COMMUNITY_MODERATION_ENABLED` | no | Default `true` |

## Privacy & security baseline (Phase 0)

- Helmet security headers with a strict CSP, `Referrer-Policy`, and a `Permissions-Policy` limiting geolocation to the app itself.
- CORS uses an explicit allow-list.
- JSON bodies are capped at 100 kB. Malformed JSON gets 400 and oversized bodies get 413.
- The API is rate-limited per IP (health/ready exempt).
- Every response carries an `X-Request-Id`. Errors use one envelope (`{ error: { code, message, requestId } }`) and never include stack traces.
- `audit_events` is append-only, enforced by a database trigger.
- Data sensitivity per table is documented in [docs/data-classification.md](docs/data-classification.md).

## Phase 0 evidence

Recorded on 2026-11-12, Node 22.23, Windows 11:

- `npm run typecheck` passes for shared, server, client and tests.
- The production build succeeds. The client bundle is about 332 kB JS (101 kB gzip) plus 22 kB CSS.
- 35 tests pass: config validation, the migration runner (ordering, idempotency, rollback, checksum tamper, CRLF, newer-DB detection), system endpoints, the error envelope, headers, CORS, and single-deployable serving.
- **Bundle secrets.** The automated test could not run on the development machine; see Troubleshooting. The same check was run by hand. The client was built with `JWT_SECRET`, `ADMIN_TOKEN`, `GEOAPIFY_API_KEY`, `NEXCONN_APP_SECRET` and `VITE_GEOAPIFY_API_KEY` set to planted values, and the scanner found none of them in the output. A positive control confirmed the scanner does find known strings.
- **Production server.** `NODE_ENV=production` with `DEMO_MODE=true` was started on one port. Checked: `/api/health` 200, `/api/ready` 200 (1 applied, 0 pending), `/api/config` with modes only, `/` and `/journeys` serving the SPA, hashed assets with `immutable` caching, `/api/nope` returning a JSON 404, and CSP and Permissions-Policy present. The browser console showed no errors in light or dark mode at 375 px.

## Phase 1 evidence

Recorded on 2026-11-12, Node 22.23, Windows 11:

- `npm run typecheck` passes for shared, server, client and tests. The production build succeeds: 376 kB JS (112 kB gzip) plus 24 kB CSS.
- **115 tests pass** (112 unit/integration plus 3 security). The bundle-secrets test now runs automatically and passes.
- **NCR data.** All 34 constituent polygons were matched from geoBoundaries IND ADM2 (2021, ODbL). Per-state areas are within 1.6% of the official NCRPB figures. All 42 curated neighbourhoods and 29 cities fall inside their declared states.
- **Browser walkthrough** of the production build, in demo mode at 375 px:
  - Welcome → sign-in with the development code (clearly labelled) → onboarding: display name with pseudonym, an emergency contact, home area by search ("cyber" → Cyber City, Gurugram, Haryana, coverage "not assessed yet") and privacy defaults → Home.
  - On Profile: home area changed by list to a district with no mapped neighbourhood (Jind, offered as "district only"), then sign out → protected pages redirect to Welcome.
- **Log check.** The server log from that session (43 lines) contains no phone numbers, OTP codes, coordinates or session cookies. It records paths only.

## Phase 2 evidence

Recorded on 2026-11-12, Node 22.23, Windows 11:

- **Research.** Every Nexconn call was checked against the official docs (SDK, Server API, signing, pre-messaging webhook) and the `.d.ts` shipped with `@nexconn/chat@26.2.1`. The client typechecks against the real SDK types.
- **144 tests pass** (141 unit/integration plus 3 security). The client bundle contains no secrets. The Nexconn SDK is code-split (978 kB) and loads only in Nexconn mode.
- **Two-user demo** on the production build, demo mode, development relay. "Lotus" was in the browser at 375 px and "Jasmine" used the API with her own session:
  - Lotus provisioned the Saket channel and Jasmine joined the same one (2 members, no duplicate).
  - Messages flowed both ways. Jasmine's live message appeared without a refresh. Jasmine was shown only by her pseudonym.
  - Lotus's message containing a phone number was refused, with an explanation and Retry/Discard. Her `MS:InfraUpdate` rendered as "Community reported · Not verified".
  - Lotus created a circle and a number-bound invite. Jasmine accepted, appeared by display name inside the circle, and could share a number there. Reusing the code failed.
  - Lotus reported then blocked Jasmine. Jasmine's messages disappeared, she was removed from the circle (403 on its chat), the report reached the moderator queue with a server snapshot, and the queue refused requests without the token.
- **Found and fixed during the demo:**
  - A crash when sending: an effect implicitly returned the Promise that current Chromium returns from `scrollIntoView`.
  - The actions panel keeping a previous message's state.
  - Badge wrapping, and home neighbourhood ordering.
- **Log check.** The server log (129 lines) contains no phone numbers, message text, invite codes or cookies.

## Phase 3 evidence

Recorded on 2026-11-13, Node 22.23, Windows 11, with live Geoapify and Nexconn keys:

- **177 tests pass** (174 unit/integration plus 3 security). The client bundle contains no secrets. MapLibre and the Nexconn SDK load as separate chunks; the main bundle is 443 kB.
- **Live API probes** shaped the design:
  - routes carry `road_class` per step;
  - only 12% of mapped places in Saket have opening hours;
  - transit must be queried separately;
  - Overpass was down (502 and timeouts), which exercised the "unknown, not zero" path.
- **Live NCR scenarios** (22:30 IST, cab), all scored with medium confidence:
  - Cyber City → Saket: **62**, crossing Haryana → Delhi.
  - Noida Sector 62 → Connaught Place: **60 / 60**, crossing UP → Delhi.
  - Faridabad Sector 15 → Cyber City: **49 / 48**, with a 7.6 km longest stretch through the Aravallis.
  - Walking from Malviya Nagar metro to Saket: **66**.
  - An unroutable walking pair gets a clear "no walking route" message. Points outside NCR are rejected.
- **Bugs found live and fixed:**
  - A shop whose name is a number made one grid cell's place data fail, which withheld a score. Places are now validated one by one.
  - "No path" answers were reported as outages.
  - The camera timeout delayed every plan; it now backs off for 10 minutes.
- **Browser walkthrough** of the production build at 375 px, as a new user at 00:13 IST:
  - Searching "Sector 62 Noida" and "Connaught Place" used live Geoapify results.
  - Three distinct routes scored 58, 53 and 52, drawn on the proxied map with place markers.
  - The full factor breakdown shows sources, confidence and data timestamps; the camera factor shows "Not counted".
  - The Fastest/Balanced tabs re-order the routes. No console errors.

## Phase 4 evidence

Recorded on 2026-11-13, Node 22.23, Windows 11, with live Geoapify and Nexconn keys:

- **198 tests pass** (195 unit/integration plus 3 security). `npm run typecheck` passes for shared, server, client and tests. The production build succeeds, and the client bundle contains no secrets.
- **Migration 0006** rebuilds `community_channels` to add the `walk_together` kind. SQLite can't alter a CHECK constraint, so the migrator gained a `-- migrate:foreign-keys-off` directive that runs SQLite's table-rebuild procedure and verifies `PRAGMA foreign_key_check` before committing. It is tested for kept child rows and for rollback.
- **Live walkthrough** at 00:47–00:55 IST on the production build. "Asha" used the browser; her guardian "Meera" and two other walkers used the API with their own sessions. Meera also used a second browser tab for the guardian screens.
  - **Planning and starting.** Asha planned a live Geoapify walking route, Green Park Market → Select Citywalk (4.6 km, score 43), and started it from the route card. It began private, as her Profile default says. She then shared it with her circle at *Approximate* and started the journey.
  - **Approximate sharing.** Meera's guardian view showed status and the destination area "Saket", with no route and no location.
  - **Live location.** The in-app browser denies geolocation, and the page said so ("nothing is being shared"). One clearly labelled test point (a vertex of Asha's route) was then posted through Asha's session. Meera saw only "South Delhi" and 46% progress. After Asha switched to *Precise*, Meera saw the exact point and the route on the live map.
  - **Strangers.** A walker matched with Asha, but not in her circle, got 404 on the shared journey.
  - **Walk Together.** A second walker (planning nearby endpoints) asked for company. Asha's request matched them at 83% overlap via "Hauz Khas, South Delhi, Saket", showing only their pseudonym. After both accepted, a live Nexconn group "Walk Together · Hauz Khas" opened with 2 members.
  - **Check-in and arrival.** Meera acknowledged; Asha's page then showed "Meera is keeping an eye on this journey". Asha checked in, then arrived with "Comfortable". Meera's view switched to *Arrived* with no location or route. Asha's Walk Together request closed. Six trimmed-corridor cells received trust-halved signals, which stay "insufficient" with one contributor.
  - **Reports.** A labelled test report ("Poorly lit stretch") showed as *Community reported* at the area level, and the Pulse said "Not enough community data yet".
- **Found and fixed during the walkthrough:**
  - A "withdraw" tapped on a screen that still showed "waiting" cancelled a pair formed seconds earlier. Cancel now carries the expected state, and the server answers 409 if it changed. A test covers this.
  - The live-location switch had no accessible name.
  - Geoapify can't route *walks* from some metro-gate points (no path from footway nodes). The app reports this clearly. Routing worked from street-level places.
- **Not confirmed live:** chat history in the Walk Together chat failed to load in the browser, the same Nexconn issue as in Phase 2. A message sent there could not be seen. The server's `MS:JourneyStatus` sends to Nexconn raised no errors, but receipt was not observed. The same flows pass end to end on the development relay in the tests.
- **Log check.** The server log from the walkthrough (1,919 lines) contains no phone numbers, coordinates, OTP codes, session cookies or report text.

## Phase 5 evidence

Recorded on 2026-11-13, Node 22.23, Windows 11, with live Geoapify and Nexconn keys and `SMS_PROVIDER=mock`:

- **215 tests pass** (210 unit/integration plus 5 security). `npm run typecheck` passes, the production build succeeds, and `npm run check:secrets` finds no secrets in the bundle.
- **Live walkthrough.** "Asha" used the browser. Her guardian "Meera" used a second browser tab. The emergency contact was a test number. Asha's rule: message contacts if nobody responds within 1 minute.
  - **Before activating.** The SOS screen listed exactly who would be alerted and how. It said SMS was simulated on this server.
  - **Activating.** A quick tap sent nothing. A 1.8-second hold (keyboard) raised the SOS.
  - **First statuses.** The circle alert was accepted by **live Nexconn** and shown as "posted; delivery not confirmed". Meera's in-app alert showed "not opened yet". The contact showed "will be messaged at 4:10 pm if no guardian responds".
  - **Location.** The browser denies geolocation, and the screen said so. One labelled test point was posted through Asha's session.
  - **Meera's app.** Opening the app showed a red "SOS from Asha" banner on every screen. Asha's view switched Meera to "Seen in their app at 4:09 pm", the only status that claims delivery.
  - **Escalation.** With no response, the worker escalated at 10:40:41, 5 s after it was due. The circle got a reminder. The contact's SMS was recorded by the development adapter (area plus a precise map link, as the rules allow) and labelled "recorded only, no real SMS was sent".
  - **Response.** Meera opened the alert (area, accuracy and an exact-position link) and tapped "I'm on my way". Asha's screen showed it within one refresh.
  - **Ending.** Asha ended the SOS with "I'm safe now" (confirm step). The circle and the contact who had been reached each got an "ended" notice. Meera's view showed the outcome and no location.
  - **Records.** The audit trail shows `sos.settings_updated`, `sos.activated`, `sos.escalated`, `sos.acknowledged` and `sos.ended`.
- **Log check.** The server log (1,125 lines) contains no phone numbers, coordinates, OTP codes, cookies or SMS text.
- **Found and fixed:**
  - Recipients and circle members were ordered by a timestamp that can tie, which made guardian order arbitrary. It is now deterministic.
  - The "SOS ended" SMS didn't say it came from mahilaSathi.
  - The location error wording contradicted a shown position.
- **Not run live:** the crash-and-restart recovery and the provider-outage retries. They are covered by integration tests (simulated hang, then a new app on the same database; failing chat and SMS providers).

## Provider setup

### Geoapify (places, routing, map tiles)

1. Create a project at geoapify.com and copy its API key.
2. Set `GEOAPIFY_API_KEY` in `.env`.
3. Run `npm run check:providers`. It tests the key without printing it.

The key stays on the server:
- the browser never sees it;
- map tiles are proxied through `/api/map/tiles`.

Without a key:
- place search uses the local NCR gazetteer;
- routes are labelled synthetic straight lines;
- the map draws without a base map.

Check Geoapify's terms for tile proxying and caching before a public launch.

### Nexconn (community chat)

See [docs/community-architecture.md](docs/community-architecture.md#setting-up-nexconn). In short:
1. Set `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET` and `NEXCONN_AREA`.
2. Optionally, point the group pre-messaging webhook at `https://<domain>/api/webhooks/nexconn`.
3. Run `npm run check:providers`.

The browser only receives the app key and a per-user token, never the secret. Without keys, a labelled development relay with the same rules is used.

### NCR geographic dataset

- **Source:** district polygons from **geoBoundaries IND ADM2, commit `9469f09` (2021, ODbL)**, filtered to the NCR constituent districts listed by the NCR Planning Board.
- **Version:** the dataset is `2021-9469f09-s30m` (simplified to 30 m). `/api/ready` reports the version in use.
- **Reproducing it:** the pipeline is `server/src/cli/geo/buildNcrBoundaries.ts`. See [docs/geography.md](docs/geography.md).

## Deployment

**Free public demo link:** [docs/deploy-render.md](docs/deploy-render.md) deploys to Render's free plan with
`render.yaml`. The demo accounts are recreated on every start (`DEMO_AUTOSEED=true`), because the free plan's
disk resets.

The app ships as **one container**: Express serves the API and the built client on one port. It uses SQLite on a persistent volume.

```bash
docker compose up --build
```

This builds the image from the `Dockerfile`:
- **Image:** a multi-stage build that runs as the unprivileged `node` user, with a health check on `/api/health`.
- **Data:** stored at `/data/mahilasathi.db` in the `mahilasathi-data` volume.
- **Port:** 8080.

On startup it applies migrations and loads the NCR dataset.

**Required settings in production** (the server refuses to start without them):
- `JWT_SECRET` and `ADMIN_TOKEN`, each at least 32 random characters;
- `DEMO_MODE=true`, until a real OTP provider exists;
- `CORS_ORIGINS`, if the client is served from another origin.

**On a platform (Render, Railway, Fly.io and others):**
- deploy the Dockerfile and attach a **persistent disk at `/data`**;
- run **exactly one instance**, because SQLite and the in-memory rate limits are single-instance;
- put the app behind HTTPS (`trust proxy` is one proxy hop; set `TRUST_PROXY` if there are more);
- point health checks at `/api/health` (liveness) and `/api/ready` (database, migrations and geography).

**Backups.** Run `npm run db:backup` inside the container on a schedule, or snapshot the volume.

**Webhook.** The Nexconn pre-messaging webhook needs the public HTTPS URL.

## Documentation

| Topic | Document |
|---|---|
| Plan and inspection notes | [docs/00-current-state-and-plan.md](docs/00-current-state-and-plan.md) |
| Night Activity Score methodology | [docs/night-activity-score.md](docs/night-activity-score.md) |
| NCR geography, data coverage methodology | [docs/geography.md](docs/geography.md) |
| Corridor matching (Walk Together), journeys, Community Pulse, reports | [docs/journeys-walk-together-pulse.md](docs/journeys-walk-together-pulse.md) |
| SOS state machine, delivery and escalation | [docs/sos.md](docs/sos.md) |
| Location privacy rules | [docs/location-privacy.md](docs/location-privacy.md) |
| Nexconn channel architecture | [docs/community-architecture.md](docs/community-architecture.md) |
| Data classification and retention | [docs/data-classification.md](docs/data-classification.md) |
| Free public demo on Render | [docs/deploy-render.md](docs/deploy-render.md) |

## Phase 6 evidence

Recorded on 2026-11-13, Node 22.23, Windows 11:

- **222 tests pass** (217 unit/integration plus 5 security). `npm run typecheck` passes, the production build succeeds, and `npm run check:secrets` finds no secrets.
- **End-to-end test of the demo script** (`tests/integration/demoScript.e2e.test.ts`). It runs every step of both windows through the HTTP API: seeding, the cross-state plan, comparison, journey, sharing, Walk Together, neighbourhood update, acknowledgement, community updates, report, block, demo SOS and completion. It checks all three state pairs (Haryana–Delhi, Uttar Pradesh–Delhi, Haryana–Uttar Pradesh). A second test takes a brand-new, non-demo user from sign-up to a completed journey.
- **Bundle.** The initial load is now 92 kB of app code plus a 301 kB vendor chunk (119 kB gzip together, down from 148 kB). Each screen loads on first visit. SOS and its alert screen stay in the main bundle on purpose, so they never wait for a download.
- **Live walkthrough in production mode** (`NODE_ENV=production`, live Geoapify and Nexconn, `SMS_PROVIDER=mock`). Lotus used a 375 px window and Jasmine a second tab:
  - Demo sign-in, then a cross-state cab plan Cyber City → Saket (score 62, live).
  - A walk Green Park Market → Select Citywalk, shared at *Approximate*, matched 100% with Neem-08 started by `npm run demo:companion`, and a live Nexconn pair chat once both accepted.
  - A neighbourhood update. Jasmine viewed the shared journey, acknowledged it, and read the circle's journey updates (marked "[Demo]") from Nexconn history.
  - **Person-to-person chat over live Nexconn**: Jasmine's browser sent a message, and it appeared in Lotus's.
  - Jasmine reported and then blocked Neem-08 in the Saket channel. Lotus raised a demo SOS (Jasmine's banner: "DEMO SOS (not real)"), ended it, and completed the journey.
  - Lotus's completed walk added **0** Pulse signals. Re-running the seed was idempotent.
- **Found and fixed during this phase:**
  - **Nexconn history** (open since Phase 2): the client asked for history before the SDK had connected (code 30002). It now waits for the connection, and history loads after a reload on live Nexconn.
  - **SOS hold timing** depended on animation frames, which pause in a background tab. A timer now decides; frames only draw the ring.
  - **Header at 375 px:** the theme button was squeezed to 20 px and pushed off-screen.
  - **Demo display names** contained characters the name rules reject.
  - **The report/block panel** opened off-screen without focus. It now scrolls into view and takes focus.
  - **"1 members".**
- **Accessibility and layout sweep** of 9 screens at 375 px:
  - no unnamed buttons or links, no unlabelled fields, no duplicate ids, and exactly one `h1` per screen;
  - no horizontal overflow at 320 px, 375 px or 1280 px;
  - reduced-motion settings are respected.
- **Map interactions.** Tapping a route selects it. Tapping a place shows its name, type and whether it's open when you pass (rendered as text, never HTML).
- **Docker, verified end to end** (Docker 29.5.2; the VM had only ~646 MB of memory):
  - **First build:** ran out of memory while bundling the client, because Node defaults to a ~320 MB heap on a machine that small. The Dockerfile now raises the heap for the build stage only. The rebuild bundled the client in 2 min 10 s. A separate stage now installs only the server's production dependencies, because the client ships pre-built. That cut `node_modules` from 180 MB to 60 MB and the image from 553 MB to **407 MB**. The slim image passed the same checks, plus a cross-state route plan, a journey start, and an SOS delivered by the background worker.
  - **Startup:** the container started in production mode in under 0.5 s. It applied all 8 migrations to a fresh volume, loaded the NCR dataset, and passed Docker's `HEALTHCHECK`.
  - **Readiness:** `/api/ready` returned 200. Without keys, providers showed as labelled adapters. The SPA deep links, manifest and JSON 404 all worked.
  - **Security:** it runs as the non-root `node` user, and no `.env` is in the image.
  - **Demo seeding** ran inside the container.
  - **Restart:** after a container restart, Lotus-42 signed in as an existing user (session cookie with `Secure`), and her Guardian Circle was intact.
  - **Backup:** `migrate.js backup` made an online backup that passed `PRAGMA integrity_check`.
  - **On this Windows machine, Docker Desktop itself wouldn't start at first.** It was blocked by stale socket files from an earlier Docker crash, which the app can't touch. Moving `%LOCALAPPDATA%Docker
un` aside fixed it.
- **Log check.** The production-mode server log (518 lines) contains no phone numbers, coordinates, OTP codes, cookies or message text.

## Hackathon readiness (local development)

Verified on 2026-11-16 with `npm run dev` (Vite on 5173, API on 8080), live Geoapify, Nexconn and Web Push, and the labelled OTP/SMS development adapters:

- **One-command data:** `npm run demo:reset` gives a fresh database. It creates the demo accounts and circle, a demo update, and live data coverage for their home areas.
- **Data coverage:**
  - `npm run coverage:assess` assessed all 42 curated neighbourhoods from live place data: 5 medium, 37 low. Few mapped places in NCR list opening hours, which matches the Phase 3 findings.
  - Home shows the result with its counts, for example "Cyber City: low, 54 places within 1.2 km, 7% with opening hours, 14 transit stops".
- **Web Push, end to end in a real browser:**
  - A headless Microsoft Edge with a throwaway profile subscribed through the app's own service worker and the live Microsoft push service.
  - A demo SOS from Lotus-42 then showed "DEMO (not real): SOS from Lotus Demo" in that browser, linking to the alert.
  - Journey updates and Walk Together matches use the same path and follow each person's notification settings (covered by tests).
  - The Claude desktop app's embedded browser can't run service workers, and the Profile card now says so instead of hanging.
- **Chat safety without the webhook:** in a live Nexconn channel, a message with a phone number was blocked before sending (the same rule as the server), the text kept for editing, and a normal message then went through.
- **SOS escalation:** with no guardian response after 2 minutes, the circle got a reminder over Nexconn. The emergency contact's SMS was recorded by the development adapter, shown in Moderation → SMS outbox.
- **Routing:** Noida Sector 62 → Connaught Place returned 2 live routes (score 59, medium confidence, Uttar Pradesh → Delhi), and a journey ran CREATED → ACTIVE → ARRIVED.
- **Tests and build:** 233 tests pass, the build succeeds, and the bundle secret scan is clean. On this machine, the build and the bundle test need the dev server stopped (and Docker Desktop closed) to have enough memory.

## Moderator screen

Open `/moderation` (also linked at the bottom of Profile) and enter the server's `ADMIN_TOKEN`. The token is kept only in that tab's memory, never in storage or the URL, so reloading the tab locks the tools again. The screen has three tabs:

- **Reports:**
  - Each message or user report shows the reported person's pseudonym, any active suspension, and how many reports are open against them, plus the reporter's pseudonym, the channel, and the message.
  - The message is labelled either as the server's copy or as the reporter's copy, because the server can't read Nexconn messages.
  - Decisions: dismiss, warn (recorded only; the person isn't notified), remove from the channel, or suspend for 1–30 days. Each needs a reason.
  - Dismissing reports lifts an automatic suspension that those reports caused.
- **Area reports:** verify or reject community reports, with a note. Reports about people stay hidden until verified.
- **Audit log:** newest first, filterable by area (moderation, SOS, journeys, privacy and more), with "load older".

The moderation endpoints never send phone numbers or internal user ids to this screen. A test checks this.

## Troubleshooting

**`FATAL ERROR: ... JavaScript heap out of memory` or `Fatal process out of memory: Zone`.**
These can appear even when RAM looks free. On Windows they mean the system *commit limit* is nearly
exhausted, which usually happens because there is no page file and large services are running. Check with
`Get-CimInstance Win32_OperatingSystem | Select FreeVirtualMemory`. Either enable a system-managed page
file, stop heavy background services, or cap Node's memory:

```bash
NODE_OPTIONS="--max-semi-space-size=4 --max-old-space-size=512" npx vitest run --poolOptions.forks.singleFork
```

The bundle-secrets test runs a full Vite build inside the test process tree. It needs roughly 1 GB of free
commit headroom.

## Known limitations

- **SMS.** No real SMS provider is integrated, for OTP or SOS. `OTP_PROVIDER` and `SMS_PROVIDER` accept only `mock` (plus `none` for SMS), which production allows only with `DEMO_MODE=true`. A real provider (with DLT registration in India) is needed before a public launch.
  - With `SMS_PROVIDER=none`, an SOS reaches the Guardian Circle in the app and circle chat only. Emergency contacts are shown as "not sent", and the user is offered one-tap calls to them.
  - There are no SMS delivery receipts, so SMS is never shown as delivered.
- **Neighbourhoods** are curated approximate circles, not official locality boundaries. Areas without one resolve to their district.
- **Charkhi Dadri** sits inside the Bhiwani polygon in the source data. **Alwar** is the pre-2023 district. See [docs/geography.md](docs/geography.md).
- **Area coverage** is assessed for the 42 curated neighbourhoods from live place data. Districts stay "not assessed yet". See [docs/geography.md](docs/geography.md#data-coverage).
- **Route planning:**
  - Only cab/drive and walking. Public-transit routing and night schedules are not integrated, so transit stops count as present but not verified as running.
  - The first plan in a new area takes 10–20 s while place data is fetched. Repeats are cached.
  - Mapped cameras depend on public Overpass servers, which were unavailable during testing.
  - Map tiles are proxied from Geoapify. Check their terms before production.
- **Nexconn pre-messaging webhook** needs a public URL and the Chat Free or Pro plan, and Nexconn delivers unchecked if the webhook times out. Until it is reachable, contact-info rules for browser-sent text are enforced only in the development relay.
- **Blocking with Nexconn** hides blocked senders on the client in group channels. Group channels can't filter per recipient on the server.
- **Moderation** uses one shared admin token, not individual moderator accounts, so the audit log records "admin" rather than which moderator acted. Message rate limits are kept in memory (single instance).
- **Journeys:**
  - Live location is sent only while the journey page is open in the browser. There is no background tracking on the web.
  - Guardians are notified in the circle chat and on the Journeys page. Push notifications are not built.
  - Delay alerts depend on the server running the minute job.
- **Walk Together** matches only people who are looking at the same time. There is no queue for later.
- **Community Pulse** starts empty. Real values need several people walking the same corridors. Deleted accounts' signals leave the aggregates at the next hourly recompute.
- **SOS:**
  - No police or emergency-service integration exists. Screens say so and offer a call to 112.
  - Push notifications reach guardians who turned them on. They need Chrome, Edge, Firefox, or an installed web app; embedded browsers (such as the Claude desktop app's pane) can't subscribe. In a browser without push, the app shows a system notification for a new SOS while it's open in a background tab, and the banner while it's in front.
  - The browser sends location only while the SOS screen is open.
  - The home-screen shortcut needs the app to be installed as a web app.
- **Dependency advisories** (`npm audit --omit=dev`) are open for maplibre-gl, react-router and zod. All three fixes are major-version upgrades, deferred for now. Exposure is low here:
  - **maplibre-gl:** the flaw is an HTML-sanitizer bypass, and map popups use plain text, never HTML.
  - **react-router:** an open redirect, but every link target is an app path we build; the other advisory is for server rendering, which isn't used.
  - **zod:** a memory issue with oversized collections, but request bodies are capped at 100 KB.
- **Single instance only:** SQLite and the in-memory rate limits mean one server process.
- **No end-to-end browser test suite** (e.g. Playwright). The demo script is covered through the HTTP API and was walked through by hand in a browser.
- **Not built:** a real SMS/OTP provider, and public-transit routing.
