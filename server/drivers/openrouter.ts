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
      { id: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)" },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)" },
    ],
  },
  quickModel: "openai/gpt-4o-mini",
});
