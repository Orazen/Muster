import { execFileSync } from "node:child_process";

// Read metadata only: no command lines, environment or user paths. A zombie
// cannot execute or retain the fixture's open resources, but its PID can remain
// visible until its parent reaps it. Do not describe that as PID disappearance.
export function parsePosixProcessTable(output) {
  const lines = output.trim().split("\n");
  const seen = new Set();
  return lines.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z?][A-Za-z0-9+<>=-]*)\s*$/.exec(line);
    if (!match) throw new Error(`Owned process table is malformed: ${JSON.stringify(line)}`);
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid) || seen.has(pid)) {
      throw new Error("Owned process table contains invalid process IDs");
    }
    seen.add(pid);
    return { pid, pgid, state: match[3] };
  });
}

export function readPosixProcessTable(run = execFileSync) {
  return parsePosixProcessTable(run("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

export function observeOwnedPosixGroup(pid, readTable = readPosixProcessTable) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Expected an owned process group ID greater than one");
  const members = readTable().filter((row) => row.pgid === pid);
  // Darwin also emits '?' when Mach task state cannot be read. It must count
  // as potentially live; only an explicit zombie status permits exclusion.
  return { members, liveMembers: members.filter((row) => !row.state.startsWith("Z")) };
}
