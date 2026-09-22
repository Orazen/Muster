# Tier 1 — engines & local models

Method: README/bundle study via web fetch, 22 Sep 2026. Attachments to `server/drivers/` are proposals, not commitments.

---

## JustVugg/colibri (C, 37.0k★)
- **What**: run frontier MoE models on your own hardware — pure C, zero deps, experts streamed from disk. Tiny engine, immense model.
- **Adopt**: local engine-driver candidate — streamed-expert inference on modest Macs widens the local-driver seam (Ollama/LM Studio/vLLM today). **Leave**: building it ourselves; optional binary install only.
- **Attach**: new driver in `server/drivers/` beside the local trio (composioMcp:true per the every-engine apps fix, degade-to-plain-stream path preserved).
- **Next**: check install size + supported models; measure tok/s on this Mac; pin a tool-less degrade test through fake-mcp-server.

---

## osaurus-ai/osaurus (Swift, 8.0k★)
- **What**: native macOS harness for AI agents — any model, persistent memory, autonomous execution, cryptographic identity, fully offline.
- **Adopt**: three teardowns — (1) local-model serving UX (their model-picker vs our Engines list), (2) cryptographic identity as a pairing/pairing-claim hardening idea, (3) offline autonomy bounds. **Leave**: Swift rewrite; we embed Electron.
- **Attach**: `src/components/EnginesSettings.tsx` (picker teardown), `e2e/pairing-harness.ts` (identity ideas).
- **Next**: read docs on identity + autonomous bounds; write a design-study note; decide whether identity belongs on approval cards (OptionCard signer identity).

---

## DivyamTalwar/fablewright (risk-gated orchestration, 7★)
- **What**: risk-gated multi-model orchestration for Claude Code and Codex — one model writes the spec and accepts the result; pinned second models execute.
- **Adopt**: driver-orchestration pattern — "specifier + executor" mapping onto 1:1 turns that escalate to a room (coordinator/specialist roles). **Leave**: coding-agent-specific glue.
- **Attach**: `server/drivers/` (composite driver), OptionCard flow for acceptance.
- **Next**: read the risk-gate rules; check whether acceptance-on-card can reuse plan rehearsal; test one escalation via fake-ACP `ask` instance.

---

## ARahim3/kaggle-tpu-lab (JAX engine, 514★)
- **What**: frontier-class open models on a free Kaggle TPU v5e-8 (own JAX engine, ~64 tok/s, 262k context).
- **Adopt**: cheap open-model serving study for the BYOK relay flagship (cloud-relay strategy) — self-hosted open models as a relay backend tier. **Leave**: Kaggle-specific notebook.
- **Attach**: cloud-relay backend seam (per `docs/plans/cloud-relay-strategy-2026-09-18.md`).
- **Next**: read the JAX engine seams; note serving cost curve; keep out of scope until the strategy doc's beta gates pass.
