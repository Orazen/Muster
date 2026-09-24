import { describe, expect, it } from "vitest";
import {
  forgetRemoteConnection,
  loadRemoteConnections,
  normalizeRemoteServerInput,
  REMOTE_CONNECTIONS_LIMIT,
  rememberRemoteConnection,
} from "./remote-client";

const memoryStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

describe("normalizeRemoteServerInput", () => {
  it("accepts a full server pairing link and keeps its carried code", () => {
    expect(normalizeRemoteServerInput("https://m.example.com:8799/claim#4KJ2XQ9P")).toEqual({
      url: "https://m.example.com:8799/claim#4KJ2XQ9P",
      host: "m.example.com",
      displayHost: "m.example.com:8799",
      carriedCode: "4KJ2XQ9P",
    });
  });

  it("accepts the keyed fragment shape", () => {
    const target = normalizeRemoteServerInput("https://m.example.com/pair#code=abcd-ef12");
    expect(target?.carriedCode).toBe("ABCD-EF12");
    expect(target?.url).toBe("https://m.example.com/pair#code=abcd-ef12");
  });

  it("upgrades a scheme-less host to https and keeps an explicit port", () => {
    const target = normalizeRemoteServerInput(" m.example.com:8799 ");
    expect(target?.url).toBe("https://m.example.com:8799/");
    expect(target?.displayHost).toBe("m.example.com:8799");
    expect(target?.carriedCode).toBeNull();
  });

  it("keeps a path for servers behind a reverse proxy", () => {
    const target = normalizeRemoteServerInput("https://muster.corp.example.com/muster/");
    expect(target?.url).toBe("https://muster.corp.example.com/muster/");
  });

  it.each([
    "http://192.168.1.20:8799",
    "http://10.0.0.5",
    "http://localhost:8799",
    "http://mac.local:8799",
    "http://172.16.4.9",
    "http://172.31.255.1",
    "http://127.0.0.1:8799",
    "http://169.254.3.7",
  ])("allows plain http only for loopback and LAN hosts (%j)", (input) => {
    expect(normalizeRemoteServerInput(input)?.url).toBe(input.endsWith("/") || input.includes("/claim") ? input : `${input}/`);
  });

  it("refuses plain http to a public host", () => {
    expect(normalizeRemoteServerInput("http://muster.example.com")).toBeNull();
  });

  it.each([
    "http://user:pass@m.example.com",
    "http://user@m.example.com",
    "https://m.example.com/claim#bad code!",
    `https://m.example.com/claim#${"x".repeat(33)}`,
    "https://m.example.com/claim##double",
    "ftp://m.example.com",
    "javascript:alert(1)",
    "",
    "   ",
  ])("rejects credentials, junk fragments, foreign schemes and empty input (%j)", (input) => {
    expect(normalizeRemoteServerInput(input)).toBeNull();
  });

  it("validates IPv4 octets rather than trusting the shape", () => {
    expect(normalizeRemoteServerInput("http://192.168.1.999")).toBeNull();
    expect(normalizeRemoteServerInput("http://300.168.1.2")).toBeNull();
  });
});

describe("recent remote connections", () => {
  it("returns an empty list with no storage or nothing stored", () => {
    expect(loadRemoteConnections(null)).toEqual([]);
    expect(loadRemoteConnections(undefined)).toEqual([]);
    expect(loadRemoteConnections(memoryStorage())).toEqual([]);
  });

  it("remembers the newest connection first, deduplicated", () => {
    const storage = memoryStorage();
    rememberRemoteConnection(storage, "https://a.example.com");
    rememberRemoteConnection(storage, "https://b.example.com");
    rememberRemoteConnection(storage, "https://a.example.com");
    expect(loadRemoteConnections(storage)).toEqual(["https://a.example.com/", "https://b.example.com/"]);
  });

  it("carries a pairing link's fragment through storage intact", () => {
    const storage = memoryStorage();
    rememberRemoteConnection(storage, "https://m.example.com/claim#4KJ2XQ9P");
    expect(loadRemoteConnections(storage)).toEqual(["https://m.example.com/claim#4KJ2XQ9P"]);
  });

  it("drops entries that no longer parse and survives corrupt JSON", () => {
    expect(loadRemoteConnections(memoryStorage({ "muster.remote-connections.v1": "{not json" })).length).toBe(0);
    // A non-string element is schema corruption: the artifact reads back as
    // empty history rather than a partial guess at what it once held.
    const corrupt = memoryStorage({ "muster.remote-connections.v1": JSON.stringify(["https://good.example.com", 42, "http://user@bad.example.com"]) });
    expect(loadRemoteConnections(corrupt)).toEqual([]);
    // Strings that no longer parse as addresses are dropped, valid ones kept.
    const mixed = memoryStorage({ "muster.remote-connections.v1": JSON.stringify(["https://good.example.com", "  ", "https://m.example.com/claim#!!"]) });
    expect(loadRemoteConnections(mixed)).toEqual(["https://good.example.com/"]);
  });

  it("caps the list", () => {
    const storage = memoryStorage();
    const hosts = ["one", "two", "three", "four", "five", "six"];
    for (const host of hosts) rememberRemoteConnection(storage, `https://${host}.example.com`);
    const kept = loadRemoteConnections(storage);
    expect(kept.length).toBe(REMOTE_CONNECTIONS_LIMIT);
    expect(kept[0]).toBe("https://six.example.com/");
  });

  it("leaves storage untouched for input that does not parse", () => {
    const storage = memoryStorage();
    rememberRemoteConnection(storage, "https://good.example.com");
    expect(rememberRemoteConnection(storage, "not a server")).toEqual(["https://good.example.com/"]);
  });

  it("forgets one connection and keeps the rest", () => {
    const storage = memoryStorage();
    rememberRemoteConnection(storage, "https://a.example.com");
    rememberRemoteConnection(storage, "https://b.example.com");
    expect(forgetRemoteConnection(storage, "https://a.example.com")).toEqual(["https://b.example.com/"]);
    expect(forgetRemoteConnection(storage, "https://missing.example.com")).toEqual(["https://b.example.com/"]);
  });
});
