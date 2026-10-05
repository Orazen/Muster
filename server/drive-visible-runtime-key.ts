// The runtime passes auth.deploymentSigningSecret() explicitly. Local installs
// already persist it outside auth.db; hosted replicas already require the same
// configured secret. This module never resolves, creates or persists custody.
import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { VisibleTokenProtector } from "./drive-visible-token-protection.ts";

const SALT = "muster:deployment-key-derivation:v1";
const PURPOSE = "muster:drive-visible:credential-protection:v1";
const UNAVAILABLE = "Visible runtime credential custody is unavailable";
const custodySchema = z.string().refine(value => value === value.trim()
  && Buffer.byteLength(value, "utf8") >= 32 && Buffer.byteLength(value, "utf8") <= 4096);

/** Derive a separate, restart-stable credential key. The fixed purpose and
 * version are part of the persisted-grant contract: changing either requires
 * an explicit key migration or reconnect. This is not the portable backup key;
 * a fresh device still needs the user's passphrase/recovery material to restore.
 */
export function createVisibleRuntimeProtector(deploymentSecret: string): VisibleTokenProtector {
  const custody = custodySchema.safeParse(deploymentSecret);
  if (!custody.success) {
    throw new Error(UNAVAILABLE);
  }
  const material = Buffer.from(custody.data, "utf8");
  let key: Buffer | undefined;
  try {
    key = Buffer.from(hkdfSync("sha256", material, SALT, PURPOSE, 32));
    // The protector takes its own copy; don't retain temporary derivation bytes.
    return new VisibleTokenProtector(key);
  } catch {
    throw new Error(UNAVAILABLE);
  } finally {
    material.fill(0);
    key?.fill(0);
  }
}
