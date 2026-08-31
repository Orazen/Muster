// Local model driver — one OpenAI-shaped client for Ollama, LM Studio, and
// vLLM. Three (or more) servers are instances of this one driver: each has
// its own config.json entry with a baseUrl. Built on the shared compatible
// factory with the local-server options:
//
//   keyless        — no API key is required; a placeholder Bearer is sent
//   pingSnapshot   — "available" means something actually answered the port
//   dynamicModels  — the picker lists only what GET /v1/models returns
//                    (models the user actually pulled), refreshed live
//
// Compatibility notes learned from pi's local support: `system` role only
// (the factory never sends `developer`), and no effortLevels — local
// engines have no reasoning-effort knob.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1";

/** Shown until the first /v1/models fetch answers; after that the server's
 * own list wins. These are common pulls, not promises — a bot picking one
 * that isn't pulled fails honestly at send time and refreshModels() fixes
 * the picker. */
const FALLBACK_MODELS = {
  default: "llama3.2",
  options: [
    { id: "llama3.2", label: "llama3.2" },
    { id: "qwen2.5", label: "qwen2.5" },
    { id: "mistral", label: "mistral" },
  ],
};

export const LocalDriver = createOpenAICompatibleDriver({
  driverKind: "local",
  displayName: "Local (Ollama / LM Studio / vLLM)",
  defaultUrl: DEFAULT_OLLAMA_URL,
  defaultApiKeyEnv: "LOCAL_API_KEY",
  models: FALLBACK_MODELS,
  quickModel: "llama3.2",
  keyless: true,
  pingSnapshot: true,
  dynamicModels: true,
  install: {
    // Installed-but-not-running is the dominant local failure, so the
    // sign-in slot carries the start command rather than a login.
    command: {
      darwin: "brew install ollama",
      linux: "curl -fsSL https://ollama.com/install.sh | sh",
    },
    signInCommand: "ollama serve",
    docsUrl: "https://ollama.com/download",
  },
  // Honest capability flags: a local engine gets none of the harness's
  // mounted integrations by default — no cloud computer, no connected apps.
  capabilities: { computerMcp: false, composioMcp: false },
});
