// The device REGISTRY (plan R12 / P5) — the part of the account's device
// inventory that has a real identity and a revoke that works.
//
// What is under test, and why each one is here:
//   * the install-id boundary, because it is where the repo's no-fingerprinting
//     rule stops being a comment: a client that offers a MAC address, a canvas
//     hash or a user-agent string is REFUSED, and nothing is ever derived from
//     what it offered;
//   * account identity staying separate from device identity — one install in
//     two accounts is two devices, and the device id is not a function of
//     anything the caller supplied;
//   * the read path staying owner-scoped (the second fence, after the SQL
//     predicate) and not double-counting a registered device as its own
//     user-agent bucket;
//   * revoke actually killing sessions, and only that device's.
//
// The cross-tenant pin on the WIRE lives in devices-harness.test.ts, which
// presents no install id and therefore still exercises the user-agent
// fallback. The pure grouping rules live in devices.test.ts. This file covers
// what the two cannot: a registered device, and taking one away.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  deviceIdFor,
  devicesForUser,
  deriveDevices,
  DeviceRegistrationError,
  installIdWire,
  MAX_ACCOUNT_DEVICES,
  readInstallId,
  registerDevice,
  registeredDevicesForUser,
  revokeDevice,
  type DeviceRegistration,
  type SessionRow,
} from "./devices.ts";

const ALICE = "usr_alice";
const BOB = "usr_bob";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
} as const;

/** A real uuid-shaped install id, the way a client mints one: a fixed name
 * expanded to 32 hex characters, so a test can say `install("mac-1")` and
 * know the same string every run. */
const install = (name: string): string => {
  const hex = createHash("sha256").update(`muster-device-test:${name}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const INSTALL_MAC = install("mac-installation-1");
const INSTALL_IPHONE = install("iphone-installation");
const INSTALL_MAC_ALT = install("mac-installation-2");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("the device registry", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE "user" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "session" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "expiresAt" date NOT NULL,
        "token" TEXT NOT NULL UNIQUE,
        "createdAt" date NOT NULL,
        "updatedAt" date NOT NULL,
        "ipAddress" TEXT,
        "userAgent" TEXT,
        "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
      );
      INSERT INTO "user" ("id") VALUES ('${ALICE}'), ('${BOB}')`);
  });

  const close = (): void => {
    db.close();
  };

  /** One signed-in client: a session row plus, when asked, a registration. */
  const signIn = (
    sessionId: string,
    userId: string,
    userAgent: string | null,
    updatedAt: number,
    installId: string | null,
  ): void => {
    db.prepare(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userAgent", "userId")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, "2999-01-01T00:00:00.000Z", `tok_${sessionId}`, "2026-01-01T00:00:00.000Z", updatedAt, userAgent, userId);
    if (installId !== null) registerDevice(db, userId, installId, sessionId, userAgent, updatedAt);
  };

  const sessionIds = (): string[] =>
    db
      .prepare(`SELECT "id" FROM "session" ORDER BY "id"`)
      .all()
      .map((row) => z.object({ id: z.string() }).parse(row).id);

  describe("the install-id boundary", () => {
    it("accepts a bare uuid and refuses everything a fingerprint is made of", () => {
      expect(installIdWire.safeParse(INSTALL_MAC).success).toBe(true);
      for (const fingerprint of [
        "8c:85:90:1f:44:2a", // a MAC address
        "c2f4a9d1e7b3650fa8d4c1e2937b605c", // a canvas / audio hash
        "W3sicmF1ZMOh0l3nlSPu5Q==", // a base64 signal blob
        UA.mac, // a user-agent string
        "install-mac-1", // a guessable slug
        "",
        `${INSTALL_MAC}-extra`,
      ]) {
        expect({ value: fingerprint, accepted: installIdWire.safeParse(fingerprint).success }).toEqual({
          value: fingerprint,
          accepted: false,
        });
      }
    });

    it("reads a request header as absent when it is not a uuid, never as something to hash", () => {
      expect(readInstallId(undefined)).toBeNull();
      expect(readInstallId("8c:85:90:1f:44:2a")).toBeNull();
      expect(readInstallId(UA.mac)).toBeNull();
      expect(readInstallId(`  ${INSTALL_MAC}  `)).toBe(INSTALL_MAC);
      expect(readInstallId([INSTALL_MAC])).toBe(INSTALL_MAC);
      expect(readInstallId([UA.mac, INSTALL_MAC])).toBeNull();
    });

    it("refuses to register a fingerprint, and registers nothing on the way out", () => {
      expect(() => registerDevice(db, ALICE, "8c:85:90:1f:44:2a", "sess_1", UA.mac, 1_000)).toThrow();
      expect(registeredDevicesForUser(db, ALICE)).toEqual([]);
      expect(devicesForUser(db, ALICE)).toEqual([]);
    });

    it("leaves a client that never presented an install id in the user-agent bucket", () => {
      signIn("sess_1", ALICE, UA.mac, 5_000, null);
      const [device] = devicesForUser(db, ALICE);
      expect(device!.identity).toBe("userAgentGroup");
      expect(device!.installId).toBeUndefined();
      expect(device!.id).toBe(deviceIdFor(ALICE, UA.mac));
    });
  });

  describe("account identity, kept apart from device identity", () => {
    it("gives one install the same device id forever, across re-sign-ins", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const first = registerDevice(db, ALICE, INSTALL_MAC, "sess_1", UA.mac, 1_000);
      signIn("sess_2", ALICE, UA.mac, 9_000, INSTALL_MAC);
      const devices = registeredDevicesForUser(db, ALICE);
      expect(devices).toHaveLength(1);
      expect(devices[0]!.id).toBe(first.id);
      expect(devices[0]!.lastSeenAt).toBe(9_000);
      // re-sign-ins of one install stay ONE row, and it owns every session
      expect(devices[0]!.sessionIds).toEqual(["sess_1", "sess_2"]);
      close();
    });

    it("gives one install two unrelated devices when two accounts use it", () => {
      signIn("sess_alice", ALICE, UA.mac, 1_000, INSTALL_MAC);
      signIn("sess_bob", BOB, UA.mac, 1_000, INSTALL_MAC);
      const forAlice = registerDevice(db, ALICE, INSTALL_MAC, "sess_alice", UA.mac, 1_000);
      const forBob = registerDevice(db, BOB, INSTALL_MAC, "sess_bob", UA.mac, 1_000);
      expect(forBob.id).not.toBe(forAlice.id);
      // neither id is the install id, and neither leaks the other account's name
      expect(forAlice.id).toMatch(UUID);
      expect(forAlice.id).not.toContain(ALICE);
      expect(forBob.id).not.toContain(BOB);
      expect(registeredDevicesForUser(db, ALICE).map((device) => device.id)).toEqual([forAlice.id]);
      expect(registeredDevicesForUser(db, BOB).map((device) => device.id)).toEqual([forBob.id]);
      close();
    });

    it("mints an id rather than deriving one from what the caller sent", () => {
      // Two different installs presenting the same user-agent get different
      // ids: if the id were a hash of the agent, these would collide.
      const one = registerDevice(db, ALICE, INSTALL_MAC, "sess_1", UA.mac, 1_000);
      const two = registerDevice(db, ALICE, INSTALL_MAC_ALT, "sess_2", UA.mac, 1_000);
      expect(one.id).not.toBe(two.id);
      expect(one.id).not.toBe(one.installId);
      expect(one.id).not.toBe(one.installId.slice(0, 16));
    });

    it("keeps the label a request with no user-agent cannot improve on", () => {
      const named = registerDevice(db, ALICE, INSTALL_MAC, null, UA.mac, 1_000);
      expect(named.name).toBe("Chrome on macOS");
      // a later request from a client that reports no user-agent at all is
      // not new information, and must not downgrade the row to "Unknown client"
      const silent = registerDevice(db, ALICE, INSTALL_MAC, null, null, 2_000);
      expect(silent.id).toBe(named.id);
      expect(silent.name).toBe("Chrome on macOS");
      expect(silent.platform).toBe("macos");
      // but a client that starts reporting a different platform does get relabelled
      const moved = registerDevice(db, ALICE, INSTALL_MAC, null, UA.iphone, 3_000);
      expect(moved.id).toBe(named.id);
      expect(moved.name).toBe("Safari on iPhone");
      expect(moved.platform).toBe("ios");
      close();
    });

    it("drops a foreign device even if a bug hands one to the view", () => {
      signIn("sess_alice", ALICE, UA.mac, 1_000, INSTALL_MAC);
      signIn("sess_bob", BOB, UA.iphone, 2_000, INSTALL_IPHONE);
      const bobsDevices = registeredDevicesForUser(db, BOB);
      expect(bobsDevices).toHaveLength(1);

      // A bug upstream handing Alice Bob's device: the SQL predicate cannot
      // help here, so the second fence in deriveDevices has to.
      expect(deriveDevices(ALICE, [], bobsDevices)).toEqual([]);
      const mixed = [...registeredDevicesForUser(db, ALICE), ...bobsDevices];
      expect(deriveDevices(ALICE, [], mixed).map((device) => device.id)).toEqual(
        registeredDevicesForUser(db, ALICE).map((device) => device.id),
      );
      close();
    });
  });

  describe("reading the inventory", () => {
    it("shows a registered device once, as a device, not as a bucket holding itself", () => {
      signIn("sess_1", ALICE, UA.mac, 5_000, INSTALL_MAC);
      signIn("sess_2", ALICE, UA.mac, 7_000, INSTALL_MAC);
      const registered = registerDevice(db, ALICE, INSTALL_MAC, "sess_2", UA.mac, 7_000);
      const views = devicesForUser(db, ALICE);
      expect(views).toHaveLength(1);
      expect(views[0]!.id).toBe(registered.id);
      expect(views[0]!.identity).toBe("install");
      expect(views[0]!.installId).toBe(INSTALL_MAC);
      expect(views[0]!.name).toBe("Chrome on macOS");
      expect(views[0]!.platform).toBe("macos");
      expect(views[0]!.lastSeenAt).toBe(7_000);
      expect(views[0]!.keyEnvelopeStatus).toBe("none");
      close();
    });

    it("keeps a never-registered machine apart from the registered one with the same browser", () => {
      signIn("sess_registered", ALICE, UA.mac, 1_000, INSTALL_MAC);
      db.prepare(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userAgent", "userId")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess_stranger", "2999-01-01T00:00:00.000Z", "tok_stranger", "2026-01-01T00:00:00.000Z", 8_000, UA.mac, ALICE);
      const views = devicesForUser(db, ALICE);
      expect(views).toHaveLength(2);
      expect(views.map((device) => device.identity)).toEqual(["userAgentGroup", "install"]);
      expect(views[0]!.lastSeenAt).toBe(8_000);
      expect(views[1]!.lastSeenAt).toBe(1_000);
      close();
    });

    it("orders both kinds of row newest-first and hides another account's devices", () => {
      signIn("sess_iphone", BOB, UA.iphone, 4_000, INSTALL_IPHONE);
      signIn("sess_mac", ALICE, UA.mac, 6_000, INSTALL_MAC);
      db.prepare(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userAgent", "userId")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess_cli", "2999-01-01T00:00:00.000Z", "tok_cli", "2026-01-01T00:00:00.000Z", 5_000, "muster-cli", ALICE);

      const views = devicesForUser(db, ALICE);
      expect(views.map((device) => [device.platform, device.lastSeenAt])).toEqual([
        ["macos", 6_000],
        ["cli", 5_000],
      ]);
      const aliceIds = views.map((device) => device.id);
      for (const bobDevice of registeredDevicesForUser(db, BOB)) {
        expect(aliceIds).not.toContain(bobDevice.id);
      }
      close();
    });

    it("drops a device once its last session is gone, but keeps its id for next time", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const before = registerDevice(db, ALICE, INSTALL_MAC, "sess_2", UA.mac, 2_000);
      expect(registeredDevicesForUser(db, ALICE)).toHaveLength(1);
      db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).run(ALICE);
      expect(registeredDevicesForUser(db, ALICE)).toEqual([]);
      expect(devicesForUser(db, ALICE)).toEqual([]);
      signIn("sess_3", ALICE, UA.mac, 3_000, INSTALL_MAC);
      expect(registerDevice(db, ALICE, INSTALL_MAC, "sess_3", UA.mac, 3_000).id).toBe(before.id);
      close();
    });

    it("carries the newest sighting across the dates a session table actually stores", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      db.prepare(`UPDATE "session" SET "updatedAt" = ? WHERE "id" = ?`).run("2026-01-02T03:04:05.000Z", "sess_1");
      expect(registeredDevicesForUser(db, ALICE)[0]!.lastSeenAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
      close();
    });
  });

  describe("revoking a device", () => {
    it("ends that device's sessions and leaves every other device signed in", () => {
      signIn("sess_mac", ALICE, UA.mac, 1_000, INSTALL_MAC);
      signIn("sess_iphone", ALICE, UA.iphone, 2_000, INSTALL_IPHONE);
      const mac = registerDevice(db, ALICE, INSTALL_MAC, "sess_mac", UA.mac, 1_000);

      const result = revokeDevice(db, ALICE, mac.id, "sess_iphone");
      expect(result).toEqual({ deviceId: mac.id, sessionsRevoked: 1, revokedCurrentSession: false });
      expect(sessionIds()).toEqual(["sess_iphone"]);
      expect(devicesForUser(db, ALICE).map((device) => device.platform)).toEqual(["ios"]);
      close();
    });

    it("says so when the revoke signs the caller out of the session it is holding", () => {
      signIn("sess_mac", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const mac = registerDevice(db, ALICE, INSTALL_MAC, "sess_mac", UA.mac, 1_000);
      expect(revokeDevice(db, ALICE, mac.id, "sess_mac")?.revokedCurrentSession).toBe(true);
      expect(sessionIds()).toEqual([]);
      close();
    });

    it("never touches an unregistered machine that happens to share the browser", () => {
      signIn("sess_registered", ALICE, UA.mac, 1_000, INSTALL_MAC);
      db.prepare(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userAgent", "userId")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess_stranger", "2999-01-01T00:00:00.000Z", "tok_stranger", "2026-01-01T00:00:00.000Z", 2_000, UA.mac, ALICE);
      const mac = registerDevice(db, ALICE, INSTALL_MAC, "sess_registered", UA.mac, 1_000);

      // The two rows above are indistinguishable to the old grouping key, so
      // the bucket id must not be revokable — only the device is.
      revokeDevice(db, ALICE, mac.id, null);
      expect(sessionIds()).toEqual(["sess_stranger"]);
      expect(revokeDevice(db, ALICE, deviceIdFor(ALICE, UA.mac), null)).toBeNull();
      expect(sessionIds()).toEqual(["sess_stranger"]);
      close();
    });

    it("is owner-scoped: another account's device id revokes nothing and leaks nothing", () => {
      signIn("sess_alice", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const alicesDevice = registerDevice(db, ALICE, INSTALL_MAC, "sess_alice", UA.mac, 1_000);
      signIn("sess_bob", BOB, UA.mac, 2_000, INSTALL_MAC);
      const bobsDevice = registerDevice(db, BOB, INSTALL_MAC, "sess_bob", UA.mac, 2_000);
      expect(bobsDevice.id).not.toBe(alicesDevice.id);

      expect(revokeDevice(db, BOB, alicesDevice.id, null)).toBeNull();
      expect(sessionIds()).toEqual(["sess_alice", "sess_bob"]);
      expect(revokeDevice(db, BOB, "not-a-device-id", null)).toBeNull();
      expect(sessionIds()).toEqual(["sess_alice", "sess_bob"]);

      expect(revokeDevice(db, BOB, bobsDevice.id, "sess_bob")?.sessionsRevoked).toBe(1);
      expect(sessionIds()).toEqual(["sess_alice"]);
      close();
    });

    it("gives a revoked install a NEW device id when it comes back", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const first = registerDevice(db, ALICE, INSTALL_MAC, "sess_1", UA.mac, 1_000);
      revokeDevice(db, ALICE, first.id, null);
      signIn("sess_2", ALICE, UA.mac, 2_000, INSTALL_MAC);
      const second = registerDevice(db, ALICE, INSTALL_MAC, "sess_2", UA.mac, 2_000);
      expect(second.id).not.toBe(first.id);
      close();
    });

    it("moves a session to a new install without erasing the device it left", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      signIn("sess_1b", ALICE, UA.mac, 2_000, INSTALL_MAC);
      const mac = registerDevice(db, ALICE, INSTALL_MAC, "sess_1b", UA.mac, 2_000);
      signIn("sess_2", ALICE, UA.mac, 3_000, INSTALL_MAC_ALT);
      const alt = registerDevice(db, ALICE, INSTALL_MAC_ALT, "sess_2", UA.mac, 3_000);

      // The same session now presents a different install id (cleared storage,
      // a reinstall). It belongs to the new device — and the device it left
      // keeps the session it still owns instead of being deleted by a guess.
      registerDevice(db, ALICE, INSTALL_MAC_ALT, "sess_1", UA.mac, 4_000);
      const owned = registeredDevicesForUser(db, ALICE)
        .map((device) => [device.id, device.sessionIds])
        .sort();
      expect(owned).toEqual(
        [
          [mac.id, ["sess_1b"]],
          [alt.id, ["sess_1", "sess_2"]],
        ].sort(),
      );
      close();
    });

    it("refuses a caller who has never signed in on this account", () => {
      signIn("sess_alice", ALICE, UA.mac, 1_000, INSTALL_MAC);
      const alicesDevice = registerDevice(db, ALICE, INSTALL_MAC, "sess_alice", UA.mac, 1_000);
      expect(revokeDevice(db, BOB, alicesDevice.id, "sess_bob")).toBeNull();
      expect(registeredDevicesForUser(db, ALICE)).toHaveLength(1);
      close();
    });
  });

  describe("bounds", () => {
    it("stops an account registering past the cap, and lets it register again after a revoke", () => {
      for (let index = 0; index < MAX_ACCOUNT_DEVICES; index += 1) {
        signIn(`sess_${index}`, ALICE, UA.mac, 1_000, install(`flood-${index}-uuid`));
      }
      expect(registeredDevicesForUser(db, ALICE)).toHaveLength(MAX_ACCOUNT_DEVICES);
      let refused: DeviceRegistrationError | null = null;
      try {
        registerDevice(db, ALICE, install("one-too-many"), "sess_extra", UA.mac, 1_000);
      } catch (error) {
        refused = error instanceof DeviceRegistrationError ? error : null;
      }
      expect(refused?.status).toBe(409);
      expect(registeredDevicesForUser(db, ALICE)).toHaveLength(MAX_ACCOUNT_DEVICES);

      const first = registeredDevicesForUser(db, ALICE)[0]!;
      revokeDevice(db, ALICE, first.id, null);
      const admitted: DeviceRegistration | null = registerDevice(
        db,
        ALICE,
        install("one-too-many"),
        "sess_extra",
        UA.mac,
        1_000,
      );
      expect(admitted).not.toBeNull();
      close();
    });

    it("keeps the cap per account, not global", () => {
      for (let index = 0; index < MAX_ACCOUNT_DEVICES; index += 1) {
        signIn(`sess_${index}`, ALICE, UA.mac, 1_000, install(`flood-${index}-uuid`));
      }
      expect(registerDevice(db, BOB, INSTALL_MAC, "sess_bob", UA.mac, 1_000).id).toMatch(UUID);
      close();
    });
  });

  describe("account deletion", () => {
    it("takes a deleted account's devices and their bindings with it", () => {
      signIn("sess_1", ALICE, UA.mac, 1_000, INSTALL_MAC);
      db.prepare(`DELETE FROM "user" WHERE "id" = ?`).run(ALICE);
      expect(registeredDevicesForUser(db, ALICE)).toEqual([]);
      const left = db.prepare(`SELECT COUNT(*) AS "n" FROM "account_device_session"`).get();
      expect(left).toEqual({ n: 0 });
      close();
    });
  });

  describe("what a session row without an id means", () => {
    it("still groups by user-agent, because nothing bound it to a device", () => {
      const rows: SessionRow[] = [
        { userId: ALICE, userAgent: UA.mac, updatedAt: 1_000 },
        { userId: ALICE, userAgent: UA.mac, updatedAt: 3_000 },
      ];
      expect(deriveDevices(ALICE, rows)).toEqual([
        {
          id: deviceIdFor(ALICE, UA.mac),
          name: "Chrome on macOS",
          platform: "macos",
          lastSeenAt: 3_000,
          keyEnvelopeStatus: "none",
          identity: "userAgentGroup",
        },
      ]);
      expect(deriveDevices(ALICE, rows, [])).toEqual(deriveDevices(ALICE, rows));
    });
  });
});
