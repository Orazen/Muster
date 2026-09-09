// Vibe ACP: https://docs.mistral.ai/vibe/code/cli/install-setup
// Uses the configured model, then confirms default (approval-enabled) mode.
// Form elicitation is intentionally not advertised by the ACP client.
import { z } from "zod";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const VIBE_CONFIGURED_MODEL = "vibe-configured";
const confirmation = z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.union([z.string(), z.boolean()]) })) });
const support: AcpSupport = {
  driverKind: "vibeAgent", displayName: "Mistral Vibe", access: "custom",
  models: { default: VIBE_CONFIGURED_MODEL, options: [{ id: VIBE_CONFIGURED_MODEL, label: "Vibe configured model" }] },
  defaultCli: "vibe-acp", nativeSource: "vibe.acp",
  install: { docsUrl: "https://docs.mistral.ai/vibe/code/cli/install-setup" },
  loginNote: "Set a Mistral API key in Muster's provider settings or MISTRAL_API_KEY for this instance.",
  spawnArgs: () => [], credentialEnv: ["MISTRAL_API_KEY"],
  pickAuthMethod: () => null, authFailure: "continue",
  isAuthenticated: (env) => Boolean(env.MISTRAL_API_KEY?.trim()),
  async configureSession({ request, sessionId, turn }) {
    let response = confirmation.parse(await request("session/set_config_option", { sessionId, configId: "mode", value: "default" }));
    const current = (id: string) => response.configOptions.find((option) => option.id === id)?.currentValue;
    if (current("mode") !== "default") throw new Error("Vibe did not confirm default approval mode; no prompt was sent.");
    if (turn.model && turn.model !== VIBE_CONFIGURED_MODEL && turn.model !== current("model")) {
      response = confirmation.parse(await request("session/set_config_option", { sessionId, configId: "model", value: turn.model }));
      if (current("model") !== turn.model) throw new Error("Vibe did not confirm the requested model; no prompt was sent.");
    }
    if (current("mode") !== "default") throw new Error("Vibe changed approval mode during model selection; no prompt was sent.");
    return { model: z.string().min(1).parse(current("model")) };
  },
};
export const VibeAgentDriver = createAcpDriver(support);
