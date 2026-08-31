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
      // Every entry here is multimodal-flagged from OpenRouter's live
      // architecture metadata so modelAcceptsImages unlocks image attach for
      // exactly these.
      { id: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", vision: true },
      { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (via OpenRouter)", vision: true },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)", vision: true },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)", vision: true },

      // Ox Alpha — stealth-route flagship: 1M context, image+video input.
      { id: "stealth/ox-alpha", label: "Ox Alpha (via OpenRouter)", vision: true },

      // Free tier (:free) — zero-cost models, refreshed 2026-08-24 against
      // openrouter.ai/api/v1/models. Media-only and classifier endpoints
      // (Lyria music previews, Nemotron content-safety) are excluded on
      // purpose: they don't answer chat turns.
      { id: "openrouter/free", label: "OpenRouter Free Auto (free)", vision: true },
      { id: "z-ai/glm-5.2:free", label: "GLM 5.2 (free)" },
      { id: "thinkingmachines/inkling:free", label: "Inkling (free)", vision: true },
      { id: "thinkingmachines/inkling-small:free", label: "Inkling Small (free)", vision: true },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (free)" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (free)" },
      { id: "nvidia/nemotron-3-nano-30b-a3b:free", label: "Nemotron 3 Nano 30B (free)" },
      { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Omni 30B Reasoning (free)", vision: true },
      { id: "nvidia/nemotron-nano-12b-v2-vl:free", label: "Nemotron Nano 12B VL (free)", vision: true },
      { id: "nvidia/nemotron-nano-9b-v2:free", label: "Nemotron Nano 9B v2 (free)" },
      { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free)", vision: true },
      { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B A4B (free)", vision: true },
      { id: "cohere/north-mini-code:free", label: "North Mini Code (free)" },
      { id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free)" },
      { id: "poolside/laguna-xs-2.1:free", label: "Laguna XS 2.1 (free)" },
      { id: "liquid/lfm-2.5-2.6b:free", label: "LFM 2.5 2.6B (free)" },
      { id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note Preview (free)", vision: true },
    ],
  },
  quickModel: "openai/gpt-4o-mini",
});
