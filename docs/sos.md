# SOS and safety hardening

Phase 5. How an SOS works, what each status means, and what mahilaSathi does **not** do. The code is the
source of truth: `server/src/services/sos/`, `server/src/jobs/sosWorker.ts`, `database/migrations/0007_sos.sql`.

> mahilaSathi is not connected to the police or any emergency service. An SOS alerts the people the user
> chose. Every SOS screen says so and offers a one-tap call to **112**.

## Activation

- **Hold to send.** The SOS button must be held for 1.5 s (touch, mouse, or Space/Enter on a keyboard). A tap
  does nothing.
- **Confirm path.** People who can't hold use "Send with a confirmation instead".
- **Where it lives.** The button is in the header on every screen, on Home, and on each journey.
- **Shortcut.** A web-app manifest shortcut opens `/sos?shortcut=1` once the app is installed. The user's
  setting decides what it does: show the hold button, or start a 5-second countdown they can cancel.
- **Idempotent.** The device generates one `idempotencyKey` per activation. A retry with the same key, or any
  activation while one is already active, returns the same SOS with `200`, never a second incident.
  - This is enforced by a unique `(user_id, idempotency_key)` and a partial unique index allowing one
    `ACTIVE` event per user. A burst of concurrent requests resolves to one event (tested).
- **No rate limit on activation.** It is deliberately not rate-limited beyond the global API limit. An
  emergency must never be refused for "too many requests"; idempotency stops duplicates instead.

## What happens, in order

1. **One transaction writes everything.** It creates the event, a **snapshot of the user's rules**, the
   recipients, and every delivery job, all before anything is sent. A crash can't leave an SOS half-created.
2. **Location**, only as the user's rules allow:
   - a point sent by the device, otherwise the latest point of a journey that was already sharing location;
   - at `none`, nothing is stored at all.
3. **Recipients:**
   - active **guardians** in the user's Guardian Circle, alerted in the app and with one `MS:SosAlert` in the
     circle chat;
   - **emergency contacts**, by SMS, according to the rule below.
4. **The worker** (`jobs/sosWorker.ts`, not the browser) sends due jobs every 3 s and applies escalation
   rules every 10 s.
5. **Guardians respond:** "I've seen this", "I'm calling them" or "I'm on my way". The first response is also
   posted to the circle chat so other guardians know.
6. **The user ends it** with "I'm safe now" (`RESOLVED`) or "False alarm" (`CANCELLED`). Anyone who was
   reached gets an "SOS ended" notice. Jobs not yet sent are marked `skipped`. An SOS can't be reopened; a new
   one is created.

### Escalation rules (set by the user, copied into each SOS)

| Setting | Options | Default |
|---|---|---|
| Location detail | `precise` (exact point), `approximate` (area name only), `none` | `precise` |
| Emergency contacts | `immediately`, `if_unacknowledged`, `never` | `if_unacknowledged` |
| Wait for a guardian response | 1–15 minutes | 3 |
| Shortcut | `hold`, `countdown` | `hold` |

- **When contacts are messaged.** With `if_unacknowledged`, emergency contacts are messaged only if no
  guardian has responded when the wait ends. With no guardians at all, there is nobody to wait for, so they
  are messaged at once.
- **Reminder.** When the wait ends with no response, the circle chat also gets a reminder.
- **Runs once.** The escalation is guarded so it can't run twice.

## Delivery statuses: never claiming more than was confirmed

| Status | Meaning |
|---|---|
| `pending` / `sending` | Waiting to be sent, or being sent. After a failure, shows the next retry time and the reason |
| `accepted` | **Handed to the channel; delivery not confirmed.** The circle chat provider or SMS provider accepted it. An in-app alert is available but not yet opened |
| `delivered` | **Confirmed.** Today only in-app alerts can reach this: the guardian's app loaded the alert. There are no SMS delivery receipts, so SMS never shows `delivered` |
| `failed` | A permanent error (e.g. the number was rejected, or the circle is gone), or still failing after 5 tries |
| `unavailable` | The channel isn't set up on this server (e.g. `SMS_PROVIDER=none`). Nothing was sent, and the screen says so |
| `skipped` | No longer needed: the SOS ended first, or a guardian responded before the escalation |

- **Dev adapter label.** With `SMS_PROVIDER=mock`, accepted SMS are labelled "Development SMS adapter:
  recorded only, no real SMS was sent".
- **Safe errors only.** Error text shown to users is our own wording. Provider internals (hosts, status codes)
  are never surfaced.

## Reliability

- **Durable jobs.** `sos_deliveries` holds each job's state. `sos_delivery_attempts` is an append-only log of
  every try: a trigger blocks rewriting its identity columns.
- **Retries.** Up to 5 tries per job, with backoff of 10 s, 30 s, 90 s and 270 s, so an undeliverable message
  is reported as failed within about 7 minutes. Permanent errors are not retried. Each final failure is
  audited (`sos.delivery_failed`).
- **Claiming and leases:**
  - A worker claims a job with a guarded update (status and attempt count must match what it read), so two
    workers can't send the same try.
  - A claim carries a **60-second lease**. If the server dies mid-send, the job is picked up again after the
    lease expires.
  - The worker runs immediately at startup, which recovers pending and abandoned jobs (tested with a
    simulated crash and restart on the same database).
- **No browser timers.** Escalation timing is stored in the database (`next_escalation_at`), so it survives
  restarts.

## Push notifications

With Web Push configured, guardians who turned notifications on get a phone or desktop notification:
- when an SOS starts (marked urgent);
- when the escalation reminder goes out, sent only to guardians who haven't responded;
- when the SOS ends.

Push is **not** counted as a delivery. A push service accepting a message doesn't mean anyone saw it, so it never changes the delivery statuses above. It follows each guardian's "SOS alerts" setting. Notifications never include coordinates; guardians open the app to see the location.

## Privacy

- **Location:**
  - Precise coordinates go only to the user's own guardians and emergency contacts, and only at the
    `precise` setting.
  - `approximate` sends an area name. Circle-chat messages never contain coordinates.
  - SMS includes a map link only at `precise`.
- **Stopping location:**
  - "Stop sharing my location" on the SOS screen clears the stored point at once.
  - Profile → Privacy → "Stop sharing my location everywhere" does the same for an active SOS and every open
    journey.
- **After it ends.** Guardians see no location once the SOS ends, and see the outcome for 12 hours.
- **Retention.** Coordinates are cleared 30 days after an SOS ends, and development SMS records after 7 days.
  Deleting the account deletes the user's SOS history.
- **Audit and logs.** The audit trail records each step (`sos.activated`, `sos.escalated`,
  `sos.acknowledged`, `sos.ended` and others) with identifiers and counts only: never coordinates, phone
  numbers or message text. Server logs record the SOS id only.

## Other hardening in this phase

- **Moderator audit log.** `GET /api/moderation/audit` is filterable by action prefix, actor, target and
  time. It is admin-token protected, and its query input is validated and parameterised.
- **Privacy controls in Profile:** download my data (JSON of the user's own records, with others shown by
  name or pseudonym only), stop all location sharing, and clear journey history (which also withdraws those
  journeys' Community Pulse signals).
- **Security suite.** `tests/security/authorization.test.ts` covers every security test listed in the
  specification.
