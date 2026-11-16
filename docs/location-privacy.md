# Location privacy rules

One place for every rule about where a location can go. Each rule is enforced on the server and covered by
tests. `tests/security/authorization.test.ts` checks the most important ones together.

## Principles

1. **Ask only when needed.** The app asks for location only for "use my current location" when planning, for
   live location on a journey (opt-in), and during an active SOS. A denied permission is explained, and
   manual place search always works.
2. **Precise to trusted people only.** Exact coordinates go only to people the user chose: their Guardian
   Circle, and their own emergency contacts during an SOS. Never to strangers, community channels or
   public endpoints.
3. **Stop at once.** Every live location has an immediate stop that also deletes the stored point:
   - per journey;
   - per SOS;
   - "Stop sharing my location everywhere" in Profile.
4. **Nothing location-related after the end.** When a journey or SOS ends, guardians see the outcome only.

## Where each kind of location goes

| Data | Stored as | Who can see it |
|---|---|---|
| Route plan origin and destination | Exact, in `route_plans` | Owner only. Deleted after 24 h |
| Journey route | Exact, in `trip_routes` | Owner; guardians with a `precise` share while the journey is open |
| Journey live location | Exact, in `trip_locations` | Owner. Guardians see the area name at `approximate` and the exact point at `precise`, only while the journey is open |
| Walk Together corridor | H3 cells (~0.7 km²) with **300 m trimmed** from each end | Nobody: server-side only. Matched people see up to three area names |
| SOS location | Exact, in `sos_events`, only if the user's SOS rules allow (`none` stores nothing) | Owner. Alerted guardians and emergency contacts at the allowed level while the SOS is active |
| Community reports | H3 cell plus a point rounded to ~100 m, and an area name | Others see the category, label and area name. Never the reporter |
| Community Pulse | H3 cells, aggregated | A level and a bucketed contributor count, only for cells with 3 or more contributors |
| Neighbourhood channels, journey rooms, Walk Together chats | No coordinates | Members. Text containing coordinates, map links, phone numbers or emails is refused. With Nexconn, this check runs in the pre-messaging webhook, which needs a public HTTPS URL |
| Guardian Circle chat | No coordinates from the server: journey and SOS notices carry area names only | Circle members |
| Push notifications | Title, short text and an in-app link. Never coordinates. Encrypted end to end to the browser, so the push service can't read them | The device owner |
| Home area | An area id, never coordinates | Owner |
| Server logs and audit trail | Never coordinates | Administrators |

## Retention

| Data | Kept for |
|---|---|
| Live journey points | 24 h after the journey ends, or deleted at once when sharing stops |
| Exact journey endpoints and labels | 30 days after the journey ends |
| SOS coordinates | 30 days after the SOS ends, or deleted at once when sharing stops |
| Route plans | 24 h |

Account deletion removes all of the above. Profile → Privacy → "Download my data" exports the user's own records.
