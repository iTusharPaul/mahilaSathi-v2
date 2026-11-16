# Community layer: Nexconn channel architecture

Sources checked on 2026-11-12:

- [Chat SDK (Web)](https://docs.nexconn.ai/chatsdk-web)
- [Server API](https://docs.nexconn.ai/platform-chat-api)
- [Pre-messaging webhook](https://docs.nexconn.ai/platform-chat-api/webhook/message/pre-messaging)
- The type definitions shipped in `@nexconn/chat@26.2.1`, the latest stable release. Every SDK call in `client/src/features/community/chat/nexconnTransport.ts` typechecks against them.

## Channel types

| mahilaSathi context | Nexconn type | Why |
|---|---|---|
| Neighbourhood channel | `GroupChannel` | Persistent history, plus membership that only our server grants (`/v4/group-channel/join`). Created on first join, at most one per neighbourhood (unique index) |
| Journey room | `GroupChannel` | Small (12), time-boxed. Our job archives it 2 h after the window and dismisses the group (`/v4/group-channel/dismiss`) |
| Guardian Circle | `GroupChannel` | Private. Members join only with a single-use invite code |
| *(not used)* | `OpenChannel` | Anyone can enter an open channel, so membership can't be controlled. Nothing in the product needs one |
| *(Phase 4)* | `DirectChannel` | Only after a mutually accepted Walk Together match. Until then the webhook blocks all direct messages |
| *(never)* | `CommunityChannel` | Excluded by the product requirements |

Channel ids are `c` + UUID hex, and user ids are `u` + UUID hex, because Nexconn accepts letters and digits only. A user's chat id doubles as their **public id** in our API. It is shown with the pseudonym and is never linked to a phone number or real name. Users are registered at Nexconn under their pseudonym (`name` = community handle).

## Message flow

```
Plain text      browser ──SDK──▶ Nexconn ──pre_messaging webhook──▶ mahilaSathi policy ──pass 1 / pass 0──▶ delivered / refused
MS: messages    browser ──REST──▶ mahilaSathi (Zod + policy) ──Server API /group-channel/message/send──▶ Nexconn
Membership      browser ──REST──▶ mahilaSathi (rules, blocks, limits) ──Server API join/leave──▶ Nexconn
```

- **One policy for every path.** `server/src/services/moderation/messagePolicy.ts` decides every message from the webhook, the development relay and server-sent `MS:` messages. It checks:
  - active membership and channel status;
  - community suspension;
  - `MS:` payload schemas, and that server-only types come from the server;
  - length;
  - contact details (phone numbers, emails, coordinates, map links) outside Guardian Circles;
  - links from accounts under 24 hours old;
  - rate limits (10 per minute, 120 per hour);
  - repeated identical messages.
- **Webhook security.** Every webhook call must carry a valid `sha1(AppSecret + Nonce + Timestamp)` signature, with a timestamp within 5 minutes. Unsigned calls get 401.
- **Webhook limitations** (documented by Nexconn):
  - The pre-messaging webhook is not available on the Starter plan.
  - If our server doesn't answer within 5 s (three attempts), Nexconn delivers the original message.
  - On those plans or in that failure case, membership is still enforced by Nexconn's own group membership. Blocked users are still hidden on the client.

## Custom message types

| Type | Sender | Payload | Shown as |
|---|---|---|---|
| `MS:InfraUpdate` | Server, on behalf of a member | `{ category, note (≤280), areaLabel }` | "Community reported · Not verified" |
| `MS:SystemNotice` | Server only (`mssystem`) | `{ kind, text }` | Centred system line |

Types are registered with `NCEngine.registerCustomMessages` before connecting, as the SDK requires. Unknown or invalid payloads are never rendered raw. The client shows "This message type isn't supported in this version." Types reserved for later phases (journey status, check-in, SOS) are added with those features.

## Blocking

| Where | Enforcement |
|---|---|
| Journey rooms | Joining is refused if any member has a block relationship with the joiner, in either direction. The reason is not revealed |
| Guardian Circles | Blocking removes the blocked person from your circle, and you from theirs. New invites between them are unusable |
| Neighbourhood channels | Blocked senders are hidden for the blocker: server-side on the development relay, client-side with Nexconn (a group channel can't filter per recipient) |
| Direct messages | None exist yet. When Walk Together adds them, a block will prevent the match |

## Reports and moderation

- **Reports.** `POST /api/moderation/messages/:id/report` and `POST /api/reports`.
  - On the development relay the server stores its own copy of the reported message (`snapshot_source = server`).
  - With Nexconn the server can't read history, so the reporter's copy is stored and labelled `reporter` (unverified).
  - The reported user is never told who reported them.
- **Automatic pause.** Three *different* people reporting someone within 24 h pauses their community posting for 24 h, pending review. One person can never trigger this alone.
- **Moderator review** uses the `X-Admin-Token` header. Both endpoints are disabled entirely when `ADMIN_TOKEN` is unset. The in-app moderator screen at `/moderation` uses the same token and endpoints. Its queue view shows pseudonyms and context, never phone numbers or internal ids.

  ```bash
  curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8080/api/moderation/queue
  ```

  ```bash
  curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"action":"remove_from_channel","reason":"Threats"}' http://localhost:8080/api/moderation/reports/<id>/resolve
  ```

  Actions are `dismiss`, `warn`, `remove_from_channel` and `suspend` (with `suspendHours`). Each is recorded in `moderation_actions` and `audit_events`.

## Development relay

When `NEXCONN_APP_KEY` and `NEXCONN_APP_SECRET` are not set, the same API works through a development relay:

- messages are stored in `dev_chat_messages` and fetched by polling every 3 s, with backoff when offline;
- the same membership rules and policy apply;
- the UI shows "Development relay · not Nexconn";
- `/api/config` reports `nexconn.mode = dev-adapter`;
- server startup logs it.

It is real messaging between users, but it is not Nexconn and is never presented as Nexconn. Relay messages are purged after 30 days.

## Setting up Nexconn

1. Create an app in the Nexconn console. Set `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET` and `NEXCONN_AREA` (`sg` or `na`) in `.env`.
2. Enable the **group pre-messaging** webhook (Chat Free or Pro plan) and point it at `https://<your-domain>/api/webhooks/nexconn`.
3. Restart the server. `/api/config` should report `nexconn: { mode: "live" }`, and the Community screen should show the "Nexconn" badge.

**Verified live (2026-11-13, area `sg`):**
- the server creates groups, adds and removes members, and sends `MS:` messages through the Server API;
- browsers connect, receive messages in real time, load history, and send text to each other;
- a guardian's browser loaded journey updates the server had sent.

The integration is also covered by tests against a fake of the documented Server API and webhook contracts. The client's SDK calls are type-checked against the real SDK.

**History needs a connected SDK.** History requests made while the SDK is still connecting fail with code 30002. This is what caused the "couldn't load messages" errors in earlier phases. The transport now waits for the connection (up to 15 s) before loading history or sending.

**Telemetry blocked.** The SDK tries to upload logs to `logcollection.ronghub.com`. The Content Security Policy blocks this on purpose; chat works without it.

**Not verified live:** the pre-messaging webhook. It needs a public HTTPS URL and the Chat Free or Pro plan. Until it is reachable, Nexconn delivers browser-sent text without our contact-info check.
