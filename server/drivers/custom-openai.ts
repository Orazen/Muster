// Custom BYOK provider driver — an OpenAI-compatible chat-completions
// endpoint the user pointed Muster at (Settings → Providers → Add model
// provider). Identical wire behavior to the built-in openai-compatible
// twins; the difference is configuration ownership: url, key env var and
// the model catalog all arrive from the instance config (custom-providers
// .ts), so a user-registered gateway behaves exactly like DeepSeek or Groq
// everywhere — picker, health, chat, usage. The factory reads `models` out
// of instance config, so edits hot-reload with the fleet.
//
// computerMcp/composioMcp use the factory defaults (on): the tool-call wire
// loop is the same one DeepSeek and Groq ride, so a custom endpoint gets
// computers and connected apps too — this used to be hardcoded off, which
// surfaced as "this model engine cannot use the Local VM" for any bot on a
// custom provider.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const CustomOpenaiDriver = createOpenAICompatibleDriver({
  driverKind: "customOpenai",
  displayName: "Custom provider (OpenAI format)",
  defaultUrl: "https://api.example.com/v1",
  defaultApiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
  // Real catalog arrives per-instance from config; the empty fallback is
  // honest — a custom provider with no configured models can't be picked.
  models: { default: "", options: [] },
  quickModel: "",
});
