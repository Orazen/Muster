import { describe, expect, it } from "vitest";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scoutProject, suggestTeam } from "./project-scout.ts";

const ROOT = join(tmpdir(), `muster-scout-test-${process.pid}`);

function makeProject(files: Record<string, string>, dirs: string[] = []): string {
  const cwd = join(ROOT, Math.random().toString(36).slice(2));
  mkdirSync(cwd, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  for (const dir of dirs) mkdirSync(join(cwd, dir), { recursive: true });
  return cwd;
}

describe("project scout", () => {
  it("profiles a react+prisma repo: name, summary, stacks, roles", () => {
    const cwd = makeProject(
      {
        "package.json": JSON.stringify({
          name: "acme-web",
          description: "customer portal",
          dependencies: { react: "^19", prisma: "^6", express: "^5" },
          devDependencies: { vitest: "^3" },
        }),
        "README.md": "# Acme Web\n\nThe customer portal for Acme.\n",
      },
      ["prisma", "server"],
    );
    const p = scoutProject(cwd);
    expect(p.name).toBe("Acme Web");
    expect(p.summary).toBe("The customer portal for Acme.");
    expect(p.stacks).toContain("React");
    expect(p.stacks.some((x) => x === "TypeScript" || x === "Node")).toBe(true);
    const roles = p.signals.map((s) => s.role);
    expect(roles).toContain("frontend");
    expect(roles).toContain("data");
    expect(roles).toContain("backend");
    expect(roles).toContain("testing");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("suggests a lead plus one member per detected role, with reasons", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({ name: "api", dependencies: { fastapi: "0" } }),
    });
    const s = suggestTeam(scoutProject(cwd));
    expect(s.members[0].name).toBe("Compass");
    expect(s.members.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(s.reasons).length).toBe(s.members.length);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("falls back to a generalist when nothing is detected", () => {
    const cwd = makeProject({ "notes.txt": "nothing here" });
    const s = suggestTeam(scoutProject(cwd));
    expect(s.members).toHaveLength(2);
    expect(s.members[1].name).toBe("Wrench");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("caps the lineup at lead + 5 specialists", () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({
        dependencies: {
          react: "1", express: "1", "react-native": "1", prisma: "1",
          vitest: "1", typescript: "1", next: "1",
        },
      }),
      Dockerfile: "FROM node",
    });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "guide.md"), "docs");
    const s = suggestTeam(scoutProject(cwd));
    expect(s.members.length).toBeLessThanOrEqual(6);
    rmSync(cwd, { recursive: true, force: true });
  });
});
