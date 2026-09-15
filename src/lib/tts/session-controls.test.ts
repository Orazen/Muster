import { describe, expect, it } from "vitest";
import {
  applySpeechControl,
  DEFAULT_SPEECH_CONTROLS,
  matchSpeechControl,
  SPEECH_CONTROL_CAPABILITIES,
} from "./session-controls";

describe("matchSpeechControl", () => {
  it("recognizes each capability as a leading phrase", () => {
    expect(matchSpeechControl("be quieter")).toBe("quieter");
    expect(matchSpeechControl("please speak softer")).toBe("quieter");
    expect(matchSpeechControl("turn it down")).toBe("quieter");
    expect(matchSpeechControl("speak up")).toBe("louder");
    expect(matchSpeechControl("louder")).toBe("louder");
    expect(matchSpeechControl("talk faster")).toBe("faster");
    expect(matchSpeechControl("speed up")).toBe("faster");
    expect(matchSpeechControl("slow down")).toBe("slower");
    expect(matchSpeechControl("back to normal")).toBe("normal");
  });

  it("ignores sentences that merely mention the words", () => {
    expect(matchSpeechControl("run the tests faster than yesterday")).toBeNull();
    expect(matchSpeechControl("the sales went up last quarter, quieter markets too")).toBeNull();
    expect(matchSpeechControl("can you lower the price estimate?")).toBeNull();
  });

  it("covers every advertised capability", () => {
    // each capability has at least one natural phrase
    const phrases = ["be quieter", "speak up", "go faster", "go slower", "reset the volume"];
    expect(phrases.map(matchSpeechControl)).toEqual(SPEECH_CONTROL_CAPABILITIES);
  });
});

describe("applySpeechControl", () => {
  it("steps volume and rate in the right direction", () => {
    expect(applySpeechControl(DEFAULT_SPEECH_CONTROLS, "quieter").volume).toBe(0.7);
    expect(applySpeechControl(DEFAULT_SPEECH_CONTROLS, "louder").volume).toBe(1);
    expect(applySpeechControl(DEFAULT_SPEECH_CONTROLS, "faster").rate).toBe(1.15);
    expect(applySpeechControl(DEFAULT_SPEECH_CONTROLS, "slower").rate).toBe(0.87);
  });

  it("clamps to the bounds no matter how many times", () => {
    let c = DEFAULT_SPEECH_CONTROLS;
    for (let i = 0; i < 10; i++) c = applySpeechControl(c, "quieter");
    expect(c.volume).toBe(0.2);
    c = DEFAULT_SPEECH_CONTROLS;
    for (let i = 0; i < 10; i++) c = applySpeechControl(c, "faster");
    expect(c.rate).toBe(1.6);
  });

  it("normal resets both axes", () => {
    const loud = applySpeechControl(applySpeechControl(DEFAULT_SPEECH_CONTROLS, "louder"), "faster");
    expect(applySpeechControl(loud, "normal")).toEqual(DEFAULT_SPEECH_CONTROLS);
  });

  it("does not mutate the input", () => {
    const frozen = { ...DEFAULT_SPEECH_CONTROLS };
    applySpeechControl(frozen, "quieter");
    expect(frozen).toEqual(DEFAULT_SPEECH_CONTROLS);
  });
});
