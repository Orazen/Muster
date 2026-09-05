#!/usr/bin/env node
// Rotate the TestSprite API key in ~/.testsprite/credentials.json (write-only
// store; the CLI reads it from there when TESTSPRITE_API_KEY is unset).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const key = process.argv[2];
if (!key || !key.startsWith("sk-user-")) {
  console.error("usage: node scripts/testsprite-key.mjs sk-user-…");
  process.exit(1);
}
const dir = join(homedir(), ".testsprite");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiKey: key }), { mode: 0o600 });
console.log("TestSprite key updated in ~/.testsprite/credentials.json");
