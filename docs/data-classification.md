# Data classification

Every table is listed with what it holds, how sensitive it is, and who may read it. A table is added here
in the same change as the migration that creates it.

| Level | Meaning |
|---|---|
| **PUBLIC** | Safe to show to any signed-in community member |
| **INTERNAL** | Operational data with no personal content |
| **PERSONAL** | Linked to an identifiable user; owner and authorised parties only |
| **RESTRICTED** | Precise location, contact details, safety events, credentials or security logs; strict need-to-know |

| Table | Introduced | Level | Contents | Access | Retention |
|---|---|---|---|---|---|
| `schema_migrations` | 0001 | INTERNAL | Applied migration versions and checksums | Server only | Permanent |
| `audit_events` | 0001 | RESTRICTED | Who did what to which entity, request id, coarse metadata. Must not contain coordinates, phone numbers or message text | Administrators only; append-only (DB trigger) | Permanent (policy review in Phase 5) |
| `boundary_datasets`, `ncr_boundaries`, `states`, `districts`, `cities`, `neighbourhoods` | 0002 | PUBLIC | Administrative boundaries and curated area names | Public read API | Versioned; superseded rows deactivated |
| `coverage_assessments` | 0002 | PUBLIC | Data-coverage level per area and its basis | Public read API | Replaced on reassessment |
| `users` | 0003 | RESTRICTED (`phone_e164`), PERSONAL (rest) | Phone (E.164), display name, community pseudonym, home area **ids only** | Owner via `/api/users/me`. The phone number is never returned unmasked, even to the owner | On deletion: phone, name and home area cleared; tombstone kept for audit integrity |
| `otp_sessions` | 0003 | RESTRICTED | Phone, HMAC of the code, attempts, expiry | Server only | Purged after 24 h |
| `user_sessions` | 0003 | RESTRICTED | SHA-256 of the session token, user agent, timestamps | Server only | Purged 7 days after expiry or revocation |
| `user_preferences` | 0003 | PERSONAL | Location-sharing default, notification preferences | Owner only | Deleted with the account |
| `emergency_contacts` | 0003 | RESTRICTED | Third parties' names and phone numbers | Owner only; every query is scoped by owner | Deleted with the account |
| `chat_identities` | 0004 | PERSONAL | Chat-provider user id (also the public id shown with the pseudonym) | Server; the public id is visible to fellow channel members | Kept with the user tombstone |
| `community_channels` | 0004 | PUBLIC metadata | Channel kind, area names/ids, departure window. No coordinates | Members; open journey rooms are listed (area names and window only) | Archived, not deleted |
| `community_memberships` | 0004 | PERSONAL | Who is in which channel | Fellow members see pseudonyms only | Ended on leave/removal/account deletion |
| `circles`, `circle_members` | 0004 | PERSONAL | Guardian relationships; display names visible to circle members only | Circle members only (404 to others) | Ended on removal; owner deletion closes the circle |
| `circle_invites` | 0004 | RESTRICTED | HMAC of the invite code and of an optional bound phone number | Owner sees pending invites (no codes) | Purged 30 days after expiry |
| `user_blocks` | 0004 | PERSONAL | Who blocked whom | The blocker only; never revealed to the blocked user | Deleted on account deletion |
| `message_reports`, `user_reports` | 0004 | RESTRICTED | Reason, details, message snapshot (labelled `server` or `reporter`) | Moderators (admin token) only | Kept for review history |
| `moderation_actions` | 0004 | RESTRICTED | Moderator/system decisions | Moderators only | Permanent |
| `route_plans` | 0005 | RESTRICTED | Exact origin/destination, departure time, scored results | Owner only (others get 404) | Purged 24 h after creation; deleted with the account |
| `route_cache` | 0005 | RESTRICTED | Routing responses keyed by rounded endpoints | Server only | Expires after 24 h |
| `places_cache` | 0005 | PUBLIC | OpenStreetMap places and cameras per ~2 km cell | Server only | Expires after 7 days |
| `provider_cache_metadata` | 0005 | INTERNAL | Last success/failure per external provider | Server only | Overwritten |
| `dev_chat_messages` | 0004 | PERSONAL | Message bodies **only for the development relay** (Nexconn holds them otherwise) | Channel members | Purged after 30 days |
| `trips` | 0006 | RESTRICTED | Exact origin/destination coordinates and labels, destination **area name**, status, times, check-in schedule, optional route feedback | Owner only (others get 404). Guardians see a reduced view through an active share (below) | Exact endpoints and labels cleared 30 days after the journey ends; deleted with the account |
| `trip_routes` | 0006 | RESTRICTED | The chosen route's geometry and score | Owner; guardians with a **precise** share while the journey is open | Deleted with the trip |
| `trip_checkins` | 0006 | PERSONAL | Start/manual/arrival check-ins with an optional short note. No coordinates | Owner | Deleted with the trip |
| `trip_shares`, `trip_share_acks` | 0006 | PERSONAL | Which Guardian Circle a journey is shared with, at what level (`status`, `approximate`, `precise`), and who acknowledged | Owner; active guardians of that circle until 12 h after the journey ends | Deleted with the trip |
| `trip_locations` | 0006 | RESTRICTED | Live points (lat/lng/accuracy) posted **only while the traveller has location sharing on** | Owner; guardians see only the latest point: an area name at `approximate`, the exact point at `precise`, nothing after the journey ends | Deleted immediately when sharing is turned off; otherwise 24 h after the journey ends |
| `corridor_segments` | 0006 | PERSONAL (coarse) | H3 resolution-8 cells (~0.7 km²) along the route with **300 m trimmed from each end** | Server only (used for Walk Together and the Pulse); never returned | Deleted with the trip |
| `walk_together_requests` | 0006 | PERSONAL | A journey's wish to walk with someone, and its time window | Owner; matched people see only the window | Closed when the journey ends or the window passes; deleted with the trip |
| `walk_together_matches`, `walk_together_members` | 0006 | PERSONAL | Proposed/accepted pairs, overlap %, shared **area names** | The two people involved, who see each other's pseudonym only | Cancelled on account deletion; deleted with either request |
| `community_reports` | 0006 | PERSONAL | Category, description, H3 cell, a point rounded to ~100 m, area name, moderation status | Others see the category, label and area, never the reporter. Reports about people (harassment, suspicious activity) are visible to others only once verified | Infrastructure reports expire 14 days after submission (or verification); reports about people 30 days. Kept as `expired` for moderation history; deleted with the account |
| `community_pulse_signals` | 0006 | PERSONAL | Raw, trust-weighted signals per cell with the contributor id | Server only; never exposed | Expire after 14–30 days by kind; deleted with the account (aggregates recomputed hourly) |
| `community_aggregates` | 0006 | PUBLIC (aggregated) | Decayed positive/negative weight and contributor count per cell | Shown only as a level and a bucketed count, and only for cells with 3 or more contributors | Recomputed hourly; removed when no signals remain |
| `sos_settings` | 0007 | PERSONAL | The user's SOS rules: location detail, when emergency contacts are messaged, escalation delay, shortcut behaviour | Owner only | Deleted with the account |
| `sos_events` | 0007 | RESTRICTED | Status, outcome, optional note, the rules snapshot, and the latest location **only if the user's rules allow** (nothing stored at `none`) | Owner; alerted guardians see the location at the allowed level while the SOS is active, and the status for 12 h after it ends. Others get 404 | Coordinates cleared immediately when the user stops location sharing, otherwise 30 days after the SOS ends; deleted with the account |
| `sos_recipients` | 0007 | RESTRICTED | Who was alerted: guardian user ids, emergency-contact names and **phone numbers (snapshot)** | Owner; guardians see other guardians' names only, never phone numbers | Deleted with the SOS; a deleted guardian's name becomes "Former member" |
| `sos_deliveries` | 0007 | INTERNAL | One delivery job per channel and purpose: status, attempts, retry time, safe error text, provider message id | Owner (as statuses) | Deleted with the SOS |
| `sos_delivery_attempts` | 0007 | INTERNAL | Append-only log of every try and its outcome (no message content) | Server / administrators | Deleted with the SOS |
| `sos_acknowledgements` | 0007 | PERSONAL | A guardian's response (seen / calling / on the way) and time | Owner and the other alerted guardians | Deleted with the SOS |
| `dev_sms_outbox` | 0007 | RESTRICTED | **Development SMS adapter only**: the text that would have been sent and the number. Nothing leaves the server | Server only | Purged after 7 days |
| `users.is_demo`, `sos_events.is_demo`, `community_reports.is_demo` | 0008 | INTERNAL | Marks fictional demo accounts and what they create, so the product labels them and never counts them as community data | Server; shown as a "demo" label | Lives with the row |
| `users.google_sub`, `users.email` | 0010 | RESTRICTED | Google's opaque account id, and the email only when Google reports it verified. A user now has a phone number **or** a Google account | Server; the owner sees the email masked (`p•••@gmail.com`) and in the data export. Never shown to other members or moderators | Cleared on account deletion, like the phone number |
| `push_subscriptions` | 0009 | PERSONAL | One row per device that turned notifications on: the push-service endpoint (a capability URL at Google/Mozilla/Microsoft/Apple) and the keys used to encrypt payloads | Server only | Deleted on unsubscribe, when the push service reports it gone (404/410), and with the account |

## Rules that apply to every table

- Exact coordinates live only in RESTRICTED tables (`route_plans`, `route_cache`, `trips`, `trip_routes`, `trip_locations`, `sos_events`, and SMS text in `dev_sms_outbox`). Shared and community tables hold H3 cells, ~100 m-rounded points or area names only. The home area is stored as an area id, never as coordinates. Coordinates sent to `/api/geo/resolve` are used for that request only and are not stored.
- Phone numbers are stored only in authentication and emergency-contact tables. They are never returned in community APIs.
- Email addresses (Google sign-in) are stored only in `users.email` and are never returned in community or moderation APIs. The moderator usage report contains counts only.
- The user-facing privacy notice (`/privacy`, `client/src/pages/PrivacyPage.tsx`) summarises this document and must be changed with it.
- Request logs record method and path only. Query strings, bodies, cookies, phone numbers, OTP codes, tokens and coordinates are not logged or are redacted.
- Each table holding PERSONAL or RESTRICTED data documents its retention period here when it is created.
