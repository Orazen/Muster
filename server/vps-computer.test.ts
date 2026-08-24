// Tests for the BYO VPS computer: alias validation, DOCKER_HOST routing,
// and the docker-only guard. No real ssh or docker is ever spawned.
import { describe, expect, it } from "vitest";

import { isValidSshAlias, vpsSshAlias } from "./config.ts";
import { vpsComputerStatus, vpsDockerHost, vpsSh } from "./vps-computer.ts";

describe("ssh alias validation", () => {
  const valid = ["my-vps", "My.VPS_01", "v", "a".repeat(128)];
  const invalid = ["", "-leading", "under score", "semi;colon", "pipe|cmd", "$VAR", "flag/--example", "a".repeat(129), null, 42];

  for (const alias of valid) {
    it(`accepts ${String(alias).slice(0, 24)}`, () => {
      expect(isValidSshAlias(alias)).toBe(true);
    });
  }
  for (const alias of invalid) {
    it(`rejects ${JSON.stringify(String(alias)).slice(0, 24)}`, () => {
      expect(isValidSshAlias(alias)).toBe(false);
    });
  }

  it("degrades an invalid stored alias to not-configured", () => {
    // SAFETY: constructing a narrow object literal instead of casting a
    // dictionary keeps this a compile-checked AppConfig shape.
    const cfg = { vps: { sshAlias: "not;an alias" } };
    expect(vpsSshAlias(cfg as Parameters<typeof vpsSshAlias>[0])).toBeNull();
  });
});

describe("docker host routing", () => {
  it("builds an ssh:// URL from the alias", () => {
    expect(vpsDockerHost("my-vps")).toBe("ssh://my-vps");
  });

  it("refuses to route an invalid alias anywhere", () => {
    expect(() => vpsDockerHost("bad alias")).toThrow(/invalid VPS SSH config alias/);
  });

  it("runner passes argv through but injects DOCKER_HOST into the child", async () => {
    const probe = vpsSh("my-vps");
    // A real node child prints its own DOCKER_HOST — proving the env reached
    // the process while argv stayed untouched.
    const { stdout } = await probe(process.execPath, [
      "-e",
      "process.stdout.write(process.env.DOCKER_HOST ?? 'MISSING')",
    ]);
    expect(stdout).toBe("ssh://my-vps");
  }, 20_000);
});

describe("remote status guard rails", () => {
  it("reports a problem when nothing is reachable", async () => {
    // An unroutable alias makes every docker call fail inside the runner,
    // which containerComputerStatus reports as no runtime. Use an alias that
    // fails DNS fast rather than hanging: RFC 6761 .invalid TLD.
    const target = {
      key: "vps-test",
      containerName: "muster-vps-test",
      workspaceDir: "/tmp/muster-vps-test",
      viewerPort: 5999,
    };
    const status = await vpsComputerStatus("muster-test.invalid", target as never);
    expect(status.ready).toBe(false);
    expect(status.problem ?? "").toMatch(/VPS computer:/);
  }, 30_000);
});
