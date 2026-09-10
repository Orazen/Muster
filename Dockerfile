# syntax=docker/dockerfile:1

# ── build stage: compile the web UI (dist/) and the self-contained server
#    bundle (dist-server/). Electron is a devDependency and is discarded here —
#    only the web client and the bundled Node server reach the final image.
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 rebuilds from source via node-gyp when its prebuilt
# binding download fails — node-gyp needs python3, make and g++, none of
# which ship in node:*-slim. Without these every Dokploy build dies in
# pnpm install. (One layer; the second identical apt layer that used to
# follow defeated this one's cache for zero benefit.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# pnpm needs these to reify the lockfile exactly.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Dependency layer FIRST: manifests before source. Any source edit used to
# invalidate this whole stage (including better-sqlite3's node-gyp path) —
# now pnpm install only re-runs when a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.server.json tsconfig.server.build.json vite.config.ts index.html ./
COPY src src
COPY server server
# server tests import the browser harness from e2e/, and pnpm build
# type-checks them — without this the in-image tsc dies on TS2307.
COPY e2e e2e
COPY companion companion
COPY scripts scripts
COPY public public
COPY www www

RUN pnpm build \
  && pnpm build:server

# ── runtime stage: slim Node image with just the built artifacts.
FROM node:22-slim AS runtime
WORKDIR /app

# Chromium powers the per-bot browser panel (server/browser-panel.ts). It
# ships IN the image rather than relying on the panel's Chrome-for-Testing
# auto-install so the panel works on first click with no download delay —
# unzip/fonts stay because headless Chromium still renders real pages. The
# container runs non-root without user namespaces, so the panel spawns it
# with --no-sandbox (browser-panel.ts detects containers).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium unzip fonts-liberation fonts-noto-color-emoji ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    OMB_HOST=0.0.0.0 \
    OMB_PORT=8799 \
    OMB_DATA_DIR=/data \
    OMB_STATIC_DIR=/app/dist \
    OMB_MARKETING_DIR=/app/www \
    MUSTER_CHROME_PATH=/usr/bin/chromium

# Self-hosted web UI and harness server (both fully self-contained), plus the
# marketing landing page served at "/" for the public domain.
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/www ./www

# Persist bots, transcripts, config and keys outside the container.
VOLUME ["/data"]

EXPOSE 8799

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8799/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Self-hosting note: the listen socket is 0.0.0.0 (set above), which opts this
# deployment out of the strict loopback gate. For a named public hostname, also
# set OMB_PUBLIC_HOST (e.g. muster.example.com).
#
# BETTER_AUTH_SECRET must be set or better-auth refuses to start. Some
# hosting panels' "set an env var" API doesn't reliably propagate to the
# running service, so this entrypoint self-generates and persists one to
# the /data volume on first boot instead of depending on that path.
# Run unprivileged: the image binds 0.0.0.0 and serves a public site, so a
# compromised process must not own the container. /data is chowned because
# the entrypoint persists BETTER_AUTH_SECRET and runtime state there; named
# volumes inherit this ownership on first use.
RUN useradd --system --uid 10001 --create-home muster \
  && mkdir -p /data \
  && chown -R muster:muster /data
USER muster

# chmod must happen while still root — after USER muster it fails with
# "Operation not permitted" and every Dokploy build dies here.
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist-server/index.js"]
