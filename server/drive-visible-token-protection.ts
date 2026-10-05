// Visible Drive credentials need an explicitly supplied custody key before
// they may reach SQLite. The key never lives in this module's database and
// there is no environment lookup or plaintext compatibility fallback.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(1024);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const expiresAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant"), userId: id, googleSub: id, generation, expiresAt,
    scopes: z.array(z.string().min(1).max(2048)).min(1).max(100),
    field: z.enum(["accessToken", "refreshToken"]),
  }),
  z.object({
    kind: z.literal("consent"), userId: id, sessionId: id, generation, expiresAt,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), field: z.literal("codeVerifier"),
  }),
]);
export type VisibleCredentialBinding = z.infer<typeof bindingSchema>;
const PREFIX = "muster-visible-v1";
const MAX_VALUE_BYTES = 32768;
const plaintextSchema = z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES);
const protectedValueSchema = z.string().max(45000);

function aad(binding: VisibleCredentialBinding): Buffer {
  const value = bindingSchema.parse(binding);
  return Buffer.from(JSON.stringify(value.kind === "grant"
    ? [PREFIX, value.kind, value.userId, value.googleSub, value.generation,
      value.expiresAt, value.scopes, value.field]
    : [PREFIX, value.kind, value.userId, value.sessionId, value.generation,
      value.expiresAt, value.nonce, value.field]), "utf8");
}

function decode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

/** A distinct 32-byte key is injected by the eventual runtime owner. Losing
 * it requires reconnect; a missing key never enables unprotected storage. */
export class VisibleTokenProtector {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error("Visible credential protection requires a 32-byte key");
    }
    this.key = Buffer.from(key);
  }

  seal(value: string, binding: VisibleCredentialBinding): string {
    if (!plaintextSchema.safeParse(value).success) {
      throw new Error("Invalid visible credential");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
    cipher.setAAD(aad(binding));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [PREFIX, iv.toString("base64url"), bytes.toString("base64url"),
      cipher.getAuthTag().toString("base64url")].join(":");
  }

  open(value: string, binding: VisibleCredentialBinding): string | null {
    try {
      if (!protectedValueSchema.safeParse(value).success) return null;
      const parts = value.split(":");
      if (parts.length !== 4 || parts[0] !== PREFIX) return null;
      const iv = decode(parts[1]!);
      const data = decode(parts[2]!);
      const tag = decode(parts[3]!);
      if (!iv || iv.length !== 12 || !data || data.length > MAX_VALUE_BYTES
        || !tag || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: 16 });
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch { return null; }
  }
}

export function requireVisibleTokenProtector(protector: VisibleTokenProtector): void {
  if (!(protector instanceof VisibleTokenProtector)) {
    throw new Error("Visible credential protection is unavailable");
  }
}
