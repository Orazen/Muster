// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { AnthropicDriver } from "./anthropic.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BoxAgentDriver } from "./boxagent.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { CohereDriver } from "./cohere.ts";
import { DeepSeekDriver } from "./deepseek.ts";
import { FireworksDriver } from "./fireworks.ts";
import { GoogleDriver } from "./google.ts";
import { GrokDriver } from "./grok.ts";
import { GroqDriver } from "./groq.ts";
import { MistralDriver } from "./mistral.ts";
import { OpenAIDriver } from "./openai.ts";
import { OpenCodeZenDriver } from "./opencode-zen.ts";
import { OpenRouterDriver } from "./openrouter.ts";
import { TogetherDriver } from "./together.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { KimiAgentDriver } from "./acp/kimi.ts";
import { DroidAgentDriver } from "./acp/droid.ts";
import { OpenCodeGoDriver } from "./acp/opencode-go.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  GrokDriver,
  OpenAIDriver,
  AnthropicDriver,
  GoogleDriver,
  DeepSeekDriver,
  MistralDriver,
  CohereDriver,
  GroqDriver,
  TogetherDriver,
  FireworksDriver,
  OpenRouterDriver,
  OpenCodeZenDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver,
  DroidAgentDriver,
  OpenCodeGoDriver,
  QwenAgentDriver,
  HermesAgentDriver,
  ClaudeDriver,
  CodexDriver,
  AntigravityDriver,
  BoxAgentDriver,
];
