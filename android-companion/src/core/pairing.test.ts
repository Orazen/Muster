import { MusterClient, parseAddress, parsePairingURL, type ClientFetch } from "./client";
import { pairingFillFromExternalText, resolvePairingInput, type PairingInput } from "./pairing";
import type { ClientRequest } from "./transport";

const token = `omb_pair_${"a".repeat(43)}`;
const otherToken = `omb_pair_${"b".repeat(43)}`;
function invite(address = "macbook.tail1234.ts.net:8810") {
  const query = new URLSearchParams({ address, token, code: "004209", name: "Alex's Mac | Work" });
  return `muster://pair?${query}`;
}

describe("pairing input normalization", () => {
  test("accepts the desktop producer's encoded token/code/name contract and prioritizes its token", () => {
    const address = invite();
    expect(resolvePairingInput({ address, code: "999999" })).toEqual({ ok: true, method: "invite", value: { address: "http://macbook.tail1234.ts.net:8810", credential: token } });
    expect(parsePairingURL(address)).toEqual({ address: "http://macbook.tail1234.ts.net:8810", token });
  });

  test.each([
    ["localhost", "http://localhost:8810"],
    ["192.168.1.20:9123", "http://192.168.1.20:9123"],
    ["https://pair.fixture.invalid", "https://pair.fixture.invalid:443"],
    ["HTTP://pair.fixture.invalid/", "http://pair.fixture.invalid:8810"],
    ["[2001:db8::1]:8810", "http://[2001:db8::1]:8810"],
    ["https://[::1]:9443", "https://[::1]:9443"],
  ])("normalizes manual %s and preserves leading code zeros", (address, normalized) => {
    expect(resolvePairingInput({ address, code: "004209" })).toEqual({ ok: true, method: "manual", value: { address: normalized, code: "004209" } });
  });

  test("allows surrounding clipboard whitespace but not whitespace inside an address or token", () => {
    expect(resolvePairingInput({ address: ` \n${invite()}\n ` }).ok).toBe(true);
    expect(resolvePairingInput({ address: "  localhost  ", code: "000001" }).ok).toBe(true);
    expect(resolvePairingInput({ address: invite(" localhost:8810") }).ok).toBe(false);
    expect(resolvePairingInput({ address: "local host", code: "000001" }).ok).toBe(false);
    expect(resolvePairingInput({ address: "localhost", credential: token + " " }).ok).toBe(false);
  });

  test("retains the legacy raw-pipe separator without reinterpreting encoded pipes", () => {
    const legacy = `muster://pair?address=localhost%3A8810&token=${token}|code=004209&name=Alex%7CWork`;
    expect(resolvePairingInput({ address: legacy })).toEqual({ ok: true, method: "invite", value: { address: "http://localhost:8810", credential: token } });
    expect(resolvePairingInput({ address: invite("host%7Cother:8810") }).ok).toBe(false);
  });

  test("accepts an explicit code-only legacy invitation without manufacturing a token", () => {
    const address = "muster://pair?address=%5B%3A%3A1%5D%3A8810&code=004209";
    expect(resolvePairingInput({ address, code: "777777" })).toEqual({ ok: true, method: "invite", value: { address: "http://[::1]:8810", code: "004209" } });
    expect(parsePairingURL(address)).toBeNull();
  });

  test("normalizes an explicit HTTPS invitation before transport", () => {
    expect(resolvePairingInput({ address: invite("https://[2001:db8::1]:9443") })).toEqual({ ok: true, method: "invite", value: { address: "https://[2001:db8::1]:9443", credential: token } });
  });

  test("preserves a legitimate explicit credential and rejects a conflicting invitation credential", () => {
    expect(resolvePairingInput({ address: "localhost", credential: token, code: "004209" })).toEqual({ ok: true, method: "manual", value: { address: "http://localhost:8810", credential: token } });
    expect(resolvePairingInput({ address: invite(), credential: token }).ok).toBe(true);
    expect(resolvePairingInput({ address: invite(), credential: otherToken }).ok).toBe(false);
  });

  test.each(["", "omb_pair_", `omb_pair_${"a".repeat(42)}`, `omb_pair_${"a".repeat(44)}`, `omb_${"a".repeat(43)}`, `${token} `, token.slice(0, -1) + "+", token.slice(0, -1) + "/"])("refuses malformed token %# even with valid embedded and manual codes", (invalidToken) => {
    const query = new URLSearchParams({ address: "localhost:8810", token: invalidToken, code: "004209" });
    const address = `muster://pair?${query}`;
    expect(resolvePairingInput({ address, code: "004209" }).ok).toBe(false);
    expect(parsePairingURL(address)).toBeNull();
    expect(resolvePairingInput({ address: "localhost", credential: invalidToken, code: "004209" }).ok).toBe(false);
  });

  test.each(["", "12345", "1234567", "12345a", "１２３４５６", " 004209", "004209\n"])("rejects a malformed manual or embedded code %#", (code) => {
    expect(resolvePairingInput({ address: "localhost", code }).ok).toBe(false);
    const query = new URLSearchParams({ address: "localhost", token, code });
    expect(resolvePairingInput({ address: `muster://pair?${query}` }).ok).toBe(false);
  });

  test.each([
    "address=other.invalid:8810", "address=macbook.tail1234.ts.net:8810", "%61ddress=other.invalid:8810",
    `token=${token}`, `token=${otherToken}`, "code=004209", "code=999999", "name=duplicate",
  ])("rejects duplicate decoded invitation field %s", (extra) => {
    expect(resolvePairingInput({ address: `${invite()}&${extra}`, code: "004209" }).ok).toBe(false);
  });

  test.each([
    "ftp://fixture.invalid", "muster://fixture.invalid", "https://user:pass@fixture.invalid", "https://fixture.invalid/path",
    "https://fixture.invalid?token=anything", "https://fixture.invalid#fragment", "https://fixture.invalid//",
    "fixture.invalid:0", "fixture.invalid:65536", "fixture.invalid:1.5", "fixture.invalid:-1", "fixture.invalid:",
    "[::1]garbage:8810", "2001:db8::1", "fixture%2einvalid", "https:\\fixture.invalid",
  ])("rejects invalid manual and embedded addresses %s", (address) => {
    expect(resolvePairingInput({ address, code: "004209" }).ok).toBe(false);
    expect(resolvePairingInput({ address: invite(address), code: "004209" }).ok).toBe(false);
  });

  test.each([
    `https://pair?address=localhost&token=${token}`,
    `muster://other?address=localhost&token=${token}`,
    `muster://user@pair?address=localhost&token=${token}`,
    `muster://@pair?address=localhost&token=${token}`,
    `muster://:@pair?address=localhost&token=${token}`,
    `muster://pair:?address=localhost&token=${token}`,
    `muster://pair:8810?address=localhost&token=${token}`,
    `muster://pair/?address=localhost&token=${token}`,
    `muster://pair/path?address=localhost&token=${token}`,
    `${invite()}#`, `${invite()}#fragment`, `${invite()}&unknown=value`, `${invite()}&name2=%ZZ`, `${invite()}&`,
    `muster://pair?address=localhost&token=${token}&name=%C3%28`,
    `muster://pair?address=localhost&token=${token}\n&code=004209`,
    `muster://pair?address=localhost&token=${token}%7Ccode%3D004209`,
    "muster://pair?address=localhost", `muster://pair?token=${token}`, "muster:pair?code=004209",
  ])("never treats malformed invitation %# as a manual host/code request", (address) => {
    expect(resolvePairingInput({ address, code: "004209" }).ok).toBe(false);
    expect(parsePairingURL(address)).toBeNull();
  });
});

describe("normalized pairing transport contract", () => {
  function transport() {
    const calls: Array<{ url: string; request?: ClientRequest }> = [];
    const fetchRequest: ClientFetch = async (url, request) => {
      calls.push({ url, request });
      return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, body: null, json: async () => ({ token: "owned-device-token", device: { id: "owned-device", name: "Test phone" } }) };
    };
    return { calls, fetchRequest };
  }
  async function submit(input: PairingInput, fetchRequest: ClientFetch) {
    const result = resolvePairingInput(input);
    if (!result.ok) throw new Error(result.error);
    const { host, port, scheme } = parseAddress(result.value.address);
    return MusterClient.pair(host, port, { credential: result.value.credential, code: result.value.code, scheme, deviceName: "Test phone" }, fetchRequest);
  }
  test("maps an invitation token to credential and preserves its HTTPS endpoint", async () => {
    const f = transport();
    await submit({ address: invite("https://[::1]:9443"), code: "111111" }, f.fetchRequest);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://[::1]:9443/api/pair");
    expect(JSON.parse(f.calls[0].request?.body ?? "")).toEqual({ credential: token, deviceName: "Test phone" });
    expect(f.calls[0].request?.headers).not.toHaveProperty("Authorization");
  });
  test("sends an exact leading-zero code for manual and explicit legacy-code input", async () => {
    const f = transport();
    await submit({ address: "localhost", code: "004209" }, f.fetchRequest);
    await submit({ address: "muster://pair?address=localhost%3A8810&code=004209" }, f.fetchRequest);
    for (const call of f.calls) {
      expect(call.url).toBe("http://localhost:8810/api/pair");
      expect(JSON.parse(call.request?.body ?? "")).toEqual({ code: "004209", deviceName: "Test phone" });
    }
    expect(f.calls).toHaveLength(2);
  });
  test("rejects a supplied invalid invitation token before calling transport", async () => {
    const f = transport();
    await expect(submit({ address: "muster://pair?address=localhost&token=&code=004209", code: "004209" }, f.fetchRequest)).rejects.toThrow("complete Muster pairing invitation");
    expect(f.calls).toEqual([]);
  });
});

describe("external pairing fills (deep link and QR)", () => {
  test("fills a valid invitation as plain field text that re-parses exactly like a paste", () => {
    const link = invite();
    const fill = pairingFillFromExternalText(link);
    expect(fill).toEqual({ ok: true, address: link });
    // The fill is not a shortcut: what it puts in the field goes through the
    // same normalization a hand-typed paste would, or nothing would ever send.
    if (fill.ok) {
      expect(resolvePairingInput({ address: fill.address })).toEqual(
        resolvePairingInput({ address: link }),
      );
      expect(Object.keys(fill)).toEqual(["ok", "address"]);
    }
  });

  test("fills an explicit code-only invitation and trims QR payload whitespace", () => {
    const codeOnly = "muster://pair?address=%5B%3A%3A1%5D%3A8810&code=004209";
    expect(pairingFillFromExternalText(` \n${codeOnly}\n`)).toEqual({ ok: true, address: codeOnly });
  });

  test.each([
    ["a web address", "https://fixture.invalid/pair?token=anything"],
    ["an unrelated scheme", `muster://other?address=localhost&token=${token}`],
    ["a fragment-suffixed invitation", `${invite()}#fragment`],
    ["a malformed token", "muster://pair?address=localhost&token=omb_pair_bad&code=004209"],
    ["a plain host with no invitation", "localhost:8810"],
    ["nothing at all", "   "],
  ])("refuses %s instead of filling a guess", (_label, text) => {
    expect(pairingFillFromExternalText(text)).toEqual({
      ok: false,
      error: "That code is not a Muster pairing invitation.",
    });
  });
});
