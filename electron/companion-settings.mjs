// The companion's remembered state, on disk.
//
// Two facts live here: whether the user wants the companion on, and whether
// they want this computer kept awake while it is. Both are preferences about
// the next launch as much as this one — a paired phone that stops working
// because the app was restarted, or because the lid closed, reads as a broken
// feature rather than as a setting nobody turned on.
//
// This module deliberately imports no Electron, so it can be tested without a
// running app. The caller supplies the path and the filesystem.
import fs from "node:fs";
import path from "node:path";

/** The off position, and the answer to every question we cannot answer. */
export const DEFAULT_COMPANION_SETTINGS = Object.freeze({ enabled: false, keepAwake: false });

const strictBoolean = (value) => (value === true ? true : value === false ? false : null);

/**
 * Parse a settings file's contents.
 *
 * Fail closed, absolutely. Anything that is not a plain object whose two
 * fields are both real booleans resolves to the off position. A truncated
 * write, a hand-edited file, a value of "yes" or 1 — none of these may be read
 * as permission to open a port on this machine, which is what `enabled: true`
 * means. Reading a corrupt file as "off" costs the user one press of a toggle;
 * reading it as "on" would expose their bots to the network on a decision they
 * never made.
 */
export function parseCompanionSettings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...DEFAULT_COMPANION_SETTINGS };
  }
  if (parsed === null || !(parsed instanceof Object) || Array.isArray(parsed)) {
    return { ...DEFAULT_COMPANION_SETTINGS };
  }
  const enabled = strictBoolean(parsed.enabled);
  const keepAwake = strictBoolean(parsed.keepAwake);
  // Both fields are required. A file carrying only one of them is a shape this
  // version did not write, and guessing the other is exactly the kind of
  // invention the fail-closed rule exists to prevent.
  if (enabled === null || keepAwake === null) return { ...DEFAULT_COMPANION_SETTINGS };
  return { enabled, keepAwake };
}

/** Read the settings, treating every failure — absent, unreadable, corrupt — as off. */
export function readCompanionSettings(file, fileSystem = fs) {
  try {
    return parseCompanionSettings(fileSystem.readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULT_COMPANION_SETTINGS };
  }
}

/**
 * Write the settings atomically.
 *
 * A half-written file is the one failure this feature cannot afford: the
 * reader on the next launch cannot tell a truncated document from a complete
 * one, and the fail-closed rule above would then silently drop a preference
 * the user set. Writing to a sibling temporary file and renaming over the
 * target means a reader sees the old file or the new one, never a fragment.
 *
 * Returns whether the write landed. The caller keeps going either way: failing
 * to remember a setting must not fail the action that setting describes.
 */
export function writeCompanionSettings(file, settings, fileSystem = fs) {
  const payload = JSON.stringify({
    enabled: settings.enabled === true,
    keepAwake: settings.keepAwake === true,
  });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fileSystem.mkdirSync(path.dirname(file), { recursive: true });
    // 0600: this file records that a network port is open on this machine, and
    // on a shared Mac the mode is what keeps it from being a hint to others.
    fileSystem.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    fileSystem.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fileSystem.rmSync(temporary, { force: true });
    } catch {
      /* the rename never ran, so there may be nothing to remove */
    }
    return false;
  }
}