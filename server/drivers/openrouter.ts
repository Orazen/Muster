// OpenRouter — OpenAI-compatible chat-completions API, proxies 200+ models
// (GPT, Claude, Gemini, open-source) through a single account/key.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const OpenRouterDriver = createOpenAICompatibleDriver({
  driverKind: "openrouter",
  displayName: "OpenRouter (API)",
  defaultUrl: "https://openrouter.ai/api/v1",
  defaultApiKeyEnv: "OPENROUTER_API_KEY",
  models: {
    default: "openai/gpt-4o",
    options: [
      // Every entry here is multimodal — flagged so modelAcceptsImages
      // unlocks image attach for exactly these.
      { id: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", vision: true },
      { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)", vision: true },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)", vision: true },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)", vision: true },
    ],
  },
  quickModel: "openai/gpt-4o-mini",
});
