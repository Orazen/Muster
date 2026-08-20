// Together AI — OpenAI-compatible chat-completions API for open-source
// models (Llama, Mixtral, Qwen).
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const TogetherDriver = createOpenAICompatibleDriver({
  driverKind: "together",
  displayName: "Together AI (API)",
  defaultUrl: "https://api.together.xyz/v1",
  defaultApiKeyEnv: "TOGETHER_API_KEY",
  models: {
    default: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    options: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" },
      { id: "mistralai/Mixtral-8x7B-Instruct-v0.1", label: "Mixtral 8x7B" },
      { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen 2.5 72B Turbo" },
    ],
  },
  quickModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
});
