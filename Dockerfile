ARG NODE_VERSION=20

# ---------- Frontend build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build

# ---------- Backend build ----------
FROM node:${NODE_VERSION}-bookworm-slim AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc

# ---------- Runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG GIT_REVISION=unknown
ARG BUILD_DATE=
LABEL org.opencontainers.image.revision=$GIT_REVISION
LABEL org.opencontainers.image.created=$BUILD_DATE
LABEL org.opencontainers.image.title="soundreel"
LABEL org.opencontainers.image.source="https://github.com/mmondora/soundreel"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    GIT_REVISION=$GIT_REVISION

WORKDIR /app

# Install prod deps only
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit && npm cache clean --force

# Compiled backend
COPY --from=backend-build /app/backend/dist ./dist

# Static frontend served by Fastify (under dist/public)
COPY --from=frontend-build /app/frontend/dist ./dist/public

# Default prompts (optional)
COPY backend/prompts ./prompts

# DB schema
COPY backend/src/db/init.sql ./init.sql

EXPOSE 8080

USER node

CMD ["node", "dist/server.js"]
