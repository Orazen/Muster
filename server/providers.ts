// Catalog of known AI/cloud providers. Each entry defines the metadata
// needed to render a key-paste row in the Providers settings panel.
// Secrets are write-only — the UI sees only configured-or-not booleans.

export interface ProviderEntry {
  id: string;
  label: string;
  placeholder: string;
  description: string;
  href: string;
  linkLabel: string;
  /** The config key under AppConfig.providers. */
  configKey: string;
}

export const PROVIDERS: ProviderEntry[] = [
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    description: "GPT-4o, GPT-4.1, o3, and image generation through the OpenAI API.",
    href: "https://platform.openai.com/api-keys",
    linkLabel: "Get an OpenAI API key",
    configKey: "openai",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-…",
    description: "Claude Opus, Sonnet, and Haiku through the Anthropic API.",
    href: "https://console.anthropic.com/settings/keys",
    linkLabel: "Get an Anthropic API key",
    configKey: "anthropic",
  },
  {
    id: "google",
    label: "Google",
    placeholder: "AIza…",
    description: "Gemini 2.5 Pro/Flash through the Google AI Studio API.",
    href: "https://aistudio.google.com/apikey",
    linkLabel: "Get a Google AI API key",
    configKey: "google",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    placeholder: "xai-…",
    description: "Grok 3 and Grok 3 Mini through the xAI API.",
    href: "https://console.x.ai",
    linkLabel: "Get an xAI API key",
    configKey: "xai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    placeholder: "sk-…",
    description: "DeepSeek V3 and R1 through the DeepSeek API.",
    href: "https://platform.deepseek.com/api_keys",
    linkLabel: "Get a DeepSeek API key",
    configKey: "deepseek",
  },
  {
    id: "mistral",
    label: "Mistral",
    placeholder: "…",
    description: "Mistral Large, Medium, and codestral through the Mistral API.",
    href: "https://console.mistral.ai/api-keys/",
    linkLabel: "Get a Mistral API key",
    configKey: "mistral",
  },
  {
    id: "cohere",
    label: "Cohere",
    placeholder: "…",
    description: "Command R+ and Embed through the Cohere API.",
    href: "https://dashboard.cohere.com/api-keys",
    linkLabel: "Get a Cohere API key",
    configKey: "cohere",
  },
  {
    id: "groq",
    label: "Groq",
    placeholder: "gsk_…",
    description: "Llama, Mixtral, and Gemma at high speed through Groq's inference API.",
    href: "https://console.groq.com/keys",
    linkLabel: "Get a Groq API key",
    configKey: "groq",
  },
  {
    id: "together",
    label: "Together AI",
    placeholder: "…",
    description: "Open-source models (Llama, Mixtral, Qwen) via Together's inference API.",
    href: "https://api.together.xyz/settings/api-keys",
    linkLabel: "Get a Together API key",
    configKey: "together",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    placeholder: "fw_…",
    description: "Fast inference for open-source models through Fireworks.",
    href: "https://fireworks.ai/account/api-keys",
    linkLabel: "Get a Fireworks API key",
    configKey: "fireworks",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-…",
    description: "Access 200+ models (GPT, Claude, Gemini, open-source) through a single API.",
    href: "https://openrouter.ai/keys",
    linkLabel: "Get an OpenRouter API key",
    configKey: "openrouter",
  },
  {
    id: "opencodeZen",
    label: "OpenCode Zen",
    placeholder: "sk-…",
    description: "Free and paid models (DeepSeek, GLM, Kimi, Claude, GPT via Zen) through OpenCode's hosted gateway. Same key as OpenCode Go.",
    href: "https://opencode.ai/zen",
    linkLabel: "Get an OpenCode Zen API key",
    configKey: "opencodeZen",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    placeholder: "…",
    description: "Text-to-speech and voice cloning for bot voice output.",
    href: "https://elevenlabs.io/app/settings/api-keys",
    linkLabel: "Get an ElevenLabs API key",
    configKey: "elevenlabs",
  },
];
