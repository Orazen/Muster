import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileTrajectory,
  parseTrajectory,
  replaySkill,
  serializeTrajectory,
  substituteInputs,
  type TeachTrajectory,
} from "./teach-replay";

const recorded: TeachTrajectory = {
  version: 1,
  steps: [
    { kind: "click", role: "button", name: "Sign in" },
    { kind: "type", role: "textbox", name: "Email", value: { kind: "input", name: "email", default: "sam@example.com" } },
    { kind: "shell", command: { kind: "input", name: "target", default: "/srv/app" } },
  ],
};

describe("teach-replay trajectory serialization", () => {
  it("round-trips a trajectory through JSON with exact demonstrated values", () => {
    const exact: TeachTrajectory = {
      version: 1,
      steps: [
        { kind: "type", role: "textbox", name: "Note", value: { kind: "literal", value: "  e\u0301 brief\n\t" } },
        { kind: "shell", command: { kind: "input", name: "dir", default: "/tmp/\ud83c\udf38" } },
      ],
    };
    expect(parseTrajectory(serializeTrajectory(exact))).toEqual(exact);
  });

  it.each([
    ["not JSON at all", "{not json"],
    ["a future schema version", JSON.stringify({ ...recorded, version: 2 })],
    ["an unknown step kind", JSON.stringify({ version: 1, steps: [{ kind: "hover", role: "button", name: "x" }] })],
    ["a missing accessible name", JSON.stringify({ version: 1, steps: [{ kind: "click", role: "button" }] })],
    ["a coerced numeric value", JSON.stringify({ version: 1, steps: [{ kind: "shell", command: { kind: "literal", value: 7 } }] })],
    ["an unknown field", JSON.stringify({ version: 1, steps: [], extra: true })],
  ])("rejects %s instead of coercing it", (_label, json) => {
    expect(() => parseTrajectory(json)).toThrow();
  });
});

describe("teach-replay parameter substitution", () => {
  it("compiles demonstrated values into declared inputs with the demonstration as default", () => {
    expect(compileTrajectory(recorded).inputs).toEqual([
      { name: "email", default: "sam@example.com" },
      { name: "target", default: "/srv/app" },
    ]);
  });

  it("collapses a repeated input with the same default and rejects conflicting defaults", () => {
    const repeated: TeachTrajectory = {
      version: 1,
      steps: [
        { kind: "shell", command: { kind: "input", name: "dir", default: "/srv" } },
        { kind: "shell", command: { kind: "input", name: "dir", default: "/srv" } },
      ],
    };
    expect(compileTrajectory(repeated).inputs).toEqual([{ name: "dir", default: "/srv" }]);

    const conflicting: TeachTrajectory = {
      version: 1,
      steps: [
        { kind: "shell", command: { kind: "input", name: "dir", default: "/srv" } },
        { kind: "shell", command: { kind: "input", name: "dir", default: "/opt" } },
      ],
    };
    expect(() => compileTrajectory(conflicting)).toThrow(/dir/);
  });

  it("substitutes each input's demonstrated default when no override is given", () => {
    expect(substituteInputs(compileTrajectory(recorded))).toEqual([
      { kind: "click", role: "button", name: "Sign in" },
      { kind: "type", role: "textbox", name: "Email", value: "sam@example.com" },
      { kind: "shell", command: "/srv/app" },
    ]);
  });

  it("applies overrides in place of defaults and leaves literals alone", () => {
    expect(substituteInputs(compileTrajectory(recorded), { email: "kim@example.com" })).toEqual([
      { kind: "click", role: "button", name: "Sign in" },
      { kind: "type", role: "textbox", name: "Email", value: "kim@example.com" },
      { kind: "shell", command: "/srv/app" },
    ]);
  });

  it("rejects an override the skill never declared", () => {
    expect(() => substituteInputs(compileTrajectory(recorded), { token: "x" })).toThrow(/token/);
  });
});

describe("teach-replay verifier", () => {
  it("returns an explicit ok verdict when every step observes its recorded condition", () => {
    const skill = compileTrajectory(recorded);
    const observed = ['button "Sign in"', "kim@example.com", "/srv/app"];
    const verdict = replaySkill(skill, { email: "kim@example.com" }, (_step, index) => ({ observed: observed[index] }));
    expect(verdict).toEqual({ ok: true });
  });

  it("names the broken step when an observation diverges from the recording", () => {
    const skill = compileTrajectory(recorded);
    const observed = ['button "Sign in"', 'button "Continue"'];
    const verdict = replaySkill(skill, {}, (_step, index) => ({ observed: observed[index] }));
    expect(verdict).toEqual({
      ok: false,
      failedStep: 1,
      observed: 'button "Continue"',
      expected: "sam@example.com",
    });
  });

  it("fails the verdict with the backend error when a step cannot run", () => {
    const skill = compileTrajectory(recorded);
    const verdict = replaySkill(skill, {}, (_step, index) =>
      index === 2
        ? { error: "command refused by approval broker" }
        : { observed: index === 0 ? 'button "Sign in"' : "sam@example.com" });
    expect(verdict).toEqual({
      ok: false,
      failedStep: 2,
      observed: "command refused by approval broker",
      expected: "/srv/app",
    });
  });

  it("fails rather than passing when a step produces no observation", () => {
    const skill = compileTrajectory(recorded);
    const verdict = replaySkill(skill, {}, (_step, index) =>
      index === 0 ? {} : { observed: index === 1 ? "sam@example.com" : "/srv/app" });
    expect(verdict).toEqual({ ok: false, failedStep: 0, expected: 'button "Sign in"' });
  });

  it("treats an empty demonstration as a valid, explicitly-verified no-op", () => {
    const empty: TeachTrajectory = { version: 1, steps: [] };
    expect(parseTrajectory(serializeTrajectory(empty))).toEqual(empty);
    const skill = compileTrajectory(empty);
    expect(skill.inputs).toEqual([]);
    expect(substituteInputs(skill)).toEqual([]);
    expect(replaySkill(skill, {}, () => {
      throw new Error("runner must not be called for an empty skill");
    })).toEqual({ ok: true });
  });
});

describe("teach-replay harness freedom", () => {
  it("keeps zod as the module's only import", () => {
    const source = readFileSync(fileURLToPath(new URL("./teach-replay.ts", import.meta.url)), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(specifiers).toEqual(["zod"]);
  });
});