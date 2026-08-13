# Setting Up a Permanent Local Audiobook Backend with Cloudflare Tunnel

This guide walks you through running the Audiobook backend locally via Docker and connecting your Vercel-hosted frontend to it using a **stable, permanent Cloudflare Tunnel URL** that never changes when Docker or your laptop restarts.

---

## How the Stable URL Works

Unlike temporary tunnels that generate a new random domain every restart, a **Named Cloudflare Tunnel** uses a token bound to your Cloudflare Zero Trust account. 
- The token connects outbound to Cloudflare servers.
- Your public domain (e.g. `aria.yourdomain.com`) is configured once in Cloudflare's dashboard.
- Every time you start Docker with `docker compose up -d`, it reconnects to the exact same URL automatically.

---

## Step-by-Step Setup Guide

### 1. Sign Up for Cloudflare Zero Trust
1. Go to [Cloudflare Zero Trust Console](https://one.dash.cloudflare.com).
2. Log in with your Cloudflare account (free tier, no credit card required).

### 2. Create a Named Tunnel
1. In the Zero Trust sidebar, navigate to **Networks** → **Tunnels**.
2. Click **Add a tunnel**.
3. Choose **Cloudflared** as the connector type and click **Next**.
4. Name your tunnel (e.g., `aria-audiobook`) and click **Save tunnel**.

### 3. Copy Your Tunnel Token
1. On the **Install and run a connector** page, select **Docker**.
2. Copy the token string inside the run command (the long token starting with `eyJ...`).
3. Open your local `.env` file in the repo directory and set:
   ```env
   CF_TUNNEL_TOKEN=eyJ...your-copied-token-here...
   ```

### 4. Configure Public Hostname Routing
1. On the next screen (**Route traffic**), add a **Public Hostname**:
   - **Subdomain**: `aria` (or your preferred subdomain)
   - **Domain**: Choose your domain connected to Cloudflare
   - **Type**: `HTTP`
   - **URL**: `audiobook:5601` *(Note: use `audiobook:5601`, matching the Docker container name and internal port)*
2. Click **Save hostname**.

### 5. Start the Local Docker Setup
In your terminal inside the project directory:
```bash
docker compose up -d
```
Docker will start both the `audiobook` backend service and the `tunnel` connector service.

### 6. Verify Your Permanent Public Endpoint
Test your tunnel URL in a browser or terminal:
```bash
curl https://aria.yourdomain.com/api/voices
```
You should receive a JSON list of available Edge TTS voices.

### 7. Connect Vercel Frontend to Your Local Backend
1. Go to your [Vercel Dashboard](https://vercel.com).
2. Select your **ARIA** project → **Settings** → **Environment Variables**.
3. Set or update:
   ```env
   ABM_SERVICE_URL=https://aria.yourdomain.com
   ```
4. Trigger a new deployment on Vercel (or push a commit).

---

## Quick Reference Commands

| Command | What it does |
|---|---|
| `docker compose up -d` | Starts backend + tunnel in detached background mode |
| `docker compose logs -f tunnel` | Views live Cloudflare Tunnel connection logs |
| `docker compose ps` | Checks health status of backend and tunnel containers |
| `docker compose stop` | Safely stops containers without losing audio data |
