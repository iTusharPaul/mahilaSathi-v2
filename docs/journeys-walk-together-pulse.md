# Journeys, Walk Together and Community Pulse

Phase 4. This explains how each feature works, what each person can see, and the parameters chosen. The
code is the source of truth: `server/src/services/journeys/` and `server/src/services/pulse/`.

## Journeys

A journey is created from a route in the traveller's **own** route plan. Another user's route id gets a 404.
The chosen route geometry is copied into the journey, because plans are purged after 24 hours. A user has at
most one open journey at a time.

### State machine

```
CREATED ──start──▶ ACTIVE ──arrive──▶ ARRIVED
   │                │  ▲
   │ cancel         │  │ "I'm OK" (+15 min)
   ▼                ▼  │
CANCELLED ◀─cancel─ DELAYED ──arrive──▶ ARRIVED
                    │
ACTIVE/DELAYED ──alert circle──▶ ESCALATED ──arrive──▶ ARRIVED
```

- Allowed transitions are defined once in `shared/src/schemas/journeys.ts` (`TRIP_TRANSITIONS`) and
  enforced on the server.
- Updates are guarded by the current status (`UPDATE … WHERE status = ?`), so two racing requests can't
  both apply.
- Clients can request `ACTIVE`, `ARRIVED`, `CANCELLED` and `ESCALATED`. Only the server sets `DELAYED`.
- An escalated journey cannot be cancelled. It ends only with "I've arrived", so a coerced "cancel" can't
  silence an alert.
- `ESCALATED` notifies the Guardian Circle and points them to 112. **No emergency service is contacted.**
  The SOS flow is Phase 5.

| Parameter | Value | Why |
|---|---|---|
| Check-in interval | min(15 min, half the planned duration), at least 2 min | Frequent enough to matter on short walks without nagging on long rides |
| Delay threshold | expected arrival + max(10 min, 25% of the planned duration) | Routing estimates are rough. A fixed grace alone is too tight for long journeys |
| "I'm OK" while delayed | resumes `ACTIVE`, with expected arrival pushed back 15 min | Avoids a fresh alert a minute later |
| Never-started journeys | cancelled 2 h after the departure time | Keeps "one open journey" from blocking the user |
| Delay job | every minute | Database-driven, so it survives restarts |

### Sharing with a Guardian Circle

A journey is private unless shared. Without an explicit choice, the Profile setting "location sharing
default" decides: `off` keeps it private, and the guardian options share at that level. Guardians must be
**active guardian members** of the traveller's circle. Everyone else gets a 404.

| Level | Guardian sees while the journey is open | After it ends |
|---|---|---|
| `status` | Status, destination **area name**, start, expected arrival, last check-in. No location | Final status for 12 h |
| `approximate` | Plus, if live location is on, the **area name** of the latest point and progress % along the route | Final status only |
| `precise` | Plus the route geometry and the exact latest point | Final status only |

**Live location** is a separate per-journey switch. It is only possible with an `approximate` or `precise`
share, and it is never on by default.
- The browser sends a point at most every 30 s, and only while the journey page is open. There is no
  background tracking on the web.
- The server ignores points less than 10 s apart and keeps only what the latest-point view needs.
- Turning the switch off deletes stored points immediately.
- Arrival or cancellation turns it off. Remaining points are purged 24 h after the journey ends.
- Exact origin, destination and their labels are cleared 30 days after the journey ends.

**Notifications.** On create (if shared), start, check-in, delay, alert, arrival and cancellation, the server
posts an `MS:JourneyStatus` message into the circle chat as the system user. It contains a status and short
text, never coordinates. Delivery is best effort: a chat outage never blocks a journey transition. Guardians
also see everything on Journeys → "Shared with me". Push notifications are not built yet.

## Walk Together

**Corridor identity.** Each journey's route is sampled every 100 m and mapped to H3 resolution-8 cells
(hexagons with ~460 m edges, ~0.7 km²). **300 m is trimmed from each end first**, so a corridor never
contains the exact start or end. Corridors cross city and state lines naturally, because H3 has no
administrative boundaries. A route too short to keep two cells after trimming cannot be matched, and the
user is told why.

**Matching.** Two open requests are proposed to each other when all of these hold:
- both are walking;
- their time windows overlap (each window starts at departure and lasts the 10–45 min the walker is
  willing to wait);
- they share at least **40% of the shorter corridor**;
- they travel in the **same direction** (shared cells visited in the same order, by pairwise order
  agreement);
- neither has blocked the other, and neither is suspended.

**What each person sees** before anyone accepts:
- the other person's pseudonym (never a name or number);
- the overlap %;
- up to three area names from the shared cells;
- the other person's time window.

Nobody sees the other's route, start, destination or location.

**Mutual consent.**
- Each person accepts separately. One acceptance changes nothing for the other except a "they accepted"
  badge.
- When both have accepted, a private two-person `walk_together` chat opens.
- The usual community rules apply in that chat, so phone numbers, addresses and exact locations are
  blocked. Members can block, report and leave.
- Once a pair forms, other pending proposals for both people are withdrawn.
- Either person can leave, which archives the chat for both.
- The chat closes one hour after the later window ends.
- A "withdraw" sent from an out-of-date screen is refused (409) rather than breaking up a pair that has
  just formed.

## Community Pulse

**Signals** are stored per H3 cell with their contributor, so they can be removed if the account is deleted.
They are never exposed directly.

| Signal | Cells | Polarity × base weight | Half-life | Lifetime |
|---|---|---|---|---|
| Journey completed (arrived) | trimmed corridor | +0.3 | 14 d | 30 d |
| Route feedback at arrival | trimmed corridor | ±0.5 (comfortable / uneasy) | 14 d | 30 d |
| Infrastructure report (unverified) | the report's cell | −0.5 | 7 d | 14 d |
| Infrastructure report (verified) | the report's cell | −1.0 | 7 d | 14 d |
| Report about people (verified only) | the report's cell | −1.5 | 14 d | 30 d |

**Trust weighting** multiplies a contributor's weight:
- accounts younger than 7 days: 0.5;
- two or more rejected reports: 0.25;
- suspended accounts: 0.

Verified signals are counted at full weight, because a moderator has vouched for them.

**Aggregation** per cell:
- Each contributor's decayed weight is summed and then scaled down to a cap of **1**, so one person can't
  dominate a cell.
- Then `value = 0.5 + 0.5·(P − N) / (P + N + 2)`. The `+2` pulls small samples towards neutral.
- A cell with fewer than **3 distinct contributors** is "insufficient" and treated as neutral (0.5)
  everywhere.
- Levels: positive ≥ 0.6, cautionary ≤ 0.4, otherwise mixed.
- Contributor counts are only ever shown as buckets: "fewer than 3", "3–9", "10 or more".
- Aggregates are recomputed when signals change, and hourly (time decay, expiry, deleted accounts).

**In the Night Activity Score** the Pulse is the `communityPulse` factor (weight 0.10). It is the mean value
of the route's cells that have enough contributors. Confidence is medium if at least 30% of the route is
covered, low otherwise. With no data it stays at the neutral cold start with low confidence, as before.

## Incident reports

- Categories:
  - infrastructure: poor lighting, broken streetlight, road obstruction, a usually-open place closed,
    transport issue, other;
  - **about people**: harassment, suspicious activity.
- The location is stored as an H3 cell plus a point rounded to ~100 m. Reports outside NCR are refused.
- Limits:
  - 10 reports per person per day;
  - one per category per cell per 24 h;
  - the incident time must be within the last 7 days.
- Labels:
  - infrastructure reports are shown to others as **"Community reported"** (not verified);
  - reports about people start **"Under review"** and are hidden from everyone but the reporter until a
    moderator verifies them;
  - once verified, they show as **"Verified information"**, still without the reporter.
- Moderators review through the admin-token API: `GET /api/moderation/community-reports` and
  `POST …/:id/review`. A rejection removes the report's signals and lowers the reporter's future trust.
- Unverified reports about people never affect the Pulse.
- Infrastructure reports expire after 14 days, and reports about people after 30.
