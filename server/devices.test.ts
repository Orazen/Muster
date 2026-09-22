// S0 device inventory — the pure view over session rows. The grouping,
// platform, label and date-coercion rules ARE the unit under test here; the
// HTTP route and its cross-tenant pin live in server/devices-harness.test.ts.
//
// No new table: a session row IS a signed-in device instance (web sign-in,
// claim-paired phone and CLI pair all create sessions), and grouping by
// user-agent collapses re-sign-ins of one machine into one device. There is
// no hardware fingerprint — UA grouping is the honest line, and the receipts
// say so.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  deriveDevices,
  deviceIdFor,
  devicesForUser,
  nameOf,
  platformOf,
  sqliteDateWire,
  type DeviceView,
  type SessionRow,
} from "./devices.ts";

const USER = "usr_owned_devices";
const OTHER = "usr_someone_else";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  watch: "Mozilla/5.0 (iPhone; CPU watchOS 10_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  cli: "muster-cli",
} as const;

const row = (userAgent: string | null, updatedAt: number, userId = USER): SessionRow => ({
  userId,
  userAgent,
  updatedAt,
});

describe("platformOf", () => {
  it("reads the platform from the user-agent, watch checked before iPhone", () => {
    expect(platformOf(UA.watch)).toBe("watchos");
    expect(platformOf(UA.iphone)).toBe("ios");
    expect(platformOf(UA.ipad)).toBe("ios");
    expect(platformOf(UA.macChrome)).toBe("macos");
    expect(platformOf(UA.windowsEdge)).toBe("windows");
    expect(platformOf(UA.android)).toBe("android");
    expect(platformOf(UA.linux)).toBe("linux");
    expect(platformOf(UA.cli)).toBe("cli");
  });

  it("calls an absent or unrecognised agent the web, not a guess", () => {
    expect(platformOf(null)).toBe("web");
    expect(platformOf("")).toBe("web");
    expect(platformOf("curl/8.7.1")).toBe("web");
  });
});

describe("nameOf", () => {
  it("labels a device the way a human would say it", () => {
    expect(nameOf(UA.iphone)).toBe("Safari on iPhone");
    expect(nameOf(UA.ipad)).toBe("Safari on iPad");
    expect(nameOf(UA.macChrome)).toBe("Chrome on macOS");
    expect(nameOf(UA.macFirefox)).toBe("Firefox on macOS");
    expect(nameOf(UA.windowsEdge)).toBe("Edge on Windows");
    expect(nameOf(UA.android)).toBe("Chrome on Android");
    expect(nameOf(UA.linux)).toBe("Firefox on Linux");
    expect(nameOf(UA.cli)).toBe("Muster CLI");
    expect(nameOf(UA.watch)).toBe("Apple Watch");
    expect(nameOf(null)).toBe("Unknown client");
  });
});

describe("sqliteDateWire", () => {
  it("parses every shape a sqlite date column can hand back at the boundary", () => {
    expect(sqliteDateWire.parse(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(sqliteDateWire.parse(1_760_000_000_000n)).toBe(1_760_000_000_000);
    expect(sqliteDateWire.parse("2026-01-02T03:04:05.000Z")).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(sqliteDateWire.parse("not a date")).toBe(0);
    expect(sqliteDateWire.parse(null)).toBe(0);
    expect(sqliteDateWire.parse(undefined)).toBe(0);
    expect(sqliteDateWire.parse(Number.NaN)).toBe(0);
  });
});

describe("deriveDevices", () => {
  it("groups one machine's sessions into one device with the newest sighting", () => {
    const devices = deriveDevices(USER, [
      row(UA.macChrome, 1_000),
      row(UA.macChrome, 5_000),
      row(UA.macChrome, 3_000),
    ]);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.lastSeenAt).toBe(5_000);
    expect(devices[0]!.platform).toBe("macos");
    expect(devices[0]!.keyEnvelopeStatus).toBe("none");
  });

  it("keeps distinct machines distinct and sorts newest-first", () => {
    const devices = deriveDevices(USER, [row(UA.iphone, 100), row(UA.macChrome, 200), row(UA.cli, 300)]);
    expect(devices.map((device) => device.platform)).toEqual(["cli", "macos", "ios"]);
    expect(devices.map((device) => device.lastSeenAt)).toEqual([300, 200, 100]);
  });

  it("treats a null and an empty user-agent as the same unknown device", () => {
    const devices = deriveDevices(USER, [row(null, 100), row("", 50)]);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.lastSeenAt).toBe(100);
    expect(devices[0]!.name).toBe("Unknown client");
  });

  it("excludes another user's rows even if they arrive (predicate, not luck)", () => {
    const devices = deriveDevices(USER, [
      row(UA.macChrome, 100),
      row(UA.android, 900, OTHER),
      row(null, 800, OTHER),
    ]);
    expect(devices).toHaveLength(1);
    const ids = devices.map((device) => device.id);
    expect(ids).toEqual([deviceIdFor(USER, UA.macChrome)]);
    expect(ids).not.toContain(deviceIdFor(OTHER, UA.android));
  });

  it("stamps ids per user and agent so two people's identical browsers never collide", () => {
    expect(deviceIdFor(USER, UA.iphone)).toBe(deviceIdFor(USER, UA.iphone));
    expect(deviceIdFor(USER, UA.iphone)).not.toBe(deviceIdFor(OTHER, UA.iphone));
    expect(deviceIdFor(USER, UA.iphone)).not.toBe(deviceIdFor(USER, UA.macChrome));
  });

  it("returns an empty list for an empty account", () => {
    expect(deriveDevices(USER, [])).toEqual([]);
  });
});

describe("devicesForUser", () => {
  const read = (inserts: Array<[string, string | null, string | number]>, userId = USER): DeviceView[] => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE "session" (
        "id" text not null primary key,
        "expiresAt" date not null,
        "token" text not null unique,
        "createdAt" date not null,
        "updatedAt" date not null,
        "ipAddress" text,
        "userAgent" text,
        "userId" text not null
      )`);
      inserts.forEach(([owner, agent, updatedAt], index) => {
        db.prepare(`INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userAgent", "userId") VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(`sess_${index}`, "2999-01-01T00:00:00.000Z", `tok_${index}`, "2026-01-01T00:00:00.000Z", updatedAt, agent, owner);
      });
      return devicesForUser(db, userId);
    } finally {
      db.close();
    }
  };

  it("reads only the caller's sessions and coerces the stored date", () => {
    const seen = Date.now() - 60_000;
    const devices = read([
      [USER, UA.macChrome, seen],
      [USER, UA.iphone, "2026-01-02T03:04:05.000Z"],
      [OTHER, UA.android, Date.now()],
    ]);
    expect(devices).toHaveLength(2);
    expect(devices.map((device) => device.id)).toEqual(
      expect.arrayContaining([deviceIdFor(USER, UA.macChrome), deviceIdFor(USER, UA.iphone)]),
    );
    expect(devices.map((device) => device.id)).not.toContain(deviceIdFor(OTHER, UA.android));
    expect(devices[0]!.lastSeenAt).toBe(seen); // newest-first puts the number-dated row first
    expect(devices[1]!.lastSeenAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
  });

  it("answers empty for an account with no sessions", () => {
    expect(read([])).toEqual([]);
  });
});
