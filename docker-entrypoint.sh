#!/bin/sh
# Docker entrypoint for the ARIA Next.js frontend.
#
# Responsibilities (in order):
#   1. Wait for the DATABASE_URL host to accept TCP connections.
#      Without this, `prisma migrate deploy` fails on cold starts because
#      Postgres hasn't finished booting. 30 attempts × 2s = 60s ceiling.
#   2. Run `prisma migrate deploy` — applies any pending migrations.
#      Idempotent: no-op when the schema is already up to date.
#   3. Exec the Next.js server (CMD) with the original PID so it receives
#      SIGTERM cleanly on `docker stop`.
#
# This script intentionally does NOT run `prisma db push` (used by the Vercel
# build) — `db push` is for dev and doesn't create migration files. In Docker
# we want the controlled, reviewable migration flow.
set -e

# ── 1. Wait for Postgres ────────────────────────────────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set. Pass it via --env-file .env or docker-compose." >&2
  exit 1
fi

# Extract host + port from the postgres:// connection string.
# Handles: postgresql://user:pass@host:5432/db?sslmode=require
DB_HOST=$(printf '%s\n' "$DATABASE_URL" | sed -E 's|^.*@([^:]+):([0-9]+).*|\1|')
DB_PORT=$(printf '%s\n' "$DATABASE_URL" | sed -E 's|^.*@([^:]+):([0-9]+).*|\2|')

if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ]; then
  echo "[entrypoint] WARNING: couldn't parse host:port from DATABASE_URL — skipping DB wait." >&2
else
  echo "[entrypoint] Waiting for Postgres at ${DB_HOST}:${DB_PORT}…"
  ATTEMPTS=0
  MAX_ATTEMPTS=30
  until nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
      echo "[entrypoint] FATAL: Postgres not reachable after ${MAX_ATTEMPTS} attempts." >&2
      exit 1
    fi
    echo "[entrypoint]   attempt ${ATTEMPTS}/${MAX_ATTEMPTS} — retrying in 2s…"
    sleep 2
  done
  echo "[entrypoint] Postgres is up."
fi

# ── 2. Apply migrations ─────────────────────────────────────────────────────
echo "[entrypoint] Running prisma migrate deploy…"
# `prisma migrate deploy` reads prisma/migrations/ and applies anything pending.
# Safe to run on every start — no-op when nothing's pending.
# We use npx here because the standalone build doesn't include the prisma CLI.
npx --yes prisma migrate deploy || {
  echo "[entrypoint] WARNING: prisma migrate deploy failed. Continuing anyway — schema may be out of sync." >&2
}

# ── 3. Hand off to the Next.js server ───────────────────────────────────────
echo "[entrypoint] Starting Next.js server…"
# `exec` replaces the shell with node so signals propagate correctly.
exec "$@"
