// Capture the same data-root value before any stateful server imports.
import { homedir } from "node:os";
import { join } from "node:path";

export const configuredDataDir = process.env.OMB_DATA_DIR;
if (configuredDataDir !== undefined && configuredDataDir.trim() === "") {
  throw new Error("OMB_DATA_DIR must be a nonempty directory path when set");
}
export const DATA_DIR = configuredDataDir ?? join(homedir(), ".muster");
