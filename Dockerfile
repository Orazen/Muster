# syntax=docker/dockerfile:1

# ── build stage: compile the web UI (dist/) and the self-contained server
#    bundle (dist-server/). Electron is a devDependency and is discarded here —
#    only the web client and the bundled Node server reach the final image.
FROM node:24-slim AS build
WORKDIR /app

# pnpm needs these to reify the lockfile exactly.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json tsconfig.server.json tsconfig.server.build.json vite.config.ts index.html ./
COPY src src
COPY server server
COPY companion companion
COPY scripts scripts
COPY public public
COPY www www

RUN pnpm install --frozen-lockfile

RUN pnpm build \
  && pnpm build:server

# ── runtime stage: slim Node image with just the built artifacts.
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    OMB_HOST=0.0.0.0 \
    OMB_PORT=8799 \
    OMB_DATA_DIR=/data \
    OMB_STATIC_DIR=/app/dist \
    OMB_MARKETING_DIR=/app/www

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
CMD ["node", "dist-server/index.js"]
