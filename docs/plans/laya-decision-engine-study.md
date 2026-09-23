# Laya Decision-Engine Integration Study

**Status:** research/planning only — nothing in this doc is implemented. Read-only study of
`https://github.com/NandhaKishorM/laya` (Apache-2.0), source cloned at write time to a sandbox
path and inspected file-by-file (`README.md`, `BENCHMARKS.md`, `pyproject.toml`, `LICENSE`,
`laya/*.py`, `tests/*.py`, `research/`, `notebooks/`).

> **Read with the sibling study.** `docs/plans/jev-decision-model-study.md` covers TypeSafe's Jev —
> the hosted counterpart this project positions itself against — and is being written in parallel
> by another agent (it did not exist in `docs/plans/` when this file was created). Implementers
> must read **both** before picking an option from §2/§4; this doc's Jev column is deliberately
> limited to what Laya's own repo says about Jev.

**Evidence labels used throughout:**
- **VERIFIED-IN-REPO** — read directly in the Laya clone or the Muster repo (file cited).
- **AUTHOR CLAIM** — asserted by the Laya author (README/BENCHMARKS/model cards/harness output).
  Not reproduced by us; we did not install torch or download checkpoints in this environment.
- **THIRD-PARTY CLAIM** — published by someone other than the Laya author, quoted by the author.
- **ESTIMATE** — our sizing arithmetic, not measured.
- **UNVERIFIED** — could not be checked from here; stated with the reason.

No benchmark below was run by Muster. Per repo rules: no security claims attach to anything here.

---

## 1. Engine teardown

### 1.1 What it is (VERIFIED-IN-REPO: `README.md`, `pyproject.toml`)

Laya is a Python package (`laya`, v0.3.6, Apache-2.0 per `LICENSE` + `pyproject.toml`)
providing a **non-autoregressive "System 1" decision engine**: you hand it a *state* (string,
JSON dict, or conversation-turn list) and a dict of *typed questions*; it answers **every
question in one forward pass** with probabilities and a confidence score. No text generation —
`usage.output_tokens` is hardcoded to 0 (`laya/agent.py`). Training is RLCD: REINFORCE with a
group-mean baseline against strictly proper scoring rules (log + spherical, plus ranked
probability score for ordinal questions) — `laya/common.py:proper_reward()`, described in the
model cards.

Dependencies are declared **loosely** in `pyproject.toml`: `torch>=2.0.0`,
`transformers>=4.48.0`, `safetensors>=0.4.0`, `huggingface_hub>=0.20.0`, `numpy>=1.20.0`,
`requires-python = ">=3.10"`. **Discrepancy (VERIFIED-IN-REPO):** the README narrates the floor as
"torch 2.14, transformers 5.x, huggingface_hub 1.x all require 3.10", which is what `pip install`
will actually resolve today — i.e. effectively unpinned-latest heavy deps. Both statements are in
the repo; the pyproject floors are what a lockfile would have to pin down.

### 1.2 Question-type semantics (VERIFIED-IN-REPO: `laya/agent.py`, `laya/common.py`)

Sequence format per question (`common.build_sequence`):
`[CLS] <type> instructions [SEP] [MASK] opt0 [MASK] opt1 … [SEP] state [SEP]` — every option is
scored at its own `[MASK]` marker by a learned scorer head, then softmaxed **within that
question's option set**. Option text and instructions share a fixed `head_max_len` budget with
the remainder for state (English: `max_len=512`, `head_max_len=192`; multilingual & typed:
1024/256) — this budget is the documented cause of Laya's high-cardinality weakness.

| type | mechanics (VERIFIED) | output |
|---|---|---|
| `choice` | `criteria` = dict/list of labels; softmax over markers | `choice`, per-option `probabilities`, `confidence` |
| `score` | `criteria` = ordered ordinal rubric levels; expected value over the level distribution | `score` (float), `legend`, `probabilities` per level, `confidence` |
| `noul` | binary statement question — always rendered as exactly two options `false: …` / `true: …` (defaults *"no, the statement does not hold"* / *"yes, the statement holds"*; optional `criteria` only customizes those two descriptions) | `noul` = **calibrated P(true) ∈ [0,1]** (i.e. `p[1]`), `confidence = max(p, 1−p)` |

**What "noul" means precisely:** mechanically it is a *binary truth claim* question whose answer
field is the calibrated probability that the statement holds — the README's own primitive table
says "Calibrated probability P(true) from 0.0 to 1.0" (`README.md` Decision Primitives).
**The etymology of the word itself is not stated anywhere in the repo** (grep across source,
tests, notebooks, cards found no expansion) — **UNVERIFIED**, do not invent one in docs.

`confidence` for all three types is normalized Shannon entropy `1 − H(p)/log(k)`
(`common.confidence_from_probs`), **not** the calibrated probability itself. Temperature scaling
is applied per `(question type, option-count bucket)` and **clamped to [0.5, 5.0]**
(`common.clamp_temperature`) — the clamp exists because the shipped `choice:11+` bucket (0.1006)
turned a 0.24 top probability into 0.99 confidence on a reported 13-option **skill-routing** case
(`tests/test_router.py`, issue #35). Any caller gating on confidence must know that.

`laya/presets.py` ships ready question sets: `triage_questions`, `email_questions`,
`guard_questions` (jailbreak / prompt-injection / sensitive-data `noul`s), `moderation_questions`,
`router_questions` (difficulty score, domain choice, `needs_tools`, `is_sensitive`).

### 1.3 Router + checkpoint routing behavior (VERIFIED-IN-REPO: `laya/router.py`, `laya/lang.py`)

Three checkpoints (all in the bundle repo `convaiinnovations/laya`; only the requested subfolder
downloads — pinned by `tests/test_download.py`):

| key | encoder | params | context | role |
|---|---|---|---|---|
| `english` | ModernBERT-large | 421M | 512 | English (repo root, ~808 MB — AUTHOR CLAIM, HF card) |
| `multilingual` | mmBERT-base | 322M | 1024 | 100+ languages, ~2× faster (~647 MB — AUTHOR CLAIM) |
| `typed-decisions` | ModernBERT-large | 421M | 1024 | fine-tuned on 4 synthetic workflows (~800 MB — ESTIMATE from "0.4B params, F16" on card) |

Routing precedence (`Router.route`, verified by `tests/test_router.py`):
explicit `model=` > explicit `task=` > **opt-in** workflow-id match
(`auto_task_detection=True`, exact question-id-set signatures only) > explicit `lang=` >
detected script/language > `default` ("english"). Detection (`laya/lang.py`) is
**dependency-free pure Python**: Unicode script ranges (exact) + stopword/diacritic heuristics
(best-effort), sub-millisecond, run **before** the forward pass because — AUTHOR CLAIM,
`BENCHMARKS.md` — the English checkpoint stays highly confident while wrong on scripts it cannot
read (Khmer 0.000 accuracy at 0.952 confidence; "undecided is never treated as English").
`typed-decisions` is *never* auto-selected unless explicitly opted in.

Lifecycle: `max_loaded=1` default with LRU eviction; `preload()` / `attach()` / `unload()` manage
residency; load/unload is lock-guarded while inference runs outside the lock; concurrent
`load()` dedupes to one Agent (pinned by the thread tests). **Cold swap is seconds** (AUTHOR
CLAIM: 7.4 s median CPU / 10.3 s T4 reload on alternating languages), preloaded steady state is
32.8 ms GPU / **193–464 ms CPU** (AUTHOR CLAIM, README routing table).

### 1.4 The author's Jev comparison — methodology and honest labeling

`assets/laya_vs_jev_full.png` (README alt text: "accuracy on shared public datasets, every
application workflow, all 51 languages, speed, calibration, and the cost of not preloading") is an
infographic version of the `BENCHMARKS.md` tables; we did not re-render it, its claims are the
same ones textually stated there.

**Methodology (VERIFIED-IN-REPO: `BENCHMARKS.md`, `research/README.md`):**
- **Laya numbers are AUTHOR CLAIM, self-measured**: harnesses in `research/scripts/`
  (`laya_benchmark_colab.ipynb` on one T4, `bench_local.py` CPU sweep, `bench_apps.py`,
  `bench_latency.py`), fixed seed, byte-identical questions per model, raw JSON under
  `research/results/`. **Caveat (VERIFIED):** `BENCHMARKS.md` cites three result files but this
  clone contains only `t4_colab_benchmark.json` and `cpu_51_language_sweep.json` — the referenced
  `research/results/app_benchmark.json` (the entire "Applications" run) is **absent from the
  clone** (likely on the `research` branch). The application-workflow accuracy claims therefore
  have no raw artifact here.
- **Jev numbers are THIRD-PARTY CLAIM, never run by the author** — stated plainly: "no TypeSafe
  API access… Jev was never run here… different sample sizes and prompts; treat as indicative."
  Sources: AbdelStark/jev-benchmarks (AG News 0.910, Banking77 0.870, DAIR Emotion 0.480) and
  nibzard/decision-model-benchmark (ECE 0.246, latency 236–276 ms p50, option-order flip 13%).
- Headline comparisons (all AUTHOR CLAIM vs THIRD-PARTY CLAIM): typed-decisions 0.766 vs 0.727;
  AG News 0.950 vs 0.910; DAIR Emotion 0.595 vs 0.480; **Banking77 0.425 vs 0.870 (Jev wins —
  architectural token-budget limit, keep `choice` ≤ ~20 options)**; ECE 0.081 vs 0.246 *after
  temperature fitting on held-out data* (raw shipped ECE 0.213 is **worse** than Jev's 0.144);
  latency 32.8 ms vs 236–276 ms p50 on a T4 (Laya on GPU, Jev presumably API round-trip — not a
  like-for-like setup); cost $0 self-hosted vs $0.042/1M tokens (AUTHOR CLAIM).
- The repo's own **"Honest limits"** section is unusually good: base checkpoints are *below the
  majority-class baseline* on typed-decisions zero-shot (0.362/0.342 vs 0.461); the 0.766 comes
  from the checkpoint fine-tuned on that benchmark's own training split; moderation is ~chance on
  held-out data (0.530, macro-F1 0.400); `score` is the weakest primitive; both checkpoints ship
  over-confident; option-order robustness at 20 options is worse than Jev's measured 13%.

### 1.5 What Laya's own tests actually verify — the honest evidence line

**VERIFIED-IN-REPO (all cited files read):**

| test file | what it proves | what it does **not** prove |
|---|---|---|
| `tests/test_router.py` (~496 lines, no weights) | script detection across 15+ scripts; English/non-English routing incl. Romanian/Polish/Turkish "unknown Latin" and accent-stripped Romance (#35/#172); routing precedence incl. overrides; workflow signature exact-match; alias normalization; temperature clamp rejects the shipped 0.1006 bucket; LRU/preload/attach bookkeeping; 8-thread load dedupe; RouteDecision payload shape | **any model quality** — `Router.route` is pure; no forward pass runs |
| `tests/test_criteria.py` | criteria rendering (dict→JSON, no Python repr leaks, `noul` crash regression from PR #2); CPU-fallback warning gating via source inspection | inference correctness |
| `tests/test_decision_model.py` | `DecisionModel.forward` runs offline on a tiny from-config BERT: single-option `choice` doesn't crash (#96), multi-option path unchanged | anything about accuracy/calibration |
| `tests/test_download.py` | `snapshot_download` `allow_patterns` filtering: root load doesn't fetch sibling checkpoints; subfolders load independently; local paths skip download; token passed through | network behavior against the real Hub (transport mocked) |
| `tests/test_email.py` | `clean_email_body` keeps the sender's request when stripping disclaimer footers | — |
| `tests/test_shortlist.py` | offline: cosine top-k shortlist determinism, k≥n pass-through, caller-dict immutability, error shapes, encoder mean-pool math | shortlist *quality* (issue #102's 54.3→60.8% is explicitly the reporter's, "this repository has not remeasured them") |
| `tests/test_packaging.py` | pyproject/classifier/CI Python floors consistency; transformers ≥4.48 for ModernBERT | — |
| `tests/test_local_e2e.py` (**opt-in, needs real local weights** at `~/laya_models`) | real forward passes: 11-language routing smoke; multilingual billing intent **≥6/8**; phishing/guardrail/moderation **direction ≥2/3**; router end-to-end + eviction | benchmark reproduction — thresholds are **smoke-level direction checks**, not the README numbers |

**Evidence verdict:** Laya's test suite is a solid *logic/regression* suite for routing,
rendering, packaging, download scoping and offline math. **No test in the repo asserts any
benchmark accuracy, ECE, or latency figure.** Every performance number in §1.4 remains AUTHOR
CLAIM backed by harness JSON we did not execute (`app_benchmark.json` missing entirely). Muster's
own gate for any adoption is therefore a fresh harness of our own (§5), not Laya's CI.

---

## 2. Integration architecture options for Muster (TS/Node server + Electron + webapp)

**Dependency/size quantification (from `pyproject.toml` + HF cards; weights = AUTHOR CLAIM sizes,
runtime sizes = ESTIMATE):**
- Python ≥3.10 runtime if absent: ~100–200 MB **ESTIMATE**.
- `torch` CPU wheel: ~0.2 GB download / ~0.8–1.6 GB installed; CUDA wheels 2.5–3.5 GB —
  **ESTIMATE** (not measured here).
- `transformers` + `tokenizers` + `huggingface_hub` + `numpy` + friends: ~0.2–0.4 GB **ESTIMATE**.
- Checkpoints: ~808 MB (English) + ~647 MB (multilingual) + ~808 MB (typed, ESTIMATE) ≈ **2.2 GB**
  for all three.
- **Realistic sidecar install: ~2–4 GB CPU-only (one checkpoint), 4–8 GB if CUDA + all three.**
- **Resident RAM with `preload=True`: one 421M checkpoint ≈ 1.7 GB fp32 weights + activations →
  ~2–3 GB RSS; all three ≈ 4–6 GB — ESTIMATE.** This is the number that matters for a desktop app.
- Cold start: seconds to build a checkpoint; alternating languages at `max_loaded=1` pays it
  **per request** (AUTHOR CLAIM 7.4 s CPU / 10.3 s T4).

### (a) Python sidecar beside `server/index.ts` (env-gated, explicit port, never default-on)
A small FastAPI/HTTP wrapper around `Router(preload=...)`, spawned via `child_process` **only when
enabled** (e.g. `MUSTER_LAYA_URL` set → client talks to it; unset → all call sites use the rules
path). Prod VPS: separate container/systemd unit, ~2–4 GB extra image, health-checked on an
explicit port (never a live/demo port — **8845 is untouchable**).
- ✅ Best accuracy-per-dollar if GPU exists; data stays on the box; Apache-2.0 code; env-only
  config matches our hard rules.
- ❌ **Electron packaging impact is the deal-breaker question:** shipping this in the desktop app
  means bundling (or first-run downloading) a Python runtime + torch + ≥0.6 GB weights — installer
  goes from tens/hundreds of MB to **multiple GB**, tri-platform native builds of torch dylibs,
  signing/notarization of an interpreter we don't control, ~2–6 GB RAM resident, and multi-second
  cold start. This directly violates "lightweight". **Verdict: acceptable only as a server/VPS
  option, explicitly out of the desktop package.**

### (b) Remote inference endpoint (self-hosted GPU elsewhere, or hosted)
Same Python service but deployed off-box; Muster calls it over HTTP from an env-gated client.
- ✅ Zero install weight on Muster (server stays lean, Electron untouched); scales independently;
  can serve both web and desktop users.
- ❌ Data leaves the box (approval cards, memory snippets, receipts become outbound payloads →
  redaction required — `server/redact.ts` patterns reused); egress cost; network dependency in the
  approval path (must fail open to rules); a GPU VM is real money (~$0.50–2/hr ESTIMATE).
  **HF Inference Providers: `laya-multilingual` and `laya-typed-decisions` cards both state "This
  model isn't deployed by any Inference Provider" (VERIFIED at fetch time) — a zero-ops HF route
  does not currently exist; you'd need a dedicated Inference Endpoint or self-host.**

### (c) Desktop-local sidecar for Electron only
Detect Python (or bundle a minimal venv), download the chosen checkpoint on demand, spawn on a
local port, surface "Smart triage (beta)" in settings.
- ✅ Fully local privacy on the machine users care most about; MPS path exists
  (`laya/agent.py` device fallback includes `mps` — VERIFIED).
- ❌ Same packaging/size problems as (a) concentrated on the least forgiving surface; download
  latency/size at first run; support burden (Python versions, `USE_TF=0` hang workaround,
  Apple Silicon vs Intel); settings/desktop-parity surface changes ripple into
  `src/components/SettingsModal.tsx`, `SettingsPrimitives.tsx`, `src/lib/keyboard-shortcuts.ts`,
  `electron/main.mjs` (**conflict flag §5**). **Verdict: worst cost/benefit for the lightweight
  goal.**

### (d) Skip Laya — use the hosted Jev API instead
Thin TS client to Jev's API; no Python anywhere. See the sibling
`docs/plans/jev-decision-model-study.md` for the full study (vendor terms, pricing, SDK).
- ✅ Smallest possible code delta for a TS codebase; no install weight; vendor maintains quality.
- ❌ Data always leaves the box; early-access/vendor risk (AUTHOR-adjacent claim in Laya's table:
  "$0.042/1M tokens", closed API); per-token cost at heavy-user volume; rate limits; the exact
  dependency-on-a-startup problem the owner already flags.

### (e) Stay rules-only
No model: deterministic heuristics, exactly what Muster already does —
`server/provider-fallback.ts` (regex 429/401 classification + consent runner), bounded
`server/approval-why.ts` journal, deterministic `server/receipts.ts` findings,
`server/memory-retrieval.ts` BM25 which states its philosophy outright: *"No new dependencies, no
embeddings, no network: offline-deterministic."*
- ✅ Zero bytes, zero RAM, zero cold start, fully testable, honors the "lightweight, smart, fast"
  goal and every hard rule by construction.
- ❌ Heuristics don't generalize (multilingual inputs, novel triage categories); no calibrated
  confidence; each new decision point costs hand-written rules.

**The "make Muster lightweight" tension, stated plainly:** Muster's server is a lean,
deterministic, dependency-light TS process whose memory pipeline *deliberately refuses* new
deps/network. Options (a)/(c) import a multi-GB ML runtime into that world; (b)/(d) keep the box
lean but move data off it; (e) keeps everything but no model quality. There is no option that is
simultaneously *local, model-quality, and lightweight* — that trade is the actual decision.

---

## 3. Where it plugs in — Muster decision-point map

Classification: **ALREADY-EQUIVALENT** (current mechanism is right; a System-1 model adds nothing
justifiable) · **ADAPTABLE** (a model could add suggestion-grade value) · **REAL-GAP** (current
mechanism can't do it). "Volume?" = does request volume even justify a model.

| Decision point | Muster file(s) | Classification | Volume justifies System-1? |
|---|---|---|---|
| Fleet MCP tool surface (bounded 11 tools; `send_task` writes) | `server/fleet-mcp.ts` (`TOOLS`, schemas) | **ALREADY-EQUIVALENT** — bounded-by-design JSON-RPC; the *calling* LLM picks tools; a side model deciding tool choice would sit between two LLMs with no measured gap | No — low volume, and the caller already classifies |
| Provider fallback / driver selection | `server/provider-fallback.ts`, `server/drivers/*` | **ADAPTABLE** — regexes classify 429/401 honestly today; a `noul` on error text or a `choice` over fallback providers is possible suggestion-grade input | Weak — rate-limit events are rare and latency-tolerant; regex is the honest tool at this volume |
| Approval pre-triage | `server/approval-why.ts` (+ approval card surfaces, OptionCard/Watch) | **ADAPTABLE — suggestion-only metadata, never a verdict.** Human Allow/Deny always decides. **Prompt-injection caveat applies to Laya exactly as to Jev: card content is attacker-influencable; a `noul` "risk hint" read from it must never gate, auto-deny, or be presented as a security/approval verdict** (repo rule: no security claims) | Moderate for heavy users; advisory value real, but zero authority |
| Receipt anomaly checks | `server/receipts.ts` (+ `server/receipt-findings.ts`) | **ADAPTABLE** — composer is pure and test-pinned; a post-hoc `noul` "receipt looks anomalous" *annotation* could ride the additive-optional-field pattern (`findings?`) | Low–moderate; batch/offline so latency free — but determinism of receipts is a feature |
| Eval / scorecard grading | `server/role-eval.ts`, `scripts/bench-trend.ts` | **ALREADY-EQUIVALENT — and should stay deterministic.** Both are deliberately pure ("grading is pure", "byte-identical results", "no new dependencies"); an ML grader would destroy reproducibility and trend comparability | No — must not |
| Skills routing (which skills mount into the prompt) | `server/workspace-skills.ts` (+ prompt assembly) | **REAL-GAP (best candidate)** — today every skill in `skills/` rides the system prompt; with heavy users holding many 128 KB-capped skills, prompt budget will bind and selection becomes necessary. Laya's own history includes a **13-option skill-routing** confidence blow-up (issue #35, clamp now pinned in `tests/test_router.py`) — i.e. this exact use case is where its calibration broke once | Yes, *for heavy users* — this is the one place volume × pain × ≤20 options aligns |
| Memory retrieval / access control | `server/memory-retrieval.ts`, `server/memory-grants.ts` — **in-flight, another agent owns them; read-only here, do not touch** | Retrieval: **ADAPTABLE** at most (optional rerank hint over BM25; the file's own charter bans embeddings/network for the default path). Grants: **ALREADY-EQUIVALENT and must never be ML** — DEFAULT DENY access control cannot be probabilistic | No for grants (hard no); retrieval rerank only if BM25 quality is measured lacking |
| Calendar / email triage | `server/calendar-plan.ts`, `server/call-calendar-plan.ts`, `server/calendar-*.ts`, `server/email.ts` | **ADAPTABLE** — Laya's `email_questions()` preset is literally this job (category/`is_spam`/`is_phishing`/urgency/`needs_reply`), and `laya/email.py` already does footer/quote cleaning. Note `server/email.ts` is an **OTP conflict-flag file (§5)** | Email volume for heavy users can be high — second-best candidate; phishing/spam `noul` is advisory only, never a blocker (no security claims) |

**Net:** of nine decision points, four are already-equivalent (two of them *must* stay
deterministic), four are adaptable-but-advisory, and exactly one (**skills routing**) is a real
gap where volume plausibly justifies a System-1 model — with email/calendar triage second.

---

## 4. Decision matrix for the owner

Columns = §2 options: **(a)** Laya server sidecar · **(b)** Laya remote endpoint · **(c)** Laya
desktop-local sidecar · **(d)** hosted Jev API · **(e)** rules-only. Claims are AUTHOR/THIRD-PARTY
as labeled in §1.

| Criterion | (a) Laya sidecar | (b) Laya remote | (c) Laya desktop-local | (d) Jev API | (e) Rules-only |
|---|---|---|---|---|---|
| **Cost** | $0 software (AUTHOR CLAIM), GPU/VPS $ if used | GPU/host $ (~$0.50–2/hr ESTIMATE) or future dedicated HF endpoint | $0 software, user's machine pays RAM/CPU | ~$0.042/1M tokens (AUTHOR CLAIM, unconfirmed — sibling study owns) | $0 |
| **Latency** | 33 ms T4 / **193–464 ms preloaded CPU** / 7–10 s cold-swap (AUTHOR CLAIM) | +network hop; still ~100–300 ms class (ESTIMATE) | CPU 193–464 ms hot, seconds cold; MPS helps on Apple Silicon (code VERIFIED) | 236–276 ms p50 (THIRD-PARTY CLAIM) | µs–ms |
| **Privacy (data leaves the box?)** | No | **Yes — always** (redact first) | No | **Yes — always** | No |
| **Install weight** | VPS +2–4 GB (one ckpt) to +8 GB (all/CUDA) — ESTIMATE | **None** | **+2–6 GB and multi-GB installer — deal-breaker for packaged Electron** | None | None |
| **Maintenance** | Python runtime, dep floors unpinned (`pyproject` VERIFIED), `USE_TF=0` quirk, ckpt updates | Same Python ops *plus* network/uptime | All of (a) on the least forgiving surface + tri-platform signing | Vendor SDK only | Already paid |
| **License** | Code Apache-2.0 (**VERIFIED**: `LICENSE`, `pyproject`) · weights: **all three HF cards fetched and state `apache-2.0`** (VERIFIED: root raw README front-matter, multilingual card, typed-decisions card). Base encoders (answerdotai ModernBERT, mmBERT): **UNVERIFIED — encoder cards not fetched**; weights are redistributed inside the Laya safetensors under the card's Apache-2.0 statement | same | same | Proprietary API (terms: sibling study) | n/a |
| **Vendor risk** | Single-maintainer OSS (Convai Innovations / NandhaKishorM) — bus factor, but forkable & weights local | same | same | **Early-access startup API** (owner-flagged; sibling study) | None |
| **Multilingual need** | Best-in-class if real: 45/51 languages >3× random (AUTHOR CLAIM); English checkpoint collapses off-English | same | same | No published multilingual benchmark (AUTHOR's statement of absence) | Hand-written rules per language |
| **Fits hard rules** (human approvals / no security claims / env-only config) | ✅ if suggestion-only + env-gated + off by default | ✅ same, plus redaction | ✅ same | ✅ same | ✅ by construction |
| **Fits "lightweight, smart, fast, heavy users"** | ⚠️ smart+local, not lightweight | ⚠️ lightweight+smart, not local | ❌ not lightweight | ⚠️ lightweight, vendor-bound | ✅ lightweight+fast; "smart" capped |

**Multilingual need: UNVERIFIED from the repo** — no localization layer surfaced in the files
read; whether Muster users actually send non-English states is an owner question, and it is the
single input that most changes this matrix (if "no", Laya's headline advantage largely evaporates).

---

## 5. Ranked implementation slices (for whichever option the owner picks)

Ranked for the **recommended path: (e) rules-only shipped default + an env-gated
`decision-client` seam so (b) or (d) can be swapped in later without touching call sites.**
Slices for (a)/(c) are the same client with a different transport, gated additionally on
"VPS-only / never packaged". **No slice may run by default; no slice may touch port 8845;
config via env/secrets only; every model output is labeled suggestion-grade.**

**Conflict flags (live streams — coordinate before editing):**
OTP: `server/auth.ts`, `server/email.ts`, `src/lib/auth.tsx`, `src/pages/LoginPage.tsx` ·
memory (in-flight, **another agent owns — do not edit**): `server/memory-retrieval.ts`,
`server/memory-grants.ts` · backups: `server/workspace-backup-routes.ts` + snapshots +
`SnapshotsCard.tsx` · desktop parity: `src/App.tsx`, `src/components/SettingsModal.tsx`,
`SettingsPrimitives.tsx`, `ShortcutsSheet.tsx`, `src/lib/keyboard-shortcuts.ts`,
`electron/main.mjs` · iOS: `ios/**` · other research docs: openmuse / openmaus-ios / tiptour /
**jev (`docs/plans/jev-decision-model-study.md`, parallel write — never touch)** / performance
studies (none of the openmuse/tiptour/performance docs were present under `docs/` at write time —
they are external or pending; don't create/edit them).

1. **Slice 0 — decision-layer seam + harness (do this first, option-independent).**
   New `server/decision-client.ts`: typed `decide(state, questions) → suggestion | rules-result`,
   transport chosen only when `MUSTER_DECISION_URL` (or Jev equivalent) is set; unset ⇒ pure-rules
   path, byte-identical to today. New tests `server/decision-client.test.ts` (env unset ⇒ zero
   network, zero spawn; malformed endpoint ⇒ fail-open to rules; output never escalates to
   verdict). Verification harness mirrors TipTour's `scripts/test-jev.sh` pattern
   (VERIFIED at `/private/var/folders/.../tiptour-src/scripts/test-jev.sh`: mktemp package,
   copy only the decision sources, run tests **without building/signing/launching the app**) →
   `scripts/test-decision-layer.mjs`: temp dir, fixture states, golden outputs for the rules path
   + mock-transport path, no server boot. Gate: `npx tsc --noEmit -p tsconfig.server.json` +
   `npx vitest run server/decision-client.test.ts`, full suite before commit.
   *Conflicts: none (new files only).* **Optional parallel slice:** if owner wants measured
   evidence, a read-only `scripts/bench-laya.mjs` runner against a scratch sidecar reproducing 2–3
   fixtures — output labeled AUTHOR-claim-until-reproduced.

2. **Slice 1 — skills routing suggestion (the one REAL-GAP).** `noul`/`choice` suggestion over
   `server/workspace-skills.ts` entries when prompt budget binds; surfaced as "suggested skills"
   metadata, never silently unmounting a user's skill. ≤20 options (Laya's own ceiling).
   *Conflicts: prompt-assembly hot path shares ancestry with memory prompt wiring — coordinate
   with the memory-stream owner; do not edit `memory-retrieval.ts`/`memory-grants.ts`.*

3. **Slice 2 — email/calendar triage annotations.** Category/urgency `noul` hints riding
   `server/email.ts` + `server/calendar-plan.ts`; phishing/spam output is an advisory chip only
   (no security verdict — hard rule). *Conflicts: **`server/email.ts` is an OTP live stream —
   highest collision risk;** prefer a wrapper module over editing it. iOS follow-ups touch
   `ios/**` (flagged).*

4. **Slice 3 — approval pre-triage suggestion metadata.** `choice`-based "what kind of request is
   this" chip rendered from `server/approval-why.ts` context; Allow/Deny semantics untouched;
   copy must read "model hint", redacted via `server/redact.ts` first; injection caveat in code
   comment. *Conflicts: approval surfaces feed OptionCard/Watch/iOS (`ios/**`, watch specs in
   `docs/plans/watch-*`) — desktop parity files flagged above if settings exposure is added.*

5. **Slice 4 (only with option (a)) — VPS sidecar bring-up.** Systemd/container unit, explicit
   non-8845 port, health endpoint, `preload=["english"]` (skip typed-decisions — specialist for
   four synthetic workflows we don't run), env-gated off by default, install-size documented in
   `docs/self-host.md`. *Conflicts: deploy scripts (`scripts/deploy-prox.sh`, stability contract —
   GET-only verification, pushes ≠ receipts); no Electron packaging under any circumstance.*

**Explicitly not sliced:** eval/grading (`server/role-eval.ts`, `scripts/bench-trend.ts`) —
deterministic by charter; memory grants — access control must stay default-deny deterministic;
anything auto-approving or auto-denying — human approvals are non-negotiable.

---

## Recommendation (single)

**Stay rules-only (option e) as the shipped default, and spend the one engineering slice on the
env-gated `decision-client` seam (Slice 0) so a remote Laya endpoint (b) or the Jev API (d) can
be adopted later without touching any call site.** For the goal *"lightweight, smart, fast, heavy
users"*, Laya's real advantages — local, Apache-2.0, calibrated, multilingual — only materialize
by importing 2–6 GB of Python/torch/weights, which breaks "lightweight" on the server and is a
hard no inside packaged Electron; Laya's one genuine Muster gap (skills routing) does not yet
have measured volume to pay for that. Reopen (b) the day skills-routing or email-triage volume is
measured in our own harness — and read the sibling Jev study before reopening (d).

## What we could not verify, and why

- **Every Laya benchmark number (accuracy, ECE, latency, cost-vs-Jev)** — no torch/checkpoints in
  this environment; Jev figures are third-party and were never run by the Laya author either.
  `research/results/app_benchmark.json` is referenced but **missing from the clone**.
- **Base encoder licenses** (ModernBERT-large, mmBERT) — encoder model cards not fetched; the
  three `convaiinnovations/*` cards were fetched and all state `apache-2.0` (VERIFIED).
- **HF Inference-Provider availability for the English root checkpoint** — its card page wasn't
  fetched (raw README only); multilingual + typed-decisions cards both say *not deployed*.
- **Install-size/RAM figures** — arithmetic and industry-known wheel sizes, labeled ESTIMATE;
  nothing installed or measured.
- **Multilingual need for Muster users** — owner question; no localization layer observed in the
  files read.
- **Jev pricing/early-access terms** — out of scope here; the sibling study owns that column.
- **"noul" etymology** — undefined anywhere in the repo; only its mechanics are VERIFIED.
