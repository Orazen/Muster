// Engine CLIs run model-driven shell commands, so the harness's own secrets
// must never reach their environment. These tests pin the helper and the
// real spawn choke point (procs.ts) every engine driver goes through.
import { afterEach, describe, expect, it } from "vitest";

import { execCli, spawnCli } from "../procs.ts";
import { isServerSecretEnvName, stripServerSecrets } from "./child-env.ts";

const PLANTED = {
  BETTER_AUTH_SECRET: "auth-secret-should-not-leak",
  VAULTGRAM_PASSPHRASE: "vault-passphrase-should-not-leak",
  STRIPE_SECRET_KEY: "sk_test_should_not_leak",
  GOOGLE_CLIENT_SECRET: "google-secret-should-not-leak",
  COMPOSIO_API_KEY: "composio-should-not-leak",
} as const;

describe("isServerSecretEnvName", () => {
  it("flags harness secrets by name and pattern", () => {
    for (const name of [
      "BETTER_AUTH_SECRET",
      "better_auth_secret",
      "BETTER_AUTH_URL",
      "VAULTGRAM_PASSPHRASE",
      "VAULTGRAM_GOOGLE_REFRESH_TOKEN",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GITHUB_CLIENT_SECRET",
      "MUSTER_SYNC_PASSPHRASE",
      "OMB_COMPOSIO_BROKER_TOKEN",
      "COMPOSIO_API_KEY",
      "RESEND_API_KEY",
    ]) {
      expect(isServerSecretEnvName(name), name).toBe(true);
    }
  });

  it("keeps what engines and their proxies need", () => {
    for (const name of [
      "PATH",
      "HOME",
      "LANG",
      "TMPDIR",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "OPENCODE_API_KEY",
      "BOX_TOKEN",
      "OMB_COMMS_TOKEN",
      "OMB_CONNECTOR_UPSTREAM_HEADERS",
      "OMB_BOT_ID",
      "AWS_SECRET_ACCESS_KEY",
      "HTTPS_PROXY",
    ]) {
      expect(isServerSecretEnvName(name), name).toBe(false);
    }
  });
});

describe("stripServerSecrets", () => {
  it("removes secrets without mutating the source", () => {
    const source = { PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "k", ...PLANTED };
    const env = stripServerSecrets(source);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "k" });
    expect(source.BETTER_AUTH_SECRET).toBe(PLANTED.BETTER_AUTH_SECRET);
  });
});

describe("engine spawn choke point", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const plant = () => {
    for (const [key, value] of Object.entries(PLANTED)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  };
  const dumpEnv = "process.stdout.write(JSON.stringify(process.env))";

  it("spawnCli never hands the auth secret to a child, even via an explicit env spread", async () => {
    plant();
    const child = spawnCli(process.execPath, ["-e", dumpEnv], {
      env: { ...process.env, MUSTER_TEST_MARKER: "kept" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    // SAFETY: the child prints JSON.stringify(process.env), a flat string map
    const env = JSON.parse(out) as Record<string, string>;
    for (const key of Object.keys(PLANTED)) expect(env[key], key).toBeUndefined();
    expect(out).not.toContain(PLANTED.BETTER_AUTH_SECRET);
    expect(env.MUSTER_TEST_MARKER).toBe("kept");
    expect(env.PATH).toBeTruthy();
  });

  it("spawnCli strips secrets when the caller passes no env at all", async () => {
    plant();
    const child = spawnCli(process.execPath, ["-e", dumpEnv], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(out).not.toContain(PLANTED.BETTER_AUTH_SECRET);
    expect(out).not.toContain(PLANTED.VAULTGRAM_PASSPHRASE);
  });

  it("execCli (version/auth probes) strips secrets too", async () => {
    plant();
    const out = await new Promise<string>((resolve, reject) =>
      execCli(process.execPath, ["-e", dumpEnv], { env: { ...process.env } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );
    expect(out).not.toContain(PLANTED.BETTER_AUTH_SECRET);
    expect(JSON.parse(out).PATH).toBeTruthy();
  });
});
