# Keeping data on Render free: Litestream to Supabase Storage

Render's free plan has no disk that survives a restart. A deploy, a restart, or waking up after 15 idle
minutes all start from an empty disk. Without a backup, every account would be lost each time.

mahilaSathi keeps its SQLite database and streams it to a **Supabase Storage** bucket with
[Litestream](https://litestream.io/guides/supabase/). Both are free.

## How it works

`docker/start.sh` runs when the container starts:

1. **Restore.** If the container has no database yet (always true on Render free), Litestream downloads the
   latest copy from the bucket. On the very first start there's no backup yet, so it begins empty.
2. **Replicate.** Litestream starts the server and ships every change to the bucket about once a second. It
   also takes a full snapshot every 6 hours and removes backups older than 3 days. The latest snapshot is
   always kept.
3. **Stop.** When Render stops the container, Litestream stops the server and sends the last changes first.

**If the bucket can't be reached at start** (wrong keys, Supabase paused), the server **doesn't start**. It
never runs on an empty database by mistake, so it can't overwrite the backup with nothing. Render's logs say
why.

`GET /api/config` reports `"dataStorage":"replicated"` while this is on. The sign-in screen then stops warning
that data may be reset.

Nothing in the app changes: it is still the same SQLite file with the same migrations and tests. Supabase only
stores the backup files. They aren't tables you can browse in Supabase.

## Set it up (about 10 minutes, free)

### 1. Create a Supabase project

1. Sign in at [supabase.com](https://supabase.com/dashboard) and choose **New project**.
2. Fill in:
   - **Name:** `mahilasathi`.
   - **Region:** **Southeast Asia (Singapore)**, the same region as the Render service.
   - **Database password:** use **Generate a password**. mahilaSathi doesn't use it, but keep it somewhere safe.
3. Wait a minute or two for the project to be ready.

### 2. Create a private bucket

1. Open **Storage**, then choose **New bucket**.
2. Name it `mahilasathi-db` and leave **Public bucket** **off**.

### 3. Create S3 access keys

1. Open **Project Settings → Storage**. Some dashboards call this **Storage → Settings → S3 Connection**.
2. Make sure **S3 protocol connection** is enabled.
3. Copy two values:
   - **Endpoint**, which looks like `https://abcdefghijklmnop.storage.supabase.co/storage/v1/s3`. The part
     before `.storage.supabase.co` is your **project ref**. It is also shown as **Project ID** under
     **Project Settings → General**.
   - **Region**, for example `ap-southeast-1`.
4. Under **S3 access keys**, choose **New access key** and describe it as `render litestream`. Copy the
   **Access key ID** and the **Secret access key**.

The secret is shown **only once**. It gives full access to every bucket in the project, so put it only in Render.
Never put it in the repository, the app, or a chat.

### 4. Add the variables to Render

On your service, open **Environment** and add:

| Key | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | the project ref, e.g. `abcdefghijklmnop` (not the whole URL) |
| `SUPABASE_S3_REGION` | the region, e.g. `ap-southeast-1` |
| `SUPABASE_S3_ACCESS_KEY_ID` | the access key ID |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | the secret access key |
| `SUPABASE_S3_BUCKET` | `mahilasathi-db`. This is already set if the service was created from `render.yaml` |

Choose **Save changes**. Render redeploys.

## Check it works

1. **Render logs.** Within a minute of the deploy, the logs should show:
   - `[start] Restoring the database from Supabase Storage …`;
   - Litestream lines about the database and the replica;
   - the server's usual startup line.
2. **Config.** `https://<your-app>.onrender.com/api/config` should show `"dataStorage":"replicated"`.
3. **Bucket.** In Supabase, under **Storage → mahilasathi-db**, a `mahilasathi/` folder should appear with
   backup files.
4. **Survives a restart.** Sign in (with Google, or as a demo account), then plan and start a journey. In
   Render, choose **Manual Deploy → Deploy latest commit**. After the deploy finishes, sign in again: the journey
   is still there.

If the deploy fails, Render's log names the problem. The previous version keeps running meanwhile.
- **`… are missing: …`:** one of the variables above isn't set.
- **`AccessDenied`, `SignatureDoesNotMatch` or `InvalidAccessKeyId`:**
  - the keys or region are wrong;
  - or `SUPABASE_PROJECT_REF` contains the whole URL instead of just the ref.
- **`NoSuchBucket`:** the bucket name doesn't match `SUPABASE_S3_BUCKET`.

## Things to know

- **Supabase pauses free projects** that see little activity for a week. A paused project's storage can't be
  reached, so the next restart of mahilaSathi fails. The site then stays down until you choose **Restore
  project** in the Supabase dashboard. Each snapshot and every change the app writes are requests to the
  project, but Supabase doesn't say whether storage traffic counts as activity. Open the Supabase dashboard
  every few days while you are collecting usage.
  [Supabase: project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
- **Only one server may write to the bucket.** Don't run the Docker image elsewhere with the same keys and
  bucket, for example `docker compose` on your laptop with these values in `.env`. Two writers would corrupt the
  backup. Use a separate bucket for local tests.
- **During a deploy**, Render starts the new container before stopping the old one. Changes made in the few
  seconds between the new container's restore and the old one stopping can be lost.
- **Space.** The database is a few megabytes. Supabase's free plan includes 1 GB of storage.
- **To start completely fresh**, delete the `mahilasathi/` folder in the bucket, then redeploy.
- **To turn the backup off**, remove `SUPABASE_S3_ACCESS_KEY_ID`. The server then runs without a backup again.
