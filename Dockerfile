ARG NODE_VERSION=20

# ---------- Dependency manifests, without the release number ----------
# A version bump rewrote package.json and the lock file and, with them, the cache key of every `npm install` below:
# three installs per release, about five minutes, against the 300 s the deploy watcher gives a build (2.9.1 needed a
# manual warm-up). The stages below take their manifests from here, byte-identical from one release to the next, so
# the installs stay cached until a dependency really changes. See docker/strip-version.cjs.
FROM node:${NODE_VERSION}-bookworm-slim AS manifests
WORKDIR /m
COPY docker/strip-version.cjs /strip-version.cjs
COPY backend/package.json backend/package-lock.json* ./backend/
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN node /strip-version.cjs backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json

# ---------- Frontend build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY --from=manifests /m/frontend/ ./
RUN npm ci --no-fund --no-audit
# the real package.json comes with the sources (vite reads the version from it)
COPY frontend/ ./
RUN npm run build

# ---------- Backend build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS backend-build
WORKDIR /app/backend
COPY --from=manifests /m/backend/ ./
RUN npm install --no-fund --no-audit
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc

# ---------- Runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Chromium for Playwright JS-rendering fallback
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI: content-analysis fallback when the local Ollama model
# returns nothing (see services/claudeFallback.ts)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Install prod deps only (from the manifests without the release number: see the first stage)
COPY --from=manifests /m/backend/ ./
RUN npm install --omit=dev --no-fund --no-audit && npm cache clean --force
# The real manifest (the release number the app reports) goes in after the install, where it invalidates nothing.
COPY backend/package.json ./package.json

# Compiled backend
COPY --from=backend-build /app/backend/dist ./dist

# Static frontend served by Fastify (under dist/public)
COPY --from=frontend-build /app/frontend/dist ./dist/public

# Default prompts (optional)
COPY backend/prompts ./prompts

# DB schema
COPY backend/src/db/init.sql ./init.sql

# The runner reads these at boot. Without this COPY it finds an empty directory
# and silently applies nothing — worse than having no runner at all.
#
# The destination must stay next to the compiled runner (`dist/db/runMigrations.js`),
# because that is what its default `path.join(__dirname, 'migrations')` resolves
# to. They used to disagree — files here, runner looking in `dist/db` — and only
# MIGRATIONS_DIR in docker-compose.yml bridged the gap, which made a hand-run
# container or a second compose file boot *successfully* against a schema with
# no `kind`, `priority` or `reanalyze` column. MIGRATIONS_DIR is now an
# override, not the thing that makes it work.
COPY backend/src/db/migrations ./dist/db/migrations

# Build metadata goes LAST. The date and the commit change on every build, so placed above the apt and npm layers
# (as it was until 2.10.0) they invalidated those layers each time: every deploy downloaded chromium and the Claude Code
# CLI again, about 4 minutes against the watcher's 300 s limit, and a warm cache from a manual build never helped.
ARG GIT_REVISION=unknown
ARG BUILD_DATE=
ENV GIT_REVISION=$GIT_REVISION
LABEL org.opencontainers.image.revision=$GIT_REVISION \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.title="soundreel" \
      org.opencontainers.image.source="https://github.com/mmondora/soundreel"

EXPOSE 8080

USER node

CMD ["node", "dist/server.js"]
