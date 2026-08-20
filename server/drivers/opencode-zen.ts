// OpenCode Zen — OpenCode's hosted model gateway (opencode.ai/zen),
// OpenAI-compatible chat-completions API. Verified live against the real
// endpoint during integration: https://opencode.ai/zen/v1/chat/completions
// returns a standard {choices[0].message.content, usage} shape, same key
// works for both the general Zen catalog and the OpenCode Go subset
// (server/drivers/acp/opencode-go.ts's CLI-driven product), and free-tier
// models genuinely report "cost":"0". Reuses the OPENCODE_API_KEY env var
// name Muster already established for OpenCode Go, since one key serves
// both products.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const OpenCodeZenDriver = createOpenAICompatibleDriver({
  driverKind: "opencodeZen",
  displayName: "OpenCode Zen (API)",
  defaultUrl: "https://opencode.ai/zen/v1",
  defaultApiKeyEnv: "OPENCODE_API_KEY",
  models: {
    default: "deepseek-v4-flash-free",
    options: [
      { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)" },
      { id: "muse-spark-1.2-contributor-free", label: "Muse Spark 1.2 (free)" },
      { id: "mimo-v2.5-free", label: "MiMo V2.5 (free)" },
      { id: "hy3-free", label: "HY3 (free)" },
      { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)" },
      { id: "kimi-k3", label: "Kimi K3" },
      { id: "glm-5.2", label: "GLM 5.2" },
      { id: "minimax-m3", label: "Minimax M3" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 (via Zen)" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (via Zen)" },
    ],
  },
  quickModel: "deepseek-v4-flash-free",
});
