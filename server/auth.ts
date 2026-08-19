import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true });
    _db = new DatabaseSync(join(DATA_DIR, "auth.db"));
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
  }
  return _db;
}

export const auth = betterAuth({
  database: getDb(),
  emailAndPassword: {
    enabled: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: [
    "http://127.0.0.1:5199",
    "http://localhost:5199",
    "http://127.0.0.1:8799",
    "http://localhost:8799",
  ],
});

/** Convert a Node.js IncomingMessage to a Web Request for Better Auth. */
export function toWebRequest(req: import("node:http").IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
  });
}
