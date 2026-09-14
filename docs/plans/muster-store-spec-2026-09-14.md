# Muster Store spec — OS-level app/bot store, modeled on the Rome OS pattern (14 September 2026)

Produced from a read-only study of `github.com/rome-os/rome` (clone at /tmp/rome-study @ 6c4508086aff),
the live `romeos.cc/store` + `/store/arcana` pages, and the warmwind.com space shell (fetched
2026-09-14; the space is an unverifiable SPA shell and is NOT Rome-related — flagged), mapped onto
Muster's existing team library, manifests, receipts and OS shell.

## What Rome proves (evidence)

- Two-object store model: **Listing** (durable identity, handle-owned, `published|taken_down`)
  vs immutable **Version** (content hash + SemVer + timestamp, `live|superseded|revoked`);
  versions retained forever; **updates are opt-in — the client never polls the store**
  (`docs/concepts/apps.md:177-201`).
- Deterministic packing: identical source → identical artifact hash; store sidecar metadata is
  **excluded from every hash**; the same schema validates at pack gate and install gate
  (`docs/architecture/app-artifact.md:20-48`).
- Install deep link: store page → `rome://install/<id>?v=` (desktop) or
  `<instance>/install-app/<slug>?v=` (web route, `packages/web/src/App.tsx:162`), landing on one
  shared confirm component: "Install this app?" + Version/Size/Publisher/`sha256:<16>…` +
  Cancel / Install v… / Installing… (`AppInstallConfirm.tsx:225-300`). Protocol handler waits for
  runtime boot and guards path traversal (`packages/desktop/src/main/protocol.ts:84-137`).
- Listing anatomy: cards = icon, name, mono slug, version, tagline, category chips, `<1k`
  installs bucket, review count; detail = `v · installs · tokens used · rating · n` + tabs
  **Readme | Reviews | Versions**; Versions rows carry per-version size + sha256 prefix.
- Publishing: env-only, non-expiring store token minted by the dashboard, with reset/revoke +
  last-used telemetry (`docs/adrs/env-only-non-expiring-store-token.md`).
- Honest unknowns (flagged): installs/tokens-used math and review moderation live in closed
  cloud code; only the labels are verified.

## Muster already has (reuse, don't rebuild)

`server/team-library.ts` (pinned GitHub registry `muster.catalog` v1, host allow-list, size
caps, path-safety, redirect:"error"), `server/team-manifest.ts` (muster.team v2),
`POST /api/teams/import?mode=add|replace` with snapshot/rollback + `composio:false` +
`seedMessages:false`, `server/soul-md.ts` (persona+guardrails round-trip), signed receipts
(`server/receipt-signing.ts` + public verify), `botsDirectoryPage` (`/bots`),
`TeamLibraryPanel` (Explore/Import + trust line), and the rome-style declarative OS shell
(`src/components/os/app-manifests.ts`). No `muster://` handler exists yet — greenfield.

## The design

**Currency (one pipeline, three kinds):** (1) **bot packages** = team manifest v2 + per-member
SOUL.md + `skills/*/SKILL.md` + inert routine templates + icon, packed deterministically to
`<slug>-<version>.zip` with sha256+size+SemVer rows in a `muster.catalog` v2 `versions[]`;
(2) OS apps (manifest + bundle) later; (3) connector/MCP configs — install opens the existing
connector authorization step, never auto-connects.

**Data:** `StoreListing{id,handle,slug,kind,name,summary,longDescription,iconUrl,categories[],
state,highestVersion,verified}` · `StoreVersion{version,contentHash,sizeBytes,state,
publishedAt,sourceAvailable}` · `StoreReview{rating,body,author,state:visible|held|removed}` ·
`StoreMetrics{installsBucket,tokensUsed,ratingAvg,reviewCount}` · local `InstallRecord`
(append-only).

**Routes:** keep every existing team-library route (back-compat) and add `GET /store`,
`GET /store/:slug` (SSR), `GET /api/store/listings[/:id]`, `GET/POST …/reviews`,
`POST /api/store/install {listingId,version,contentHash,mode}` (server fetch → **sha256 must
match** → path/schema validation → wraps the existing transactional import),
`GET /api/directory/store.json`, `POST /api/store/publish` (token-gated). SPA route
`/install/:slug?v=`; Electron registers `muster://install/…` (copy the wait-for-runtime +
traversal guard); CLI `muster store publish|revoke` with an env-only `MUSTER_STORE_TOKEN`.

**The confirm card is an ApprovalCard moment** (Muster's native template): "Install this
team?" / "This will install **<name>** on Muster." + Version · Size · Publisher ·
`sha256:…` + Muster-specific rows: **Permissions** (expanded `requires.apps`, routines
delivered inert), **Guardrails to apply** (auto-approve forced OFF, token budget, daily USD
cap, browser tools — from SOUL.md), **Effect** (add vs replace-"archived with conversations
intact"). Buttons Cancel / Install v… / Installing…; hash mismatch surfaces inline.

**Safety:** checksum load-bearing at install; immutable versions + revoke/takedown stops installs
but keeps history; reviews held-queue + author rate limit + publisher reply + flag→hold; no
silent updates (one "Updates" badge); publish/install events go through the signed-receipt
machinery so publishers can prove what shipped.

## Slices (dependency-ordered, one loop each)

1. **S1 bundle format + deterministic pack** — `muster.package` v1 + `store.yaml` sidecar
   (excluded from hash) + `scripts/store-pack.mjs` emitting versioned zips + catalog v2
   `versions[]`; publish = git PR. Accept: pack twice → identical hash; existing panel unaffected.
2. **S2 verify + install API** — fetch/size/path/host guards + sha256 verify + same-schema
   validation, wrapping import; tampered-zip rejection tests.
3. **S3 `/store` public pages** — upgrade `botsDirectoryPage` to store cards + detail with
   Readme/Reviews/Versions; anonymous fetch shows full listing copy.
4. **S4 deep link + confirm card** — `/install/:slug?v=`, sign-in `?next=` return, the
   approval-shaped moment.
5. **S5 dock Store app + reviews** — `OsAppManifest{id:"store"}` + StoreWindow hosting the
   panel; review endpoints + moderation states.
6. **S6 `muster://` + publish token** — cold-start to confirm card; revoke visible everywhere.
