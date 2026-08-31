// DeepSeek — OpenAI-compatible chat-completions API.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const DeepSeekDriver = createOpenAICompatibleDriver({
  driverKind: "deepseek",
  displayName: "DeepSeek (API)",
  defaultUrl: "https://api.deepseek.com/v1",
  defaultApiKeyEnv: "DEEPSEEK_API_KEY",
  models: {
    default: "deepseek-chat",
    options: [
      { id: "deepseek-chat", label: "DeepSeek V3 (chat)" },
      { id: "deepseek-reasoner", label: "DeepSeek R1 (reasoner)" },
    ],
  },
  quickModel: "deepseek-chat",
});
