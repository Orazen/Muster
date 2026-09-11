import { describe, expect, it } from "vitest";
import { observeOwnedPosixGroup, parsePosixProcessTable, readPosixProcessTable } from "../scripts/owned-posix-processes.mjs";

describe("owned POSIX process observation", () => {
  it("finds a live descendant after its leader disappears, ignoring unrelated groups", () => {
    const table = () => parsePosixProcessTable("  901 900 S+\n  902 900 Z\n  9000 9000 Rs\n");
    expect(observeOwnedPosixGroup(900, table)).toEqual({
      members: [{ pid: 901, pgid: 900, state: "S+" }, { pid: 902, pgid: 900, state: "Z" }],
      liveMembers: [{ pid: 901, pgid: 900, state: "S+" }],
    });
    expect(observeOwnedPosixGroup(90, table).members).toEqual([]);
  });

  it("retains zombie membership evidence without claiming a live process", () => {
    const observed = observeOwnedPosixGroup(900, () => parsePosixProcessTable("901 900 Z+\n902 900 Z\n"));
    expect(observed.members).toHaveLength(2);
    expect(observed.liveMembers).toEqual([]);
  });

  it("treats stopped and uninterruptible members as live", () => {
    const observed = observeOwnedPosixGroup(900, () => parsePosixProcessTable("901 900 T\n902 900 D<\n"));
    expect(observed.liveMembers).toHaveLength(2);
  });

  it("treats Darwin unknown task state as potentially live", () => {
    const observed = observeOwnedPosixGroup(900, () => parsePosixProcessTable("901 900 ?\n902 900 ?s\n903 901 ?\n"));
    expect(observed.members).toHaveLength(2);
    expect(observed.liveMembers).toHaveLength(2);
  });

  it.each([undefined, 0, 1, -900, 9.5, Number.MAX_SAFE_INTEGER + 1, "900"])("rejects unsafe owned group %s before observing", (pid) => {
    expect(() => observeOwnedPosixGroup(pid, () => { throw new Error("must not read"); })).toThrow("Expected an owned process group ID");
  });

  it.each(["", "pid pgid stat", "12 9", "12 9 S extra", "12 9 !", "9007199254740992 9 S", "12 9 S\n12 10 R"])("fails closed on malformed process output %j", (output) => {
    expect(() => readPosixProcessTable(() => output)).toThrow(/process (table|IDs)/);
  });

  it.each(["EPERM", "ETIMEDOUT", "ENOBUFS"])("preserves observer command failure %s", (code) => {
    const error = Object.assign(new Error("owned ps failed"), { code });
    expect(() => observeOwnedPosixGroup(900, () => readPosixProcessTable(() => { throw error; }))).toThrow(error);
  });

  it("uses an absolute bounded metadata-only command", () => {
    const rows = readPosixProcessTable((executable, args, options) => {
      expect(executable).toBe("/bin/ps");
      expect(args).toEqual(["-axo", "pid=,pgid=,stat="]);
      expect(options).toEqual({ encoding: "utf8", timeout: 2000, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] });
      return "12 12 Rs\n";
    });
    expect(rows).toEqual([{ pid: 12, pgid: 12, state: "Rs" }]);
  });
});
