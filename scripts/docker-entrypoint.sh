#!/bin/sh
# Self-hosted Docker deploys have no reliable way to inject a runtime secret
# through some hosting panels (env-var mutations that don't propagate to the
# running service). BETTER_AUTH_SECRET is required — better-auth refuses to
# start with the default secret — so generate one on first boot and persist
# it to the /data volume, which survives restarts/redeploys. An explicit
# BETTER_AUTH_SECRET env var, if the platform *does* manage to set one,
# always wins.
set -e

SECRET_FILE="${OMB_DATA_DIR:-/data}/.better-auth-secret"

if [ -z "$BETTER_AUTH_SECRET" ]; then
  if [ -f "$SECRET_FILE" ]; then
    BETTER_AUTH_SECRET="$(cat "$SECRET_FILE")"
  else
    BETTER_AUTH_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    mkdir -p "$(dirname "$SECRET_FILE")"
    printf '%s' "$BETTER_AUTH_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  export BETTER_AUTH_SECRET
fi

# Stay in the foreground as PID 1 instead of exec'ing the server: PID 1 must
# reap orphans, and chromium spawns crashpad handlers and zygote/GPU helpers
# that outlive their parents when a browser-panel session ends — reparented
# to PID 1 and never wait()ed they pile up as zombies until the container
# restarts. wait -n reaps one child at a time while the server runs; TERM is
# forwarded so docker stop still reaches node's graceful shutdown.
"$@" &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" 2>/dev/null' TERM INT
while kill -0 "$NODE_PID" 2>/dev/null; do
  wait -n 2>/dev/null || sleep 2
done
wait "$NODE_PID"
exit $?
