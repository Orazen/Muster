# Dots Lab (vendored copy)

A faithful copy of [projectlobster/dots-lab](https://github.com/projectlobster/dots-lab) —
"design an animated character for your AI agent": 12 procedurally generated
shapes, 18 expressions, 8 hand-authored agent-state animations (Idle,
Listening, Thinking, Writing, Success, Alert, Error, Asleep), and export to
PNG / static+animated SVG / GIF / ZIP. The whole app is one dependency-free
HTML file.

- **Source:** `projectlobster/dots-lab` @ `7bc6880` (2026-10-01), itself a
  local replica of <https://dots-lab.pages.dev> by Guillaume
  (@guillaume_rygn).
- **Vendored files:** `index.html` (107,097 bytes — the entire app, inline
  CSS/JS, zero dependencies) and `server.mjs` (1,829 bytes — zero-dependency
  static file server). The upstream `preview/` media (~3.8 MB) is
  intentionally not vendored.
- **Modified: nothing.** Byte-identical to upstream. The app's credit footer
  links the upstream author's profile.
- **License:** none claimed upstream; the original design belongs to its
  author, and the upstream README asks reusers to credit and/or contact
  them. Treat this copy as internal evaluation only — before any public or
  product-facing use of the character designs, settle credit/permission
  with the original author (owner decision).

## Run locally

```sh
cd www/dots-lab
node server.mjs            # http://127.0.0.1:4173/
PORT=8080 node server.mjs  # any port
```

Note: upstream reads `PORT` from the environment *before* the `--port`
flag, so a stale `PORT` env var silently overrides the flag (observed
locally). The server binds loopback by default and refuses path traversal.

## In Muster

Standalone as above, or served by the existing marketing static handler:
self-hosted deployments running with `OMB_MARKETING_DIR=www` serve this
directory automatically at `/dots-lab/index.html` (any real file under the
marketing dir with an extension is served; no product-code wiring was added
or changed).
