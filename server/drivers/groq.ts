// Groq — OpenAI-compatible chat-completions API, fast inference for
// open-source models (Llama, Mixtral, Gemma).
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const GroqDriver = createOpenAICompatibleDriver({
  driverKind: "groq",
  displayName: "Groq (API)",
  defaultUrl: "https://api.groq.com/openai/v1",
  defaultApiKeyEnv: "GROQ_API_KEY",
  models: {
    default: "llama-3.3-70b-versatile",
    options: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      // Llama 4 is multimodal (native image understanding) — flagged so
      // modelAcceptsImages unlocks image attach for exactly these entries.
      {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        label: "Llama 4 Scout 17B",
        vision: true,
      },
      {
        id: "meta-llama/llama-4-maverick-17b-128e-instruct",
        label: "Llama 4 Maverick 17B",
        vision: true,
      },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
      { id: "gemma2-9b-it", label: "Gemma 2 9B" },
    ],
  },
  quickModel: "gemma2-9b-it",
});
