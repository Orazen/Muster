// Mistral — OpenAI-compatible chat-completions API.
import { createOpenAICompatibleDriver } from "./openai-compatible.ts";

export const MistralDriver = createOpenAICompatibleDriver({
  driverKind: "mistral",
  displayName: "Mistral (API)",
  defaultUrl: "https://api.mistral.ai/v1",
  defaultApiKeyEnv: "MISTRAL_API_KEY",
  models: {
    default: "mistral-large-latest",
    options: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-medium-latest", label: "Mistral Medium" },
      { id: "codestral-latest", label: "Codestral" },
      // Pixtral is Mistral's multimodal line — flagged for modelAcceptsImages.
      { id: "pixtral-large-latest", label: "Pixtral Large (vision)", vision: true },
      { id: "pixtral-12b-2409", label: "Pixtral 12B (vision)", vision: true },
    ],
  },
  quickModel: "mistral-medium-latest",
});
