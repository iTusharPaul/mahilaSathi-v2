# syntax=docker/dockerfile:1
# One deployable: Express serves the API and the built client from a single port.

# ─── Runtime dependencies (server only) ──────────────────────────────────────
# The client is shipped pre-built, so its libraries (React, MapLibre, icons, chat SDK) are not needed at
# runtime. Install production dependencies for the server workspace (and the shared package it uses) only.
FROM node:22-bookworm-slim AS deps
# Toolchain for better-sqlite3 in case no prebuilt binary matches this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=@mahilasathi/server --include-workspace-root

# ─── Build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# On small build machines (Docker Desktop's default VM can have ~650 MB) Node picks a ~320 MB heap, and
# bundling the client (MapLibre, chat SDK) needs more. Raise the limit for the build stage only; the VM's
# swap absorbs the peak. The runtime image is unaffected.
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY client client
RUN npm run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/mahilasathi.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/package.json client/package.json
COPY --from=build /app/client/dist client/dist
# Migrations and the NCR boundary dataset are read at startup.
COPY database database
# SQLite lives on a mounted volume so data survives redeploys. Run as the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
