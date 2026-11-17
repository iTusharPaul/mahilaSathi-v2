# Sign in with Google

Real people sign in with their Google account. The phone sign-in on the public test server shows its code on
screen, so it can't prove who anyone is. Once Google sign-in is on and SMS sign-in is still the development
adapter, phone sign-in is limited to the shared demo accounts.

## How it works

1. The sign-in screen loads Google's script (`https://accounts.google.com/gsi/client`) and shows Google's own
   **Continue with Google** button. It loads only when `GOOGLE_CLIENT_ID` is set.
2. Google shows its account picker and returns a signed **ID token** to the page. mahilaSathi never sees the
   Google password.
3. The page posts the token to `POST /api/auth/google`. The server checks it with
   [`jose`](https://github.com/panva/jose) against Google's published keys
   (`server/src/services/auth/googleIdToken.ts`). It checks:
   - the signature (RS256);
   - the issuer (`accounts.google.com`);
   - the audience (our client id), so a token minted for another app is refused;
   - the expiry.
4. The server finds or creates the account by Google's stable account id (`sub`) and starts the normal
   mahilaSathi session cookie. Every other part of the app works as before.

What's stored:
- `users.google_sub`: Google's account id, never shown to anyone.
- `users.email`: only if Google says it is verified. It is shown to its owner masked (`p•••@gmail.com`) and is
  included in the data export.
- Both are cleared when the account is deleted.

Nothing else from Google is requested or kept: no name, photo, contacts or Google API access.

### Demo accounts and labels on a demo server

- **Google users are real people.** Their SOS alerts and journey messages are **not** labelled "demo", even
  on a `DEMO_MODE` server.
- **Emergency SMS is still the development adapter** (`SMS_PROVIDER=mock`). No text message reaches a real
  phone. The sign-in screen, the SOS settings and the privacy notice say so. Guardians who use the app get real
  in-app and push alerts.
- **The demo accounts still work** (Lotus-42, Jasmine-17, Neem-08) for anyone just looking around. Other phone
  numbers get "phone sign-in is only for the demo accounts" (403).
- **Guardian invite codes can't be locked to a phone number** while Google sign-in is on, because Google
  accounts have no number.

## Set it up (about 10 minutes, free)

You need a Google account. These steps use the [Google Cloud console](https://console.cloud.google.com/). Its
menu names change from time to time; Google's guide is
[Get your Google API client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

1. **Create a project.** Use the project picker, then **New project**. Name it `mahilaSathi`.
2. **Configure the consent screen.** Open **Google Auth Platform** (older consoles call it **APIs & Services →
   OAuth consent screen**) and choose **Get started**. Fill in:
   - **App name:** `mahilaSathi`.
   - **User support email:** your address. Google shows it to people who sign in.
   - **Audience:** **External**.
   - **Contact information:** your address.
3. **Branding** (optional but recommended):
   - **Application home page:** `https://mahilasathi.onrender.com`.
   - **Privacy policy:** `https://mahilasathi.onrender.com/privacy`.
4. **Publish the app.** Under **Audience**, choose **Publish app** to move it from *Testing* to *In
   production*. While it is in Testing, only the test users you list can sign in.
   - mahilaSathi asks only for the basic `openid email profile` scopes, which don't need Google's app
     verification.
   - If Google still asks you to verify the brand, people can sign in meanwhile; they may see the domain name
     instead of "mahilaSathi".
5. **Create the client.** Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**) and
   create one:
   - **Application type:** **Web application**.
   - **Authorized JavaScript origins:** add each of these:
     - `https://mahilasathi.onrender.com`
     - `http://localhost:5173` and `http://localhost` (for local development)
   - **Authorized redirect URIs:** none. The button uses a popup.
6. **Copy the client ID.** It ends in `.apps.googleusercontent.com`.
   - The client ID is public: it is sent to every browser.
   - Google also shows a **client secret**. mahilaSathi doesn't use it; don't put it anywhere.
7. **Turn it on:**
   - **Render:** open your service, then **Environment → Add environment variable**. Set `GOOGLE_CLIENT_ID` to
     the client ID and save. Render redeploys, which takes a few minutes.
   - **Local:** add `GOOGLE_CLIENT_ID=...` to `.env` and restart `npm run dev`.

The server refuses to start if `GOOGLE_CLIENT_ID` doesn't look like a client ID. This catches a pasted client
secret by mistake.

## Check it works

1. Open `https://mahilasathi.onrender.com/api/config`. You should see
   `"auth":{"googleClientId":"…apps.googleusercontent.com","phoneSignIn":"demo_accounts_only"}`.
2. Open the app in a private window and tap **Get started**. **Continue with Google** appears at the top, with
   the demo accounts below.
3. Sign in. A new account goes to onboarding. **Profile** shows "Signed in as p•••@gmail.com (Google)".
4. As a moderator, open `/moderation`, then the **Usage** tab. Your account is counted; the demo accounts never
   are.

If the button doesn't appear or the popup closes with an error:
- **"The given origin is not allowed for the given client ID"** (in the browser console): add the exact origin
  in step 5. Use `https`, and don't add a trailing slash. Changes can take a few minutes to apply.
- **The popup says the app is in testing:** publish the app (step 4), or add the person as a test user.
- **"Google sign-in failed"** from the server: the server's `GOOGLE_CLIENT_ID` differs from the one the page
  used, or the server clock is wrong.
- **Ad blockers and strict privacy modes** can block `accounts.google.com`. The screen tells people when the
  button can't load.

## Usage numbers for the hackathon

The moderator **Usage** tab (`GET /api/moderation/usage`, admin token required) shows counts only. It never
shows names, emails, numbers or locations:
- accounts by sign-in method;
- sign-ups per day;
- active people (24 h / 7 days);
- people who came back on another day;
- route comparisons;
- journeys started and arrived;
- Guardian Circles with a guardian;
- people with notifications on.

The demo accounts, and everything they do, are excluded. **Copy as text** gives a summary you can paste into a
submission.

**These numbers only last as long as the database does.** On Render's free plan the disk is wiped on every
restart and redeploy, and real accounts go with it. Before you invite real people, move to storage that
persists. See [Need data that survives restarts?](deploy-render.md#need-data-that-survives-restarts).
