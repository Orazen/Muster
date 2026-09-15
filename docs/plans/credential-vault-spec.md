# Credential vault (X5) — spec, implementation deferred

Status: **specified, not built** (2026-09-15). Deliberate: this is
security-sensitive code (secrets at rest + autofill into live browser
sessions). Shipping a half-vault is worse than shipping none — it becomes
the place users trust keys to before the boundaries exist. Ported model:
BetterWright's URL-gated credentials (`docs/credentials.md`, MIT) fused
with the benchmark's "Preview is not permission" discipline.

## What it is

Per-bot, encrypted, origin-scoped credential records that the browser
tooling can fill on allowlisted origins only — with the filled values
redacted from every observation the model sees.

## Data model (server/credential-vault.ts — new)

- Record: `{ id, botId, label, origin, username?, fields: EncryptedBlob, createdAt, lastUsedAt, fillCount }`
- `origin` is an exact scheme+host+port tuple (NOT a prefix, NOT a
  substring — `https://app.acme.com` must never match `https://evil.app.acme.com.attacker.tld`).
  Store the parsed tuple; validate with WHATWG URL at the boundary.
- Encrypted at rest with the existing per-deployment key hierarchy
  (`deploymentSigningSecret()` / the passphrase-store decision from
  ceo-log Loop 65): AES-256-GCM, bound AAD = `botId + origin` so a
  ciphertext cannot be replayed onto another bot or origin.
- Never serialized into workspace bundles, receipts, logs, or the
  `/api/agent/workflow` read-only ops. The vault list endpoint returns
  metadata only (label, origin, lastUsed) — never field values.

## Gating rules (the whole point)

1. **Fill-time match**: autofill only when the live tab's current origin
   equals a record's origin tuple, scheme included (no http fallback for
   an https record).
2. **Redaction**: every value the vault fills is registered in the
   Privacy Shield redaction set for that session, so screenshots,
   accessibility trees, and page-text observations reaching the model
   carry `•redacted•` — the model can use the credential without ever
   reading it.
3. **Approval parity**: first fill per (bot, origin) raises an approval
   card like any other consequential action; "always allow for this
   origin" is per-bot, revocable, and lands in the decision log.
4. **Export never**: the vault has no export path. Restoring a workspace
   backup does not restore credentials (same honesty as keys never
   syncing, per workspace-bundle rules).

## Slices (each its own loop)

- **V1** storage + CRUD routes + settings UI (metadata-only list, add/
  delete, no autofill yet). Testable in isolation; zero browser surface.
- **V2** fill-time origin matcher + approval card + decision-log entry
  (unit: the origin-tuple matcher — the `evil.app.acme.com.attacker.tld`
  case is the contract test that must exist).
- **V3** CDP autofill in `server/browser-panel.ts` + redaction wiring
  into `computer-observation.ts` (the fill never echoes the value).
- **V4** per-bot credential picker in the browser card + usage counters.

## Why deferred

V3's autofill path touches the live-session boundary where a wrong origin
comparison leaks a secret to an attacker page; it needs V2's matcher
battle-tested first. V1 alone would tempt users to paste keys into a
feature that can't yet fill — worse than waiting. Sequenced V1→V4, each
loop ships a green suite and browser verification.
