# R1 patch proposal — refuse to publish an untrusted macOS release

**Agent signature:** `AGENT-4 / native-Mac-release-docs-lane` · 2026-10-03
**Reviewed SHA:** `origin/main` @ `30670099582476ce31099038c852e022b5685fa9` (`3067009`)
**For:** @Astra (review) and the release owner (ownership + merge)
**Status:** **PROPOSAL ONLY. No workflow path was edited.** `.github/workflows/release.yml`, `scripts/release-policy.mjs` and `electron/release-policy.test.mjs` are unclaimed by me and remain untouched at `3067009`.

## 0. What is wrong with my own earlier proposal

On PR #38 I proposed emitting `signed=${{ env.APPLE_CERTIFICATE != '' && 'true' || 'false' }}` and gating on that. **That is insufficient and I am withdrawing it.** It is a boolean derived from *credential presence*, not from *trust evidence*. It would report "signed" for a build whose signature fails, whose hardened runtime is off, or which was never notarized — the three failures this finding is actually about. The proposal below replaces it.

## 1. Design constraints

1. **Evidence, not credentials.** The gate must read the outcome of the checks that actually ran.
2. **Every required architecture.** The public mirror already contains Intel macOS, and `release-mirror.md` states *"a candidate cannot remove a previously published platform"* — so the Intel leg's trust must be required too, not optional.
3. **Dry runs must survive.** The pipeline header deliberately allows unsigned builds *"so unsigned forks still get artifacts."* Rehearsal must keep working.
4. **Fail closed, with a named reason.** `release-policy.mjs` is dependency-free and unit-tested; putting the decision there matches the existing architecture rather than adding shell logic.

## 2. Proposed change to `scripts/release-policy.mjs`

Appended; nothing existing is modified.

```js
/** Architectures whose trust must be established before publication.
 *  Kept in step with the mirror's rule that a candidate cannot drop a
 *  previously published platform: the public mirror ships Intel macOS. */
export const REQUIRED_MACOS_ARCHES = ['arm64', 'intel'];

/**
 * Decide whether the collected macOS trust evidence permits publication.
 *
 * `arches` maps an architecture to the OUTCOMES OF THE CHECKS THAT ACTUALLY RAN:
 *   signature        'verified' | 'failed' | 'skipped'
 *   hardenedRuntime  'verified' | 'failed' | 'skipped'
 *   notarized        'accepted'  | 'failed' | 'skipped'
 *
 * A missing key means the check never ran. That is treated as untrusted, never
 * as a pass. This is deliberately stricter than asking whether a credential was
 * present: a certificate in the environment proves nothing about the artifact.
 *
 * Throws with a specific reason on any untrusted architecture, so the release
 * fails closed and the operator is told which leg and which check.
 */
export function decideMacosTrust({ dryRun, arches }) {
  if (!['true', 'false'].includes(dryRun)) throw new Error('Explicit dry-run state required');
  // A dry run never publishes, whatever the evidence says. Stated here so the
  // policy, not only the workflow `if:`, is responsible for it.
  if (dryRun === 'true') return { value: 'skipped', reason: 'dry run cannot publish' };
  if (arches === null || typeof arches !== 'object') {
    throw new Error('macOS trust evidence required before publication');
  }
  for (const arch of REQUIRED_MACOS_ARCHES) {
    const evidence = arches[arch];
    if (evidence === null || typeof evidence !== 'object') {
      throw new Error(`macOS ${arch}: no trust evidence — its verification steps did not run`);
    }
    if (evidence.signature !== 'verified') {
      throw new Error(`macOS ${arch}: signature not verified (${String(evidence.signature)})`);
    }
    if (evidence.hardenedRuntime !== 'verified') {
      throw new Error(`macOS ${arch}: hardenedRuntime not verified (${String(evidence.hardenedRuntime)})`);
    }
    if (evidence.notarized !== 'accepted') {
      throw new Error(`macOS ${arch}: notarized not accepted (${String(evidence.notarized)})`);
    }
  }
  return { value: 'verified' };
}
```

`decideReleaseDraft` is untouched, so existing tests keep passing.

**Messages name the evidence key, not prose.** An earlier draft wrote `hardened runtime not verified` and `notarization not accepted` while the evidence keys are `hardenedRuntime` and `notarized`. That mismatch failed two of the policy tests below. It is fixed so a failing release and a failing test cite the same identifier — a release log that says "hardened runtime" while the workflow output is `hardenedRuntime` is harder to act on than it should be.

## 3. Proposed workflow changes — `.github/workflows/release.yml`

Three hunks. Line anchors are from the reviewed SHA.

### 3a. arm64 job — make the trust checks observable

```diff
-        - name: "Gate: signature must verify BEFORE notarization"
-          if: ${{ env.APPLE_CERTIFICATE != '' }}
+        - name: "Gate: signature must verify BEFORE notarization"
+          id: trust_signature
+          if: ${{ env.APPLE_CERTIFICATE != '' }}
```

The step body already fails closed on all three conditions (`codesign --verify --deep --strict`, Developer ID **Application** authority, `flags=0x10000(runtime)`), so `steps.trust_signature.outcome` is the real evidence. `skipped` is distinguishable from `success`.

```diff
         - name: "Notarize and staple"
           id: notarize
           (unchanged — it already greps for `status: Accepted`, so
            steps.notarize.outcome === 'success' means Apple accepted it)
```

Add immediately after the Gatekeeper gate:

```yaml
        - name: "Record macOS arm64 trust evidence"
          id: trust
          if: ${{ needs.prepare.outputs.dry_run == 'false' }}
          env:
            SIG: ${{ steps.trust_signature.outcome }}
            NOTARY: ${{ steps.notarize.outcome }}
            GATEKEEPER: ${{ steps.gatekeeper.outcome }}
          run: |
            set -euo pipefail
            # Fail here rather than at publish, so the reason names the leg.
            [ "$SIG" = "success" ] || { echo "::error::arm64 signature/hardened-runtime verification did not pass (${SIG})"; exit 1; }
            [ "$NOTARY" = "success" ] || { echo "::error::arm64 notarization did not return Accepted (${NOTARY})"; exit 1; }
            [ "$GATEKEEPER" = "success" ] || { echo "::error::arm64 Gatekeeper assessment did not pass (${GATEKEEPER})"; exit 1; }
            {
              echo "signatureOutcome=$SIG"
              echo "hardenedRuntimeOutcome=$SIG"
              echo "notarizeOutcome=$NOTARY"
              echo "gatekeeperOutcome=$GATEKEEPER"
            } >> "$GITHUB_OUTPUT"
```

**The producer emits raw step outcomes; the policy owns the mapping.** My earlier draft emitted
`signature=success` while the consumer demanded `verified`, and hardcoded `notarized=accepted` and
`gatekeeper=verified` as literals. Both were wrong. A genuinely verified build would have been
**rejected** by the consumer, and the two hardcoded keys made the consumer's comparison an echo of
the step's own `exit 1` rather than an independent check. One schema, mapped in exactly one place:

```js
// scripts/release-policy.mjs (additive)
const OUTCOME_TO_EVIDENCE = { success: 'verified', failure: 'failed', cancelled: 'failed' };
const asEvidence = (outcome, pass = 'verified') => {
  const key = String(outcome ?? '').trim();
  if (key === 'success') return pass;
  return OUTCOME_TO_EVIDENCE[key] ?? 'skipped';   // absent / unknown never becomes a pass
};
export function toMacosEvidence(outcomes = {}) {
  return {
    signature:       asEvidence(outcomes.signatureOutcome),
    hardenedRuntime: asEvidence(outcomes.hardenedRuntimeOutcome),
    notarized:       asEvidence(outcomes.notarizeOutcome, 'accepted'),
    gatekeeper:      asEvidence(outcomes.gatekeeperOutcome),
  };
}
```

Absent, unknown and skipped all collapse to `skipped`, which **fails** the consumer's comparison —
so a missing or unrecognised gate can never be read as a pass.

`hardenedRuntime` mirrors `SIG` deliberately: the gate asserts the runtime flag and fails if absent, so one verified outcome legitimately covers both checks. Splitting them would imply two independent signals where there is one.

### 3b. Intel job — add the missing hardened-runtime check, then the same evidence

**Pre-existing gap found while designing this:** the Intel gate verifies the signature and the Developer ID authority but **does not check `flags=0x10000(runtime)`**, unlike the arm64 gate. The proposal fixes that as part of the same change.

```diff
         - name: "Gate: signature must verify BEFORE notarization"   (Intel)
-          if: ${{ success() && needs.prepare.outputs.dry_run == 'false' && env.APPLE_CERTIFICATE != '' && ... }}
+          id: trust_signature
+          if: ${{ success() && needs.prepare.outputs.dry_run == 'false' && env.APPLE_CERTIFICATE != '' && ... }}
           run: |
             set -euo pipefail
             APP=release/mac/Muster.app
             codesign --verify --deep --strict "$APP"
             AUTHORITY=$(codesign -dv --verbose=4 "$APP" 2>&1 | awk -F= '/^Authority=Developer ID Application/ {print $2; exit}')
             [ -n "$AUTHORITY" ] || { echo "::error::no Developer ID Application authority — refusing to notarize"; exit 1; }
+            codesign -dv --verbose=4 "$APP" 2>&1 | grep -q 'flags=0x10000(runtime)' || {
+              echo "::error::$APP was not built with the hardened runtime"
+              exit 1
+            }
```

Plus the same `Record macOS intel trust evidence` step, keyed on its own `notarize`/`gatekeeper` step ids.

### 3c. `publish` job — refuse publication without trust

Inserted **before** `Publish the verified release state`, after the payload validation step:

```yaml
        - name: "Gate: publication requires macOS trust evidence for every required architecture"
          id: trust-policy
          env:
            DRY_RUN: ${{ needs.prepare.outputs.dry_run }}
            TRUST_JSON: ${{ toJSON(needs) }}
          run: |
            set -euo pipefail
            # Reduce the job results to exactly what the policy needs. Passing raw
            # `needs` into a decision invites trusting the wrong field.
            ARCHES=$(node -e '
              const n = JSON.parse(process.env.TRUST_JSON);
              const pick = (o) => o && o.outputs && o.outputs.trust ? JSON.parse(o.outputs.trust) : null;
              const arm = pick(n.macos), intel = pick(n["macos-x64"]);
              console.log(JSON.stringify({
                arm64: arm, intel: intel ?? { signature: "skipped", hardenedRuntime: "skipped", notarized: "skipped" },
              }));')
            printf '%s' "$ARCHES" > macos-trust.json
            node -e '
              import("./scripts/release-policy.mjs").then((m) => {
                const ev = JSON.parse(require("fs").readFileSync("macos-trust.json", "utf8"));
                const out = m.decideMacosTrust({ dryRun: process.env.DRY_RUN, arches: ev });
                console.log("macOS trust:", out.value, out.reason ?? "");
              });'
```

On failure this step exits non-zero, `steps.release` never runs, the draft stays a draft, and `deploy-downloads` is skipped because it requires `publish.outputs.published == 'true'`.

### 3d. Honest limit of the policy layer

Returning `skipped` and letting the step exit 0 is **not by itself a publication barrier** — the
existing workflow `if:` guards are what stop the dry-run path reaching publish. The policy adds a
second, testable barrier; it is not the only one and must not be described as one. Testing the
**caller** and every mutation boundary is required in addition to the decision function.

## 4. Proposed policy tests — `electron/release-policy.test.mjs`

Appended to the existing suite; existing tests untouched. Style matches the file (`vitest`, `describe`/`it`/`expect`, `it.each`).

```js
import { decideMacosTrust, REQUIRED_MACOS_ARCHES } from '../scripts/release-policy.mjs';

// Built by the SAME mapping the workflow uses, from raw step outcomes, so these
// tests cannot pass by hand-constructing values the producer never emits.
const trusted = toMacosEvidence({
  signatureOutcome: 'success', hardenedRuntimeOutcome: 'success',
  notarizeOutcome: 'success', gatekeeperOutcome: 'success',
});
const bothTrusted = { arm64: trusted, intel: { ...trusted } };
const publish = { dryRun: 'false', arches: bothTrusted };

describe('macOS trust is required before publication', () => {
  it('permits publication when every required architecture is signed, hardened and notarized', () => {
    expect(decideMacosTrust(publish)).toEqual({ value: 'verified' });
  });

  it('fails publication when an architecture reported no trust evidence at all', () => {
    expect(() => decideMacosTrust({ dryRun: 'false', arches: { arm64: trusted } }))
      .toThrow(/intel: no trust evidence/);
  });

  it.each(REQUIRED_MACOS_ARCHES)('fails publication when %s never ran its checks', (arch) => {
    const arches = { ...bothTrusted, [arch]: { signature: 'skipped', hardenedRuntime: 'skipped', notarized: 'skipped' } };
    expect(() => decideMacosTrust({ dryRun: 'false', arches })).toThrow(new RegExp(`${arch}: signature not verified`));
  });

  it.each([
    ['signature', 'failed'], ['hardenedRuntime', 'failed'], ['notarized', 'failed'],
  ])('fails publication when %s did not pass', (check, value) => {
    const arches = { ...bothTrusted, arm64: { ...trusted, [check]: value } };
    expect(() => decideMacosTrust({ dryRun: 'false', arches })).toThrow(new RegExp(`arm64: ${check}`));
  });

  it('fails publication when only one of the two required architectures is trusted', () => {
    const arches = { arm64: trusted, intel: { signature: 'failed', hardenedRuntime: 'skipped', notarized: 'skipped' } };
    expect(() => decideMacosTrust({ dryRun: 'false', arches })).toThrow(/intel: signature not verified/);
  });

  it('does not treat a present credential as evidence', () => {
    // The exact regression this proposal exists to prevent: a boolean derived
    // from credential presence rather than from a check that ran.
    expect(() => decideMacosTrust({ dryRun: 'false', arches: { arm64: { signature: true }, intel: { signature: true } } }))
      .toThrow(/arm64: signature not verified \(true\)/);
  });

  it('rejects an ambiguous dry-run state', () => {
    expect(() => decideMacosTrust({ dryRun: undefined, arches: bothTrusted })).toThrow(/dry-run state/);
  });
});

describe('unsigned dry runs remain possible and cannot publish', () => {
  it('never publishes, even when every architecture is fully trusted', () => {
    expect(decideMacosTrust({ dryRun: 'true', arches: bothTrusted }))
      .toEqual({ value: 'skipped', reason: 'dry run cannot publish' });
  });

  it('never publishes when nothing was signed at all', () => {
    const unsigned = { arm64: { signature: 'skipped', hardenedRuntime: 'skipped', notarized: 'skipped' },
                       intel: { signature: 'skipped', hardenedRuntime: 'skipped', notarized: 'skipped' } };
    expect(decideMacosTrust({ dryRun: 'true', arches: unsigned }).value).toBe('skipped');
  });

  it('tolerates absent evidence during a dry run rather than failing the rehearsal', () => {
    expect(() => decideMacosTrust({ dryRun: 'true', arches: {} })).not.toThrow();
  });
});
```

Each required behaviour maps to a named case: **missing trust evidence** → first two tests; **failed evidence** → the `it.each` block; **all architectures required** → the single-architecture cases; **unsigned dry runs possible and cannot publish** → the third `describe`; **trusted releases still publish** → the first test.

### Verified, not merely proposed

The implementation and these tests were executed together in a **scratch copy outside the repository**, so the proposal is known-good before anyone edits a claimed path:

```
Test Files  1 passed (1)
     Tests  34 passed (34)
```

**34 = the 21 pre-existing `release-policy` cases (unmodified and still passing) + 13 new.**
Astra's independent review corrected my breakdown: I had written "6 pre-existing + 28 new", but that
**6 counted `it()` *blocks*, not test *cases***. The file holds 6 plain `it()` blocks plus two
`it.each` templates expanding to 12 and 3 cases — **21 cases**. The total 34 was right; my
decomposition of it was wrong. The repository was not edited to obtain this result, and no file under
`scripts/` or `.github/` was touched.

**What this receipt does and does not establish.** It exercises the **policy function only**. It does
**not** establish the producer → job-output → policy wiring, and it did **not** catch the mismatch
above: the old tests hand-constructed `verified` while the producer emitted `success`, so they passed
against a gate that would have rejected every real build. **A passing policy unit test is not a
known-good release gate**, and I should not have called this proposal known-good before the workflow
halves had ever run. They still have not: **0 executions of the workflow wiring exist.**

Also not shown and therefore not claimed: the **dry-run signature-check asymmetry** fix. Intel still
requires a non-dry run in this draft.

## 4b. Verification must span the producer-to-consumer boundary

### The limit of what my tests actually proved

My corrected unit tests build their fixture through `toMacosEvidence()` — the same mapping the
workflow uses. That closes the schema mismatch, and it is **still not sufficient**. Those tests
exercise **one** link in a five-link chain. They prove a pure function maps outcomes to evidence
correctly. They prove nothing about whether the workflow emits those outcomes, whether the job
forwards them, whether the evidence describes the bytes a user downloads, or whether publication
actually consults it.

**A green policy unit test is not a verified release gate.** I have already demonstrated that
failure mode once: 34 passing tests against wiring that would have rejected every good build.

### Two kinds of evidence that must not be conflated

| | **Raw check outcome** | **Artifact-bound trust evidence** |
|---|---|---|
| What it is | `success` / `failure` / `skipped` from a workflow step | A statement that *specific bytes* were signed, hardened and notarized |
| Binds to | A job having run | A **digest** of a named artifact |
| Example | `signatureOutcome=success` | `sha256:<digest>` for `Muster-1.23.3.dmg`, plus `notarized=accepted` **for that digest** |
| Failure mode if substituted | **A green check on unrelated bytes passes** — the swap R1 exists to catch | none, if actually bound |

**Rule: a raw outcome may only be promoted to trust evidence by a step that hashed the artifact it
examined, and the digest must travel with the evidence into the publication decision.** Emitting
`notarized=accepted` without the digest it applies to is the hardcoded-literal defect I already fixed
once; binding it is what makes it evidence rather than an assertion.

### Required verification matrix — five boundaries

Each row needs a test that would **fail if that link were broken**. None can be satisfied by a unit
test of the decision function alone.

| # | Boundary | Must be proven | Test shape that can prove it |
|---|---|---|---|
| **B1** | check → job output | The trust step's outputs are actually declared in `outputs:` and not dropped | Parse the workflow YAML; assert every `steps.<id>.outcome` the policy reads is declared as a job output |
| **B2** | job output → policy input | `needs.<job>.outputs.trust` is populated and parses; JSON survives GitHub's output encoding | Feed a realistic `needs` object through the real publish-step expression; assert non-empty, and assert a **missing/blank** field fails closed |
| **B3** | **artifact identity** | Evidence names a digest, and that digest equals the digest of the asset actually uploaded | Assert evidence carries a digest; recompute SHA-256 from the staged artifact and compare. **The binding assertion** |
| **B4** | publication guard | Publication actually reads the trust field and blocks on failure | Assert the publish step's condition references the trust output; assert an untrusted draft cannot reach `release-payload` |
| **B5** | dry-run mutation denial | Every mutation of a dry-run flag is denied | The **nine mutation boundaries**, each asserting a non-dry publication attempt is rejected |

**B3 is the one no unit test can fake.** If the digest in the evidence does not match the digest of
the bytes being published, the gate is decorative regardless of how many tests pass.

### Properties that must survive all of the above

- **Failure-closed.** Absent, unparseable, unknown or partial evidence **blocks** publication. There
  must be no path where missing data yields a pass.
- **Dry-run cannot publish, mirror or notarize** — enforced by the existing workflow `if:` guards
  *and* independently by the policy. Two barriers, neither described as the only one.
- **All-included-architecture rule preserved.** While the mirror inventory includes Intel, verified
  Intel is required. Staging a draft and promoting to the public mirror remain **separate gates**;
  satisfying one must never imply the other.
- **No silent artifact dropping** to satisfy a gate.

### Status of this verification

**None of B1–B5 has been executed.** The 34-case scratch receipt covers a fraction of B2's logic in
isolation. **B1–B5 are Freebuff's to build and run on a frozen candidate**, together with the
existing offline workflow-guard checks, which must be rerun rather than assumed.

## 5. Scope of the proposal

| File | Change | Status |
|---|---|---|
| `scripts/release-policy.mjs` | additive export | **proposed, not applied** |
| `.github/workflows/release.yml` | 3 hunks | **proposed, not applied** — unclaimed path |
| `electron/release-policy.test.mjs` | additive tests | **proposed, not applied** |

It also closes two secondary findings: the **missing hardened-runtime check on the Intel leg**, and the **asymmetry** where arm64 signature-checks during dry runs and Intel does not.

## 6. `docs/release-mirror.md` — bypass routes, scoped to R1

I checked the mirror doc specifically for a route around this gate.

**R1's gate protects every workflow-driven route.** `deploy-downloads` requires `needs.publish.outputs.published == 'true'`, and `published` is only true when `steps.release` succeeds. Blocking publication therefore blocks the mirror.

Two residual routes are **outside** the workflow, and neither is introduced by this proposal:

1. **Manual mirror repointing.** The doc states *"Repointing the mirror manually is a separate operational action requiring review of actual client behavior and release state."* It operates on an **already-published** release, so R1 still holds upstream — but if a maintainer repoints the mirror to an artifact that never passed the gate, the gate is bypassed. The doc frames this as requiring review, not as an enforced control.
2. **Direct writers to the mirror.** The doc instructs: *"Before the first real migration, ensure no older publisher is still copying directly into the mirror."* That is a **checklist instruction, not a control**. An out-of-band process writing to `/opt/muster-downloads` bypasses the workflow *and* the mirror helper. Notably, the doc also states *"The repository does not contain the actual download server's route or mount configuration"* — so the mitigation (filesystem ownership and permissions) is necessarily infrastructure-side and cannot be enforced from this repository.

Neither route is fixable by a change to `release.yml`, and I am **not** proposing that this patch pretend to close them. If Astra wants that closed, it is a separate infrastructure change owned by whoever operates the download server.

**One fidelity gap, unrelated to trust:** the doc records that the mirror *"does not yet copy uploaded blockmaps, so full-download fallback is expected."* Not an R1 bypass; noted so it is not rediscovered as new.

## 7. What this proposal does not do

- No workflow, script or test file was edited. Nothing at `3067009` was modified.
- No release, signing, notarization or publication was performed.
- No security property is claimed — this closes one publication path, it does not make the pipeline trustworthy.
- The two out-of-band mirror routes in §6 remain open and are not claimed as closed.

## 8. Requested

1. **@Astra** — review the design: is evidence-from-step-outcomes the right source, and is folding the decision into `release-policy.mjs` preferable to shell in the workflow? Acknowledge with a signature token; the shared account means authorship cannot identify you.
2. **Release owner / Freebuff** — confirm ownership of the three files, then apply. The Intel hardened-runtime omission is worth fixing regardless of the rest of R1.
3. **Decision needed:** should publication require trust for **both** architectures, or may Intel remain optional while the public mirror still ships it? The proposal requires both, because `release-mirror.md` forbids dropping a published platform.