# Free public demo on Render

This puts mahilaSathi on a public HTTPS link that anyone can open on a phone or laptop. It costs nothing and
needs no card. It is a **demo**, not a safety service: sign-in codes are shown on screen, SOS texts are recorded
but never sent, and every SOS is labelled "DEMO, not a real emergency".

## What the free plan gives you, and its limits

| | Render free web service |
|---|---|
| Link | `https://<name>.onrender.com`, HTTPS included |
| Sleep | After 15 minutes with no visitors. The next visit wakes it in about a minute |
| Disk | **Not kept.** The database starts empty after every deploy, restart or sleep |
| Hours | 750 a month per workspace: enough for one service running all month |

Because the disk resets, `DEMO_AUTOSEED=true` recreates the three fictional demo accounts (Lotus-42,
Jasmine-17, Neem-08), their Guardian Circle and neighbourhood channels at every start. **Accounts testers create
themselves disappear when the server restarts or sleeps.** The demo accounts are always there.

Source: [Render free instances](https://render.com/docs/free).

## Safeguards built in for a public demo

- **Sign-in warning.** The sign-in screen tells testers not to use their real number: with the development
  OTP adapter, anyone can sign in with any number.
- **Every SOS is a demo.** With `DEMO_MODE=true`, every SOS (not only the demo accounts') is labelled demo in
  the app, in push notifications and in the recorded SMS text. Journey updates are prefixed `[Demo]`.
- **No real messages.** `SMS_PROVIDER=mock` records SOS texts on the server and sends nothing. The moderator
  screen shows them under "SMS outbox".
- **Shared demo accounts.** Many people can sign in to Lotus-42, Jasmine-17 or Neem-08 at once. Demo numbers
  skip the per-number code limits, and a new code doesn't cancel someone else's. Other numbers keep the normal
  limits.
- **Per-visitor rate limits.** Render serves through Cloudflare, which puts each visitor's address in the
  `CF-Connecting-IP` header and overwrites any value a client sends. `render.yaml` sets
  `CLIENT_IP_HEADER=cf-connecting-ip`, so each visitor gets their own limit. Counting proxy hops
  (`TRUST_PROXY`) gave proxy addresses on Render, so visitors shared limits. If your Blueprint doesn't sync
  this automatically, add it under Environment in the Render dashboard.
- **Secrets stay server-side.** Render generates `JWT_SECRET` and `ADMIN_TOKEN`. Provider keys are entered in
  the Render dashboard and never committed.

## Deploy

You need a GitHub account and a Render account (sign up at [render.com](https://render.com) with GitHub).

1. **Push this project to a GitHub repository.** It can be private.
   - `.env` and `.env.render` are git-ignored. Check with `git status` that neither is staged.
2. **Create the service.** In Render: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. **Fill in the values it asks for.** Copy them from your local `.env.render` (created for you, git-ignored):
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: a key pair made for this server only. Required (push is on).
   - `VAPID_SUBJECT`: your app's URL, e.g. `https://mahilasathi.onrender.com`. Fix it once you know the real URL.
   - `GEOAPIFY_API_KEY`: optional. Without it, place search uses the built-in NCR list and routes are synthetic
     (labelled).
   - `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET`: optional. Without them, chat uses the built-in relay.
4. **Apply.** The first build takes several minutes. When the service is live, open its URL.
5. **Nexconn webhook** (only with Nexconn): in the Nexconn console, set the pre-messaging webhook to
   `https://<your-app>.onrender.com/api/webhooks/nexconn`.

## Check it works

- `https://<your-app>.onrender.com/api/health` returns `{"status":"ok", ...}`.
- `https://<your-app>.onrender.com/api/ready` shows the database, migrations and geography as ready.
- Sign in as **Lotus-42** (`9000000042`) on one device and **Jasmine-17** (`9000000017`) on another. Hold SOS
  as Lotus: Jasmine sees "DEMO SOS (not real)" within 15 seconds.
- **Moderator screen:** open `/moderation` and paste `ADMIN_TOKEN` from Render → your service → Environment.
  Don't share the token.

## Optional: keep it awake

To avoid the one-minute wake-up for the first visitor, a free uptime monitor (for example cron-job.org or
UptimeRobot) can request `/api/health` every 10 minutes. One always-on service uses about 744 of the 750 free
hours, so do this for one service only. It also keeps testers' accounts longer, since the disk resets only on
restarts and deploys.

## Free-tier limits of the providers

- **Geoapify** has a daily request allowance on its free plan. If it runs out, place search falls back to
  the built-in NCR list and plans say place data is unavailable. Nothing breaks.
- **Nexconn** has free-tier limits on users and messages. A fresh database creates new chat users after each
  restart.

## Need data that survives restarts?

The free plan can't keep a disk. Options, in order of effort:
- **Render Starter plan with a persistent disk** at `/data` (paid). Remove `DEMO_AUTOSEED` if you want
  only real data.
- **A small VM** (for example Oracle Cloud Always Free) running `docker compose up -d` behind Caddy for HTTPS.
  It is free and persistent, but you run the server yourself.
