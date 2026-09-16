import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getListeningLanguage,
  listeningLanguageLabel,
  markVoiceFirstRunSeen,
  setListeningLanguage,
  voiceFirstRunSeen,
} from "./voice-first-run";

/** Minimal localStorage for the node test env — the module must degrade to
 * "not seen / no override" when storage throws, so both paths get covered. */
function installStore(throwing = false) {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => (throwing ? (() => { throw new Error("denied"); })() : data.get(k) ?? null),
    setItem: (k: string, v: string) => {
      if (throwing) throw new Error("denied");
      data.set(k, v);
    },
    removeItem: (k: string) => {
      if (throwing) throw new Error("denied");
      data.delete(k);
    },
  };
  vi.stubGlobal("localStorage", store);
}

describe("voice first-run memory", () => {
  beforeEach(() => installStore());
  afterEach(() => vi.unstubAllGlobals());

  it("is unseen until committed, then sticks per bot", () => {
    expect(voiceFirstRunSeen("bot-a")).toBe(false);
    markVoiceFirstRunSeen("bot-a");
    expect(voiceFirstRunSeen("bot-a")).toBe(true);
    expect(voiceFirstRunSeen("bot-b")).toBe(false); // per-bot, like the drafts
  });

  it("never blocks the call when storage is denied", () => {
    installStore(true);
    expect(() => markVoiceFirstRunSeen("bot-a")).not.toThrow();
    expect(voiceFirstRunSeen("bot-a")).toBe(false);
  });
});

describe("listening language override", () => {
  beforeEach(() => installStore());
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a valid tag and clears with null", () => {
    expect(getListeningLanguage()).toBeNull();
    setListeningLanguage("it-IT");
    expect(getListeningLanguage()).toBe("it-IT");
    setListeningLanguage(null);
    expect(getListeningLanguage()).toBeNull();
  });

  it("rejects malformed tags — the key is browser-readable state, not trusted input", () => {
    setListeningLanguage("en-US;rm -rf");
    expect(getListeningLanguage()).toBeNull();
    setListeningLanguage("");
    expect(getListeningLanguage()).toBeNull();
  });

  it("labels known tags, falls back to the raw tag, defaults to Auto", () => {
    expect(listeningLanguageLabel(null)).toBe("Auto (browser language)");
    expect(listeningLanguageLabel("it-IT")).toBe("Italian");
    expect(listeningLanguageLabel("xx-YY")).toBe("xx-YY");
  });
});
