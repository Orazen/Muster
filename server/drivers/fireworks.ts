// Fireworks AI — OpenAI-compatible chat-completions API.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const FireworksDriver = createOpenAICompatibleDriver({
  driverKind: "fireworks",
  displayName: "Fireworks AI (API)",
  defaultUrl: "https://api.fireworks.ai/inference/v1",
  defaultApiKeyEnv: "FIREWORKS_API_KEY",
  models: {
    default: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    options: [
      { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "accounts/fireworks/models/qwen2p5-72b-instruct", label: "Qwen 2.5 72B" },
    ],
  },
  quickModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
});
