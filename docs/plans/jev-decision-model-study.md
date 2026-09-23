# Jev decision-model study — TypeSafe "System One" mapped onto Muster

*Research/planning document — 23 September 2026. Read-only study: no product
code changed, 0 test suites run for this document. No credentials referenced
or requested. No security claim of any kind is made. Port 8845 and every
existing running service are out of scope and untouched.*

**Mission (owner):** "research on jev model and skill — study implementation
features in Muster."

**One-line verdict:** Jev is a hosted, non-generative model that answers
*typed questions about a state* with calibrated probabilities. It fits Muster
as a **suggestion layer over already-enumerated candidates** — never as a
decider. Muster already contains the correct pattern without the model
(`server/jev-dispatch.ts`, Loop108/110): software enumerates, deterministic
code ranks, the model/human only chooses. This study maps where the *actual*
Jev API could add value, where rules are already equivalent, and where Jev is
forbidden by the product's spine (approvals stay human).

---

## 1. What Jev is — verified vs. vendor marketing vs. community

### 1.1 Category and provenance (verified this session)

- **Jev is not an LLM.** TypeSafe AI's docs define "System One models" as a
  class that "evaluates a state and returns typed answers and
  probabilities," does not write replies, code, or reasoning prose
  (docs.typesafe.ai/concepts/system-one, fetched this session).
- First public System One model, announced **15 September 2026**, early
  access behind a waitlist. Company: TypeSafe AI (SF, ~2 years stealth,
  $40M seed led by DCVC), founded by **Diogo Almeida** (CEO; ex-OpenAI,
  RLHF co-in inventor per TypeSafe's own docs), Erik Gafni (CTO), Sasha Sheng
  (COO). Named after economist William Stanley Jevons. (TechCrunch piece of
  18 Sep 2026, mirrored coverage in TechSpot/DataCamp/systemonemodels.org —
  all read this session.)
- **Training:** trained *exclusively on synthetic data* with what TypeSafe
  calls **Reinforcement Learning for Calibrated Decisions (RLCD)** —
  Almeida's own statement to TechCrunch. Calibration is a *population*
  property; TypeSafe's own docs warn it "does not guarantee that an
  individual answer is correct."
- **Input:** text only today — strings, JSON objects, arrays of text. No
  images/audio/video (docs, explicit Note).

### 1.2 How it works (verified from official docs + a real integration in source)

You send one request with a **state** (the context) and a map of
**questions**; all questions are evaluated in parallel and independently
against that same state in one round trip:

| Question type | Answers | Returns |
|---|---|---|
| `choice` | which of a fixed option set | `choice`, `probabilities` (per option), `confidence` |
| `score` | position on ordered rubric levels | `score`, `legend`, `probabilities`, `confidence` |
| `noul` | is this statement true (0–1) | `noul` only — **no separate confidence** |

Properties we verified that matter for design:

- **Answers are constrained to the options you supply** — never a value
  outside the set; no prose parsing.
- **Questions are independent** — adding questions barely changes latency
  (they run in parallel), costs only their tokens, and cannot cause
  context-rot. A second request is only justified when a later judgment
  genuinely needs the first answer's data.
- **`confidence` is derived from `probabilities`** (how peaked the
  distribution is); you get the full distribution to threshold yourself.
  Noul has no confidence — the probability *is* the signal.
- Official guidance: one "gut-check" judgment per question; decompose
  multi-factor judgments and combine weights **in code** (the "composite
  scoring" pattern).
- Field references in `instructions` use backticked dot/index paths into the
  state (e.g. `` `ticket.messages[0].text` ``).

### 1.3 API shape (verified via docs + TipTour source, MIT clone read this session)

Confirmed by `TipTour/Jev/JevClient.swift` (real, tested integration) and
docs.typesafe.ai:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "jev-latest",
  "state": { ... }              // or a string
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "..." },
    "department":  { "type": "choice", "instructions": "...",
                     "criteria": { "billing": "...", "technical": "..." } },
    "frustration": { "type": "score",  "instructions": "...",
                     "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
→ {
  "answers": {
    "is_urgent":  { "type": "noul", "noul": 0.999 },
    "department": { "type": "choice", "choice": "technical",
                    "probabilities": { ... }, "confidence": 0.93 },
    "frustration":{ "type": "score", "score": 1.4, "probabilities": { ... },
                    "confidence": ... }
  },
  "model": "...",
  "usage": { "input_tokens": N, "output_tokens": M }
}
```

Hard limits observed in the integration source: **max 255 options per
choice** (TipTour enforces it client-side; its grounding layer caps itself
at 200 candidates with headroom). `probabilities` comes back in *shuffled
key order* — never read it positionally (TipTour comment, verified in
source). Question IDs are for your code only and are not sent to the model.

### 1.4 Pricing and speed — VENDOR CLAIMS, labeled

**Everything in this subsection is a vendor claim or third-party coverage,
not a fact we verified by running Jev ourselves:**

- TypeSafe (vendor): **$0.042 per 1M input tokens; output tokens free /
  "too cheap to meter."** Headline benchmark: **"193.6× faster, 444.6×
  cheaper"** than LLM workflows on System-ONE tasks (their site; TypeSafe
  itself says the number sits at the high end).
- TypeSafe/LangChain (vendor relayed by LangChain, 17 Sep 2026): "up to
  **200× faster inference and 400× lower cost** than comparable LLMs on
  classification tasks."
- Latency band widely repeated: **70–500 ms** end-to-end (vendor).
- Community coverage (ayautomate independent test, 20 Sep 2026 — *not ours*):
  791 labeled decisions, Jev median **0.33 s vs 1.17 s** for GPT-5.6 Terra
  (~3.6×, far below the vendor's 40–200×), 4.7–7.5× cheaper than small
  models, **accuracy level with small models and 5–6 points behind
  GPT-5.6 Terra** on intent tasks; Jev did win the injection-detection test.
- Other community datapoints (coverage, unverified by us): Vercel engineers
  report replacing a Gemini/ChatGPT classifier with Jev at 5–18× faster and
  higher accuracy; LangChain added Jev as a **judge in LangSmith Evals on
  21 Sep 2026**.
- Context window and rate limits are reported inconsistently across
  aggregator sites (64K vs 32K) — treat as unverified.

**Honest reading:** the *shape* (typed, bounded, calibrated, batchable) is
documented fact; the *magnitude* of the speed/cost advantage is marketing
until we measure it on our own decision points.

### 1.5 The prompt-injection caveat — and our hard rule

VentureBeat (21 Sep 2026, "Companies are putting Jev in charge of AI agent
decisions — and prompt injection can influence the verdict"; direct fetch
rate-limited this session, read via search-indexed quotes) reports, with
both vendor and partner on record:

- **TypeSafe's own limitations page (Jev 1.13):** content written to
  adversarially steer the model — "an injected instruction, a deliberately
  misleading framing, or text that argues for its own classification" —
  **can move the answer.**
- **Pydantic's Jev docs:** "Jev treats the state as data, not as hostile";
  reordering a Literal's/Enum's options "can move the answer"; and the
  operative guidance: **"a guard built on Jev belongs alongside
  deterministic checks, not instead of them."**
- An Octomind engineer published a positive demonstration of the effect.
- VentureBeat's audit checklist (useful for any integration we build): log
  **state, schema, option order, model version and confidence on every
  call** (typed answers otherwise vanish from the audit trail), use a
  dedicated workload identity, test option reordering, test adversarial
  text in the state.

Two behaviors we verified *in source* (TipTour's measured comments — a
real integration's field notes, not vendor copy):

- On a true tie Jev does **not** report 50/50 — it breaks toward the first
  key and still reports high confidence. Hence mandatory dedupe of
  identical candidate descriptions before asking.
- Without an explicit `__none__` escape hatch, when the target is genuinely
  absent Jev still picks a wrong element at ~0.71 — "high enough to look
  right and click." With the hatch, true negatives score ~0.96.

> ### ⛔ HARD RULE (non-negotiable, this product's spine)
>
> **Jev may SUGGEST, route, score, triage, rank and flag — it may never
> DECIDE.** A human approval (Muster's OptionCard / Apple Watch) or an
> owner-set policy always decides. Concretely:
>
> 1. Jev output on an approval card is **evidence/metadata only** — the
>    human still taps Allow/Deny, exactly as `approvalHistory` and
>    `rehearsal` are evidence today (`server/index.ts` `request.opened`).
> 2. Jev **never** replaces the deterministic guards in
>    `server/auto-approve.ts` (destructive/sensitive regexes, unattended
>    turns) — those are literal rules and stay literal; the file's own
>    comment already says they are "not a security boundary," and a
>    probabilistic model will not be promoted to one either.
> 3. Jev **never** sits in an access-control path (`server/memory-grants.ts`
>    is default-deny/fail-closed by design) and never issues, implies, or
>    substitutes for any security verdict.
> 4. Every Jev-backed behavior is **off unless configured** and **fails open
>    to today's rules** on missing key, timeout, malformed answer, or low
>    confidence: no key → identical behavior to today.
> 5. Because state content can steer verdicts, a Jev suggestion is only ever
>    attached beside the deterministic signal, never instead of it
>    (Pydantic's phrasing, and our rule).

---

## 2. Muster's high-volume decision points — where a System-ONE model fits

Classification key: **[RULES]** = already equivalent by deterministic rules
today (a Jev call would add cost, latency and injection surface for no
gain); **[ADAPTABLE]** = real fit, pattern exists, Jev could improve it as
suggestion-only; **[GAP]** = nothing covers it today. Volume = is the
decision frequent/cheap enough that Jev's premise (decisions too
high-volume for a frontier call) actually applies?

A structural note first: Muster's wire-level routing is *exact-name
lookup*, not semantic — `server/fleet-mcp.ts` resolves tools with
`TOOLS.find(t => t.name === name)` over 11 bounded tools, and the *calling
harness's* model picks the tool. That boundary is deliberate (bounded MCP,
no approvals tool) and must not be softened.

### 2.1 Fleet-MCP tool routing — **[RULES]** (volume: low–medium)

`server/fleet-mcp.ts` — deterministic dispatch, zod-validated args,
explicitly **no tool for approvals, deletes, credentials, engine changes,
or memory writes**. Semantic routing happens in the *external* agent that
connects. A Jev layer here would only duplicate exact-name matching.
Optional later (owner gate): an advisory "which fleet tool fits this raw
user text" hint for CLI/MCP onboarding docs — nice-to-have, not load-bearing.

### 2.2 Provider / model selection — **[RULES] today, [ADAPTABLE] for per-turn advisory** (volume: **high** — every turn)

- **Error-path classification stays rules.** `server/provider-fallback.ts`
  classifies failures with literal regexes (`RATE_LIMITED`,
  `AUTH_FAILURE`), a 10-minute cooldown, and a deterministic `pickAlternate`
  preferring a different provider family. `server/drivers/acp/core.ts`
  `classifyJsonRpcError` maps JSON-RPC errors to a typed
  `ProviderErrorCode` enum — typed, test-pinned, exactly the class of
  decision where a *deterministic* classifier is correct. **[RULES]**
- **Per-turn model/instance choice is the Jev-shaped gap.** Today model
  selection is the owner's saved `modelSelection`, plus *post-failure*
  fallback; there is no pre-turn "is this task worth a frontier model."
  Muster already ships a deterministic complexity read in
  `server/jev-dispatch.ts` (`taskComplexity`, `modelClassOf`, `fitNote`) —
  advisory only, "bots keep their own models, nothing overridden."
  A Jev `score` (complexity) + `choice` (model-class) per turn is
  **[ADAPTABLE]** and genuinely high-volume. Precedent rule stands: output
  is a fit *note*, never a silent override.

### 2.3 Approval card PRE-TRIAGE (suggestion-only metadata) — **[ADAPTABLE], most sensitive** (volume: medium–high in a busy fleet)

The pipeline already exists and is human-first (`server/index.ts`
`request.opened`, ~L1501–1604):

- `server/auto-approve.ts` `autoDecision()` — the only thing that may answer
  a permission *without* a person: auto mode + always-allow keys, gated by
  literal destructive/sensitive regexes and hard-refused on unattended
  turns. **Deterministic, stays deterministic.**
- Everything else becomes an OptionCard carrying **evidence, not a
  verdict**: `rehearsal` (plan rehearsal), `why` from
  `server/approval-why.ts` (latest prior-run journal entry, redacted),
  `approvalHistory` ("certify-lite… Evidence, not a verdict — the human
  still decides", per the source comment).

**Where Jev fits:** one extra field on the card — e.g.
`triage: { risk: "routine"|"elevated", note, confidence }` from a batched
Noul+Score over `(tool, summary, allowKey, approval-history shape, why)`.
Displayed as a chip beside `held`/`history`, never gating anything, never
auto-answering, and — per §1.5 — treated as steerable because `event.summary`
is bot/attacker-influenceable text. `autoDecision()` must be called first
and unchanged; Jev output must be unable to flip a `null` into an auto-allow.
This is the slice that most needs the owner gate (§5).

### 2.4 why-journal HYPOTHESIS/FINDINGS consistency checks — **[GAP]** (volume: per settled run — high)

`server/why-journal.ts` is deliberately mechanical (ARC pattern:
`WHY:` intent, `HYPOTHESIS:`, `FINDINGS:`, `DECISIONS:` bullets — first
marker wins, missing sections are valid data, never a guess). Nothing
today checks *comparability across runs*: does this run's hypothesis
contradict its findings, does the intent match the receipt's job, do the
decisions look like the same failure shape as last run. A batched Jev ask
(`noul: hypothesis contradicts findings`, `noul: intent matches receipt
job`, `choice: decision-pattern`) producing a **"journal consistency"
suggestion chip** on the card/UI is a clean **[ADAPTABLE]/[GAP]** — purely
advisory, feeds the audit surface, changes no stored entry
(`extractWhyFromReply` stays byte-identical).

### 2.5 Receipt anomaly detection — **[RULES] today for 3 detectors, [ADAPTABLE] for soft signals** (volume: **high** — every settled task)

`server/receipts.ts` is a pure composer; `server/receipt-findings.ts` is
three honest deterministic detectors — failed tool calls, ended-waiting-on-
you, >10 min silence — with an explicit design stance: **"no LLM-as-judge,
no cost, nothing that could hallucinate a verdict."** Those three stay
rules. **[RULES]**

Soft anomalies the detectors structurally cannot see — cost/turns outliers
vs. this bot's own history, a `summary` that doesn't match `job`, a
"clean run" receipt whose why-journal says otherwise — are a legitimate
**[ADAPTABLE]** Jev `noul` batch, appended as *additional* findings clearly
marked as model-suggested (the receipt's additive-field contract already
allows optional fields). Any slice here must explicitly reconcile the
module's no-judge stance — if we can't defend it in the file comment, it
doesn't ship.

### 2.6 Eval / bench scoring — **[RULES] for shape, [GAP]/[ADAPTABLE] for reply quality** (volume: low–medium — value is cost-per-grade, not throughput)

`server/role-eval.ts` grades captures with deterministic checks (thread
identity, receipt freshness, citation→fact binding, roster membership,
verbatim card relay, human decision in audit) and honestly states its
`limitation`: *"a capture attests grounding shape, not truth."* That is
exactly the boundary a **Score** question could advisory-cross: rubric-score
the settled `reply` (helpfulness, instruction-following, tone) as an extra
`RoleCheck`-style field that **never flips passed/failed by itself**.
`scripts/bench-trend.ts` would project it like `elapsedMs`/`tokens` if we
want a trend. LangChain shipping Jev as a LangSmith judge (21 Sep 2026)
validates the shape; keep ours advisory-only so the grade stays
reproducible and the honest `limitation` string survives.

### 2.7 Skills routing — **[GAP]/[ADAPTABLE]** (volume: per task — high)

`server/workspace-skills.ts` (Loop161 CRUD: `listSkills`/`readSkill`/
`writeSkill`/`deleteSkill`, name-gated, 128KB file cap) mounts **every**
non-empty skill into the system prompt via `skillsSystemPrompt`, each
clipped to 4KB, appended — "a skill never outranks the persona or safety
prompts." Selection is entirely the LLM's judgment ("follow them when they
apply"). As skill counts grow, an always-mounted list burns prompt budget
and dilutes attention. A Jev **choice over skill names** (state = task +
skill name/first-line summaries; criteria = skill → what it's for, plus
`none`) can foreground the top-1/top-3 per task — the TypeSafe docs'
"skill suggestion" cookbook is literally this (rank 182 skills in one
request, then re-judge the top three with full text). Design constraint:
the mount decision is advisory to prompt assembly and must degrade to
"mount all" (today's behavior) on any failure. Detailed in §3.

### 2.8 Memory fact classification — split verdict

- **Fact kind guessing — [ADAPTABLE], high volume.**
  `server/workspace-brain.ts` `guessKind()` is a 4-regex list ("cheap,
  deterministic kind guess — overridden by the caller's explicit kind")
  over `person|company|project|decision|note`. Every `brain_write` without
  an explicit kind hits it; it's advisory already and easy to A/B against
  Jev `choice` (or `score` for edge cases). Safe: the caller can always
  override, provenance is mandatory, wrong kind degrades retrieval
  slightly — never access.
- **Access control — HARD OFF-LIMITES.** `server/memory-grants.ts` is
  default-deny, fails **closed** on corruption, revocation-preserves-
  provenance. No model — Jev least of all, given §1.5 — may sit anywhere in
  `authorizeMemoryAccess()`. **[RULES], permanently.**

### 2.9 Calendar / email triage — **[ADAPTABLE]** (calendar, low volume) / **[GAP]** (inbound email, high potential volume)

- **Calendar:** `server/calendar-plan.ts` is a deterministic interval
  packer — "A proposal only." Placement stays rules. What's Jev-shaped:
  *priority/conflict triage* over an event list (which commitments matter,
  is this conflict worth breaking a focus block) as suggestion metadata on
  the proposal. Volume: per "Plan my day" — low; worth it only as a
  batched side-question, not a dedicated call.
- **Email:** `server/email.ts` is **outbound transactional only**
  (verification/reset via Resend). There is **no inbound mail pipeline
  today** — inbound triage is a real **[GAP]** feature, not a defect. When
  an inbox connector lands, Jev's classic fit (subject/snippet →
  `choice: {needs_reply, fyI, archive, urgent}` + `noul: urgent`) becomes
  one of the highest-volume decision points in the product. Do not build
  the call before the pipeline exists.

### 2.10 Dispatch to teammates — already Jev-*style*, rules-only **[RULES]** (precedent to preserve)

`server/jev-dispatch.ts` (Loop108, extended Loop110) is the house
precedent: weighted overlap (title ×3 / name ×2 / description ×1), busy
tie-break, deterministic complexity read, capped brain-fact bonus (+2/fact,
max +4 so memory "refines the ranking, never buys it"), `MAX_CANDIDATES =
250`, and an honest `modelFit` **advisory**. Exposed as `recommend_team`
(`server/drivers/agents-proxy.ts` → loopback-only
`/api/internal/recommend-team` under peer-lease auth), taught to the Chief
of Staff (`server/chief-of-staff.ts`), pinned by
`server/jev-dispatch.test.ts` and `server/brain-dispatch-harness.test.ts`.
A Jev `choice` could optionally be *the chooser* over this enumerated
table — but the deterministic engine is tested, explainable, and free; the
default answer is "keep rules; measure first" (§5).

---

## 3. The "skills" angle — exposing Jev as a Muster skill/routing layer

Two complementary surfaces, both using what already ships.

### 3.1 A workspace skill that teaches the pattern (owner-editable, file-based)

Hosted by the Loop161 CRUD — `skills/jev-decisions.md` in a bot's workspace,
mounted by `skillsSystemPrompt` exactly like any playbook (appended, 4KB
clip, never outranking persona/safety). Content conventions for any agent
that will *issue* Jev calls on Muster's behalf:

1. **Enumerate in software first** — candidates come from real detections
   (roster, skills dir, receipts), each with a unique id; the model only
   chooses (TipTour's `JevCandidate` rule: "never invented — a decision can
   only ever name something real").
2. **Batch speculatively** — one state, every question you might need;
   questions are independent and nearly free; combine answers in code
   (weights live in code, not prompts).
3. **Always include an escape hatch** — a `__none__`/`no candidate`
   option, or true negatives get confident wrong picks (~0.71 measured).
4. **Dedupe identical candidate descriptions** before asking (first-key
   tie-break masquerades as discrimination); keep `state` and `criteria`
   describing the *same world* (mismatched worlds → unstable answers).
5. **Threshold in code, escalate down** — confidence < 0.5 → don't act,
   route to rules/human; per-risk thresholds (read-only vs high-stakes);
   prefer `topProbability`/`margin` over `confidence` when the candidate
   count varies between steps (TipTour's field note).
6. **Reorder options in tests** — answer sensitivity to option order is
   documented by the vendor's partner; a router must be tested with
   shuffled criteria.
7. **Jev suggests, humans decide** — restate the §1.5 hard rule inside the
   skill so any agent loads it before touching an approval surface.

### 3.2 A server-side decision client + loopback route (the "jev skill" as infrastructure)

Shape mirrors the `recommend_team` precedent exactly:

- `server/jev-decide.ts` — pure request/response builders + zod schemas
  (question maps typed `noul|choice|score`; answers validated: probabilities
  finite and in-range, `choice` ∈ criteria keys — TipTour's
  `decision(from:pool:)` validator is the reference implementation to port).
  Network client thin, injectable `fetch`, hard timeouts well under a
  second of budget for inline triage (TipTour's desktop loop tolerates
  20–30s; our card/skill paths must not).
- **Config:** `TYPESAFE_API_KEY` read via `server/config.ts`'s env pattern
  (like `XAI_API_KEY`/`OPENCODE_API_KEY`) — **env/secrets only, never a
  literal, never committed, never echoed back**. Absent key ⇒ feature off,
  byte-identical behavior to today.
- **Route:** loopback-only `/api/internal/jev-decide` beside
  `/api/internal/recommend-team`, same peer-lease auth, read-only
  suggestions in → suggestion out. No new port, no public surface.
- **Audit:** per VentureBeat's checklist, log state-hash, schema, option
  order, model version, confidence, latency — a decision that can't be
  replayed from the log doesn't belong in an audit-driven product.
- **Fail-open ladder:** no key → rules; timeout/malformed → rules; low
  confidence → rules + optional "uncertain" note. Rules never wait on Jev.

### 3.3 What we deliberately do NOT expose

No `decide` tool in `server/fleet-mcp.ts` (bounded by design; approvals
explicitly outside it — "Approvals stay human (Watch / OptionCard); that is
the product's spine"), and no Jev call anywhere inside
`memory-grants.ts`/`auto-approve.ts` guards. If the owner later wants
external agents to batch-classify *their own* text, that's a new bounded
tool discussion with its own gate — not an implied capability.

---

## 4. Verification status summary

| Claim | Status |
|---|---|
| System One/Jev semantics, primitives, confidence, API endpoint, `jev-latest`, text-only, 255-option cap, parallel questions | **Verified** — official docs fetched + MIT TipTour source read |
| TipTour integration practices (dedupe, `__none__`, margin/topProbability, state↔criteria consistency, response validation, metrics) | **Verified from source** (`TipTour/Jev/*`) |
| Launch date/company/founder/RLCD/synthetic data/$40M seed | **Verified via multiple independent outlets** (TechCrunch 18 Sep coverage, TechSpot, DataCamp, systemonemodels.org) |
| Injection can move Jev's verdicts; state treated as data; option order matters | **Vendor + partner statements** reported by VentureBeat 21 Sep (quotes via search index; direct fetch rate-limited) — consistent with TypeSafe's own docs framing |
| 40–200×/400×, $0.042/M, free outputs, 70–500ms, "zero hallucination" marketing | **VENDOR CLAIMS — never stated as fact anywhere in this doc or any code comment** |
| Accuracy/latency benchmarks (ayautomate et al.) | **Community coverage** — not reproduced by us |
| Anything about running Jev against Muster data | **Not done** — no call made, no key used, no measurement taken |

## 5. Recommended slices (small, testable, ranked) — none started

1. **S1 — pure client + contracts.** `server/jev-decide.ts` request/response
   builders + zod validation + fail-open ladder, tested against fixture
   payloads (TipTour-shaped) with injected fetch — *no network in tests*.
   Gate: `npx tsc --noEmit -p tsconfig.server.json` + focused vitest.
2. **S2 — why-journal consistency chip** (§2.4): advisory flag surfaced
   beside card evidence; stored journal untouched.
3. **S3 — skills foregrounding** (§2.7/§3): top-k skill selection feeding
   prompt assembly, degrading to today's mount-all.
4. **S4 — eval reply-quality advisory field** (§2.6): never flips
   pass/fail; `limitation` string preserved; trend projection only if
   owner wants it.
5. **S5 — approval pre-triage chip** (§2.3): **owner gate required first**;
   suggestion-only; `autoDecision` order and semantics unchanged.
6. **Explicit non-goals:** memory access, auto-approve verdicts, fleet-MCP
   approval tools, any security verdict, replacing `jev-dispatch`'s rules,
   inbound-email calls before an inbox pipeline exists.

Measurement discipline for any slice that reaches S3+: run A/B against
today's rules on *our* decision points and report real numbers (the vendor's
200× is a hypothesis about our workload, not a receipt).

## 6. Sources (fetched/read this session)

- Official: docs.typesafe.ai — Introduction, System One, Primitives,
  Confidence, Models; typesafe.ai home/manifesto.
- LangChain: "Building a Harness with Jev" (17 Sep 2026) —
  langchain.com/blog/building-a-harness-with-jev.
- VentureBeat (21 Sep 2026): "Companies are putting Jev in charge of AI
  agent decisions — and prompt injection can influence the verdict."
- TechCrunch launch coverage (18 Sep 2026, via mirrors), TechSpot (20 Sep),
  DataCamp, systemonemodels.org (specs/versions), ayautomate independent
  benchmark (20 Sep).
- Integration reference (MIT): `/private/var/folders/.../opencode/tiptour-src`
  — `TipTour/Jev/JevClient.swift`, `JevGrounding.swift`,
  `scripts/test-jev.sh`, `docs/tiptour-agent-contract.md`.
- In-repo precedent: `server/jev-dispatch.ts`, `docs/plans/ceo-log.md`
  Loop108/110, `docs/plans/session-consolidated-report-2026-09-17.md` §8b,
  `server/fleet-mcp.ts`, `server/auto-approve.ts`, `server/approval-why.ts`,
  `server/why-journal.ts`, `server/receipts.ts`, `server/receipt-findings.ts`,
  `server/role-eval.ts`, `scripts/bench-trend.ts`,
  `server/workspace-skills.ts`, `server/workspace-brain.ts`,
  `server/memory-grants.ts`, `server/memory-retrieval.ts`,
  `server/provider-fallback.ts`, `server/drivers/`, `server/calendar-plan.ts`,
  `server/email.ts`, `server/index.ts` (`request.opened`).
