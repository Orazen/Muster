# Muster landing page

A self-contained static marketing site (no build step). Serve it with any
static host, or locally:

```sh
npx serve www
# or
cd www && python3 -m http.server 8080
```

The "Open Muster" links point at `/app` — serve the landing page on the bare
domain (e.g. `muster.orazen.online`) and the app on `/app` (or a subdomain)
behind your reverse proxy. The app itself is a single-page React app served by
the harness server (see `docs/self-host.md`).

Assets in this directory are committed alongside the page so it deploys as-is.
