# Self-host Muster (web)

Muster is local-first by default, but it can run as a single-user web service
you self-host and open in any browser — no Electron, no macOS requirement. The
same harness server and React UI, packaged into one Docker image.

> **One-user model.** Muster has no accounts, no multi-tenancy, and no hosted
> auth. Self-hosting exposes *your* single workspace. Only deploy it where you
> alone (or people you fully trust) can reach it, and put it behind a reverse
> proxy with TLS if you expose it beyond your machine.

## Quick start

```sh
docker compose up -d --build
```

Open <http://localhost:8799>. Bots, transcripts, config, and keys persist in the
`muster-data` volume.

To reach it from another machine, port-forward or reverse-proxy port `8799`:

```sh
# on the server, listen on all interfaces (the image already does):
docker compose up -d
# then browse to http://YOUR_SERVER:8799
```

## Configuration

All settings are environment variables on the `muster` service.

| Variable | Default | What it does |
|---|---|---|
| `OMB_HOST` | `127.0.0.1` | Bind host for the harness + UI. The image sets `0.0.0.0` (self-hosted). |
| `OMB_PORT` | `8799` | Port the service listens on. |
| `OMB_DATA_DIR` | `~/.muster` | Where bots/transcripts/config live. The image uses `/data` (a volume). |
| `OMB_STATIC_DIR` | *(unset)* | Directory of the built web UI. The image sets `/app/dist`. |
| `OMB_PUBLIC_HOST` | *(unset)* | Public hostname (no port) when serving over a domain, e.g. `muster.example.com`. |
| `OMB_ALLOWED_ORIGINS` | *(unset)* | Comma-separated extra origins allowed to call the API cross-origin (e.g. `https://app.example.com`). |
| `XAI_API_KEY` | — | Pre-seed the xAI credential instead of pasting it in Settings. |
| `COMPOSIO_API_KEY` | — | Pre-seed Composio (connected apps). |
| `BOX_TOKEN` | — | Pre-seed the Box cloud computer. |
| `OPENCODE_API_KEY` | — | Pre-seed the OpenCode Go engine. |
| `OMB_TTS_KEY` | — | Pre-seed the ElevenLabs voice key. |

## Security model

- **Default is loopback-only.** On `127.0.0.1` the server rejects non-loopback
  hosts and origins (DNS-rebinding + CSRF protection) and keeps peer-agent
  comms (`/api/internal/*`) loopback-only with a per-boot token.
- **Binding to `0.0.0.0` opts in.** Setting `OMB_HOST` to a non-loopback address
  (as the Docker image does) is the explicit "expose me" signal: the host gate
  widens, and same-origin browser requests are allowed. Cross-origin clients
  still require `OMB_ALLOWED_ORIGINS`.
- **Peer-agent comms never leave loopback**, even under `0.0.0.0` — a remote
  socket to `/api/internal/*` is rejected before the token check.
- **There is no authentication.** Anyone who can reach the port can drive your
  bots and read everything. Put a reverse proxy with auth or TLS in front of it
  before any non-local exposure.

### Reverse proxy (recommended)

```nginx
server {
    listen 443 ssl;
    server_name muster.example.com;

    # TLS + optional basic auth here.

    location / {
        proxy_pass http://127.0.0.1:8799;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # SSE for the live event stream must not be buffered.
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection "";
    }
}
```

Set `OMB_PUBLIC_HOST=muster.example.com` and
`OMB_ALLOWED_ORIGINS=https://muster.example.com` on the `muster` service.

## Models and computers

The model picker reflects whichever agent CLIs are installed and logged in on
the machine running the harness. The stock image ships **no** agent CLIs — bots
show as unavailable until you provide one:

- **Build a custom image** that installs `claude`, `codex`, or `grok` (and their
  auth) on top of `muster`, or
- **Use engine credentials** where a driver only needs a key (OpenCode Go,
  Compose/Box), or
- **Run the container on a machine** where the CLIs are already on `PATH` via a
  bind mount (see [`engines`](https://github.com/tharunramagiri/Muster#engines)).

Cloud computers (Box) work out of the box with a `BOX_TOKEN`. "This Mac" local
computer control is **not** available in a container — it requires the desktop
app.

## Building a custom image with agent CLIs

```dockerfile
FROM muster:latest
# Install a CLI and log it in (Caveat: bake no secrets into the image).
RUN npm install -g @anthropic-ai/claude-code
# …then run as usual; the model picker lists Claude once it is logged in.
```

## Updating

```sh
docker compose pull && docker compose up -d
```

Data survives upgrades because it lives in the `muster-data` volume.
