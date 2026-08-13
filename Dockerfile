# syntax=docker/dockerfile:1.7
#
# Next.js frontend (ARIA) — multi-stage Docker build.
#
# Builds a self-contained ~250MB image using Next.js's `output: 'standalone'`
# (see next.config.ts). The final stage doesn't include node_modules, devDeps,
# or source — only the compiled server, static assets, and the Prisma client.
#
# ─── Build ──────────────────────────────────────────────────────────────────
#   docker build -t aria-web .
#
# ─── Run (needs DATABASE_URL + the rest of .env at runtime) ─────────────────
#   docker run --env-file .env -p 3000:3000 aria-web
#
# ─── Or via docker-compose (recommended — wires up Postgres + ABM) ──────────
#   docker compose up
#
# NOTE on Prisma: we run `prisma generate` at build time (so the client is
# baked into the image) but NOT `prisma db push` / `prisma migrate deploy` —
# those are runtime concerns. The entrypoint script runs `prisma migrate
# deploy` on container start, after the DB is reachable.

# ── 1. Deps stage — install node_modules (cached unless package.json changes) ──
FROM node:20-alpine AS deps
WORKDIR /app

# Bun is used as the package manager in this repo. Install it on alpine.
RUN apk add --no-cache curl unzip bash \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

COPY package.json bun.lock* ./
# `--frozen-lockfile` ensures CI / Docker builds fail loudly if lockfile is
# out of sync with package.json, rather than silently resolving to a different
# dep tree.
RUN bun install --frozen-lockfile

# ── 2. Builder stage — compile the Next.js app ────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client (writes to node_modules/@prisma/client).
# Doesn't need DATABASE_URL — `generate` only reads schema.prisma.
RUN bunx prisma generate

# Disable telemetry during the build (keeps logs clean).
ENV NEXT_TELEMETRY_DISABLED=1

# Build the Next.js app. `output: 'standalone'` (in next.config.ts) produces
# .next/standalone/ — a minimal Node server with only the needed deps inlined.
RUN bun run build

# ── 3. Runner stage — minimal production image ────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Run as a non-root user. Next.js's standalone output expects to run from /app.
# Create the user, chown the app dir, and drop privileges via USER.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Install openssl — required by Prisma's query engine at runtime.
# (Alpine doesn't ship it by default; the prisma client binary needs it.)
RUN apk add --no-cache openssl

# Copy the standalone server (includes its own minimal node_modules).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets — not bundled in standalone, must be copied separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public/ — served at /, also not bundled.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Prisma schema + migrations — needed at startup for `prisma migrate deploy`.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# Entrypoint script — runs migrations before starting the server.
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

# The entrypoint waits for the DB, runs `prisma migrate deploy`, then execs
# the Next.js server. Healthcheck hits the homepage — if it 200s, the server
# is up and responsive.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
