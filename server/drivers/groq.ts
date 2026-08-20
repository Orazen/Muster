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
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
      { id: "gemma2-9b-it", label: "Gemma 2 9B" },
    ],
  },
  quickModel: "gemma2-9b-it",
});
