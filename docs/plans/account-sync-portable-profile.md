# Account sync: one identity across desktop, web, and cloud

_Operator note, 2026-09-05. The report this answers: "same email on the web
app and the desktop app didn't sync." Current behavior, why it is that way,
the Hermes/Google-Drive storage pattern the user pointed at
(porteden.com/guides/add-google-drive-to-hermes-agent), and the design this
repo should grow into._

## 1. What "sync" means in Muster today (and what it already does)

Muster is local-first by design: the desktop install is the **source of
truth** for its own workspace. What already syncs across every surface:

- **Identity** — one account (email or Google) signs in everywhere. Pairing a
  desktop to the cloud links the local account to the cloud identity
  (`/api/pair/*`, single-use codes); the merge-code flow folds two accounts
  into one; profile name/email changes propagate.
- **Remote control** — the CLI, mobile companions, and the web app read the
  SAME SSE stream and drive the SAME bots through the paired harness.
- **Verifiable artifacts** — receipts are signed and verifiable anywhere.

What deliberately does **not** sync: transcripts, bot configs, MEMORY.md,
provider keys. Those live in `~/.muster` on the desktop (or the cloud
install's data dir). That was a privacy stance, and it created the surprise:
**two installs with the same Google login are two separate workspaces.** The
roster doesn't follow the human between machines.

## 2. The pattern the user pointed at

The Hermes guide (Add Google Drive to Hermes agent) describes agents whose
**entire working state — config, sessions, memory, work products — lives in
one folder the user owns** (their Google Drive), so any runtime the agent
boots on is the same agent: mount the folder, resume everything, delete the
runtime and nothing is lost. "All session and work stored there, not on the
cloud vendor and not just on the PC."

Translated to Muster: the workspace (`~/.muster`: bots.json, memory/,
transcripts, config) becomes a **portable profile** the user owns and can
bring to any install.

## 3. The design this should grow into

### 3.1 Portable workspace profile (the Muster-native version)

- A workspace **bundle** = `bots.json` + `memory/**` + threads + non-secret
  config, exported/imported as one encrypted archive (age or AES-GCM under
  the account's key). Provider keys stay excluded by default (write-only
  stays write-only); the user opts in per key.
- **Sync transport, user's choice, no Muster cloud in the middle by
  default**:
  1. Google Drive (the pattern the user asked for) — one app folder; the
     desktop client watches and pushes/pulls the bundle. OAuth scope =
     drive.appdata (private to the app).
  2. Muster Cloud sync — for people who want it to just work; same bundle,
     encrypted at rest so the server holds ciphertext only.
  3. Plain file — the bundle lands in any folder the user syncs themselves
     (iCloud/Dropbox/Syncthing). Zero new infrastructure.
- **Merge policy**: local-first with last-writer-wins per record
  (bot-level), never field-level; memory files merge by section markers;
  conflicts surface in a review card instead of silently overwriting — this
  is the receipts/approvals philosophy applied to sync.
- **Secrets never sync silently**: keys ride only if explicitly included,
  travel only inside the encrypted bundle, and are re-wrapped per device.

### 3.2 What this fixes

- "Same Gmail, two machines, different bots" — the roster follows the human.
- Backup is intrinsic (the bundle always exists outside the machine).
- Migration/recovery: lost Mac → sign in, pull bundle, the whole team is
  back. Vaultgram already proves the restore UX pattern.

### 3.3 Order of work

1. **Export/import bundle** (ships value immediately, no sync infra): one
   command + Settings button. ~1–2 days.
2. **Plain-folder sync** (watch the bundle dir, debounced push/pull,
   conflict cards). ~2–3 days.
3. **Google Drive appData transport** (OAuth via Composio-style flow, or
   direct Google OAuth). ~2–3 days.
4. **Cloud-encrypted sync** as the hosted convenience tier.

### 3.4 The rule that keeps trust intact

Sync is **opt-in per workspace**, the bundle is **encrypted client-side**
(the transport never holds plaintext), and the UI says in one sentence what
leaves the machine. The existing honesty sections (/skill.md, README) gain
one line: "your workspace leaves your machine only if you turn on sync, and
even then it's encrypted to your key."
