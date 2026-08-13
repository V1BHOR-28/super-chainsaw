# Deploying the Audiobook Maker to Hugging Face Spaces

This guide walks you through replacing Render with Hugging Face Spaces (HF) for the Flask audiobook backend. HF's Docker SDK gives you:

- **No 15-minute sleep** like Render's free tier
- **No credit card** required — ever
- 2 vCPU + 16GB RAM (more than Render's 512MB free tier)
- 10GB persistent storage at `/data` (survives restarts)
- Auto-deploys from GitHub on every push

Total time: **~15 minutes**. Prerequisites: a Hugging Face account (free, no credit card).

---

## Why HF Spaces over Render

| | Render free | HF Spaces free |
|---|---|---|
| Sleeps after inactivity | ✅ 15 min | ❌ Never |
| Cold start on wake | ~30s | N/A |
| RAM | 512MB | 16GB |
| Persistent storage | ❌ Ephemeral disk | ✅ 10GB at `/data` |
| Credit card required | ❌ | ❌ |
| Auto-deploy from GitHub | ✅ | ✅ |

The 16GB RAM is a big deal — audiobook generation with ffmpeg + Edge-TTS + multiple chapter MP3s in flight will OOM on Render's 512MB. On HF you have headroom.

---

## Step 1 — Create a Hugging Face account

If you don't have one:

1. Go to https://huggingface.co/join
2. Sign up with email or GitHub
3. **No credit card asked for.** Done.

---

## Step 2 — Create the Space

1. Go to https://huggingface.co/new-space
2. Fill in:
   - **Space name**: `aria-abm` (or whatever you like — this becomes part of the URL)
   - **License**: pick whatever matches your project (the repo uses "Private project. All rights reserved." — pick "Other" if unsure)
   - **SDK**: **Docker** ← this is critical, do not pick Gradio/Streamlit
   - **Space SDK**: leave as Docker
   - **Visibility**: **Private** (recommended — your API shouldn't be public)
3. Click **Create Space**

You'll land on an empty Space page. The URL will be something like `https://huggingface.co/spaces/YOUR_USERNAME/aria-abm`.

---

## Step 3 — Connect the Space to your GitHub repo

You have two options here. **Option A is recommended** — it auto-syncs, so every `git push` to your branch redeploys the Space.

### Option A — Connect via GitHub (auto-deploy)

1. In your new Space, click the **Settings** tab.
2. Scroll down to **"Repository"** → click **"Link a GitHub repository"**.
3. Authorize HF's GitHub app (one-time).
4. Pick `V1BHOR-28/super-chainsaw` from the dropdown.
5. Set **"Root directory"** to `mini-services/audiobook-maker`.
6. Set **"Branch"** to `feat/hf-spaces-deploy` (the branch with the HF config) — or `main` once you've merged it.
7. Click **Link**.

HF will now auto-build on every push. The first build takes ~5 minutes (downloading ffmpeg, Python deps, etc.). Subsequent builds are ~30 seconds thanks to layer caching.

### Option B — Manual file copy (slower, no auto-sync)

If you don't want HF to have GitHub access:

1. Clone the HF Space repo locally:
   ```bash
   git clone https://huggingface.co/spaces/YOUR_USERNAME/aria-abm
   cd aria-abm
   ```
2. Copy everything from `mini-services/audiobook-maker/` into it:
   ```bash
   cp -r /path/to/super-chainsaw/mini-services/audiobook-maker/* .
   cp -r /path/to/super-chainsaw/mini-services/audiobook-maker/.dockerignore .
   ```
3. Commit + push:
   ```bash
   git add .
   git commit -m "Initial deploy"
   git push
   ```
4. HF auto-builds on push.

---

## Step 4 — Add your secrets

The Space needs the same environment variables Render had. Add them in HF, not in your code.

1. Go to your Space → **Settings** tab.
2. Scroll to **"Variables and secrets"**.
3. Click **"New secret"** for each of the following (use "Secret", not "Variable" — secrets are encrypted and not visible in the UI after saving):

| Name | Value | Where to get it |
|---|---|---|
| `ABM_S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` | Cloudflare R2 dashboard |
| `ABM_S3_ACCESS_KEY` | your R2 access key | R2 → Manage R2 API Tokens |
| `ABM_S3_SECRET_KEY` | your R2 secret key | same as above |
| `ABM_S3_BUCKET` | your R2 bucket name | R2 dashboard |
| `ABM_LLM_API_KEY` | your Groq API key | https://console.groq.com/keys |
| `ABM_GEMINI_API_KEY` | your Gemini API key | https://aistudio.google.com/apikey |
| `ABM_ALLOWED_ORIGINS` | `https://your-vercel-app.vercel.app,http://localhost:3000` | your Vercel domain |

4. After adding all secrets, click **"Restart Space"** (top right). The Space rebuilds with the new secrets.

---

## Step 5 — Verify the Space is up

1. Go to your Space's main page (the "App" tab).
2. After the build finishes (~5 min first time), you should see a JSON response like:
   ```json
   {"status": "ok", "service": "audiobook-maker", "version": "..."}
   ```
3. If you see an error, click the **"Logs"** tab to see what failed. Common issues:
   - `ModuleNotFoundError`: a dep is missing from `requirements.txt`
   - `Permission denied on /data/abm-data`: the Dockerfile's `useradd` step failed — re-check it
   - Build timeout: the build took >30 min (HF's limit). Unlikely on this codebase.

---

## Step 6 — Point your Vercel frontend at the new Space

Now update the Vercel env vars to send `/api/abm/*` requests to HF instead of Render.

1. Go to your Vercel project → **Settings** → **Environment Variables**.
2. Find `ABM_SERVICE_URL` and change its value from your Render URL to:
   ```
   https://YOUR_USERNAME-aria-abm.hf.space
   ```
   (replace `YOUR_USERNAME` and adjust `aria-abm` if you named your Space differently)
3. Find `NEXT_PUBLIC_ABM_DIRECT_URL` and update it to the same value.
4. Click **Save** for each.
5. Go to **Deployments** → click the ⋮ menu on the latest deployment → **Redeploy** (no changes needed — this just picks up the new env vars).

After the redeploy completes (~2 min), your Vercel app is talking to HF instead of Render.

---

## Step 7 — Test the full flow

1. Visit your Vercel app.
2. Sign in.
3. Go to the audiobook library.
4. Upload an EPUB.
5. Wait for it to analyze (should take 10-30 seconds — much faster than Render's cold-start path).
6. Pick a chapter, click generate.
7. After ~1-2 minutes per chapter, you should hear audio playback with synced transcript + BGM.

If something breaks, check both logs:
- **HF logs**: your Space → "Logs" tab
- **Vercel logs**: your Vercel project → "Logs" tab, filter by `/api/abm/`

---

## Step 8 — Turn off Render

Once you've confirmed everything works on HF for a few days:

1. Go to your Render dashboard.
2. Find the `aria-audiobook-service`.
3. Click **Suspend** (pauses it — keeps the config in case you want to roll back).
4. After a week of solid HF usage, click **Delete** to fully clean up.

Don't delete Render on day one — keep it as a fallback for the first week.

---

## How auto-deploy works

Once Step 3 (GitHub connection) is done, every push to your linked branch triggers a rebuild:

1. You push a commit to `feat/hf-spaces-deploy` (or `main` after merge).
2. HF detects the push within ~30 seconds.
3. It runs `docker build` from `mini-services/audiobook-maker/Dockerfile`.
4. The new image replaces the old one with zero downtime (HF keeps the old container running until the new one is healthy).
5. The new container picks up your latest secrets.

If a build fails, the **old** container keeps running — your users don't see an outage. You'll see a red ❌ on the Space's main page; click "Logs" to debug.

---

## How persistent storage works on HF

The `/data` directory is mounted as a persistent volume. Anything you write there survives container restarts, rebuilds, and Space pauses. Anything outside `/data` is **ephemeral** — wiped on every rebuild.

This Dockerfile sets `ABM_DATA_DIR=/data/abm-data`, so the Flask app writes:
- Uploaded EPUBs (temporarily, before parsing)
- Generated chapter MP3s (before uploading to R2)
- Job state JSON files
- BGM cue caches

to `/data/abm-data`. They survive across restarts.

R2 is still the **primary** persistence layer (chapter MP3s are uploaded to R2 after generation). `/data` is for working files + job state. If you ever need to wipe everything, just delete the Space and recreate it — R2 keeps the audio.

---

## Cost / limits

- **Free tier**: 2 vCPU, 16GB RAM, 10GB `/data` storage, unlimited public spaces, private spaces limited to 5 free
- **No credit card ever** — even if you hit limits, HF just throttles; they don't bill you
- **Time limits**: builds must finish in <30 min (this one takes ~5 min). Requests have no per-request timeout (unlike Vercel's 60s).
- **Sleep behavior**: HF Spaces **don't sleep** by default on the free tier. There's an optional "sleep after 48h of inactivity" toggle you can enable to save resources — but it's opt-in, not forced.

---

## Troubleshooting

### "Build failed — out of disk space"

HF's build limit is 10GB. The Dockerfile shouldn't hit this, but if you add a heavy dep later, check `docker image ls` locally to see image size.

### "App won't start — permission denied"

The Dockerfile creates a user `user` with UID 1000 and chowns `/app` + `/data` to it. If you add a step that writes files outside those paths, you'll get permission errors. Fix: chown the new path to `user:user` in the Dockerfile.

### "CORS error in browser console"

You forgot to add your Vercel domain to `ABM_ALLOWED_ORIGINS`. Go to Space Settings → Variables and secrets → edit the secret → add your domain (comma-separated, no trailing slash).

### "502 Bad Gateway from Vercel"

HF Space is still building or has crashed. Check the Space's "Logs" tab. If it's just building, wait — the Vercel proxy will recover automatically once HF is back up.

### "Audio doesn't play — 403 from R2"

R2 token permissions changed or expired. Re-generate the R2 API token at Cloudflare → R2 → Manage R2 API Tokens, then update the `ABM_S3_*` secrets in HF Settings.

---

## Rollback plan

If HF is broken and you need to fall back to Render:

1. Vercel → Settings → Environment Variables.
2. Change `ABM_SERVICE_URL` back to your Render URL.
3. Change `NEXT_PUBLIC_ABM_DIRECT_URL` back to your Render URL.
4. Redeploy Vercel.

Takes ~2 minutes. Keep your Render service **suspended** (not deleted) for the first month so you have this fallback.

---

## What's next

After you've confirmed HF works for a week:

1. Merge the `feat/hf-spaces-deploy` branch into `main`.
2. Delete the Render service.
3. (Optional) Add a second HF Space in a different region for redundancy — not necessary for a side project, but useful if you ever scale.
