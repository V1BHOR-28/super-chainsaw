# Setting Up a Permanent Local Audiobook Backend with ngrok Tunnel

This guide walks you through running the Audiobook backend locally via Docker and connecting your Vercel-hosted frontend to it using a **stable, permanent ngrok Tunnel URL** that never changes when Docker or your laptop restarts.

---

## How the Stable URL Works

With ngrok's free tier, you can claim a **free static domain** (e.g. `aria-audiobook.ngrok-free.app` or `abruptly-coastland-strangely.ngrok-free.dev`).
- The domain is reserved exclusively for your ngrok account.
- The `tunnel` service inside Docker connects outbound using your `NGROK_AUTHTOKEN` and binds to your reserved domain.
- Every time you start Docker with `docker compose up -d`, it reconnects to the exact same URL automatically.

---

## Step-by-Step Setup Guide

### 1. Get Your Free ngrok Auth Token
1. Log in at [ngrok Dashboard](https://dashboard.ngrok.com).
2. Go to **Your Authtoken** ([dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)).
3. Copy your authtoken.

### 2. Claim Your Free Static Domain
1. In the ngrok sidebar, navigate to **Cloud Edge** → **Domains** ([dashboard.ngrok.com/domains](https://dashboard.ngrok.com/domains)).
2. Claim your free static domain (e.g. `your-name.ngrok-free.app` or `abruptly-coastland-strangely.ngrok-free.dev`).

### 3. Add Credentials to Your Local `.env`
Open `.env` in your project folder and set:
```env
NGROK_AUTHTOKEN=your-ngrok-authtoken-here
NGROK_DOMAIN=your-static-domain.ngrok-free.app
ABM_ALLOWED_ORIGINS=https://ariaggn.vercel.app,http://localhost:3000
```

### 4. Start the Local Docker Setup
In your terminal inside the project directory:
```bash
docker compose up -d --build
```
Docker will start both the `audiobook` backend service and the `tunnel` connector service.

To view live tunnel connection logs:
```bash
docker compose logs -f tunnel
```

### 5. Verify Your Permanent Public Endpoint
Test your tunnel URL in a browser or terminal:
```bash
curl https://your-static-domain.ngrok-free.app/api/voices
```
You should receive a JSON list of available Edge TTS voices.

### 6. Connect Vercel Frontend to Your Local Backend
1. Go to your [Vercel Dashboard](https://vercel.com).
2. Select your **ARIA** project → **Settings** → **Environment Variables**.
3. Set or update:
   ```env
   ABM_SERVICE_URL=https://your-static-domain.ngrok-free.app
   ```
4. Trigger a new deployment on Vercel (or push a commit).

---

## Quick Reference Commands

| Command | What it does |
|---|---|
| `docker compose up -d --build` | Starts/rebuilds backend + ngrok tunnel |
| `docker compose logs -f tunnel` | Views live ngrok tunnel logs |
| `docker compose ps` | Checks health status of backend and tunnel containers |
| `docker compose stop` | Safely stops containers without losing audio data |
