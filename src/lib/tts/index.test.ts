import { beforeEach, describe, expect, it, vi } from "vitest";

import { Speaker } from "./index";

class FakeAudio {
  static latest: FakeAudio | null = null;

  src: string;
  currentTime = 0;
  duration = 0;
  volume = 1;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

/** Stand-in for the browser's SpeechSynthesisUtterance on the free-voice path. */
class FakeUtterance {
  static latest: FakeUtterance | null = null;

  text: string;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: ((e: { charIndex: number }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
    FakeUtterance.latest = this;
  }
}

/** JSON-shaped payload the speech API stub returns. */
type ApiPrimitive = string | number | boolean | null;
interface ApiObject {
  [key: string]: ApiValue;
}
type ApiValue = ApiPrimitive | ApiObject | ApiValue[];

function json(body: ApiValue): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Hello there."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("advances the caption word cursor with the clip playhead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["alpha bravo charlie delta echo"] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("alpha bravo charlie delta echo");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    expect(speaker.state.captionWord).toBeUndefined();

    const audio = FakeAudio.latest!;
    audio.duration = 10;
    audio.currentTime = 5;
    audio.ontimeupdate?.();
    expect(speaker.state.caption).toBe("alpha bravo charlie delta echo");
    expect(speaker.state.captionWord).toBe(2);

    audio.currentTime = 8;
    audio.ontimeupdate?.();
    expect(speaker.state.captionWord).toBe(4);

    audio.onended?.();
    await speaking;
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("drives the caption cursor from native boundary events on the free-voice path", async () => {
    FakeUtterance.latest = null;
    // node test env: the free-voice path probes window.speechSynthesis, so
    // the window itself must exist for the fallback to engage.
    const fakeSynth = { cancel: vi.fn(), speak: vi.fn() };
    vi.stubGlobal("window", { speechSynthesis: fakeSynth });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    // prepare refuses (no ElevenLabs key) → the free-voice fallback speaks raw text
    vi.stubGlobal("fetch", vi.fn(async () => json({ ready: false })));
    const speaker = new Speaker();
    const speaking = speaker.speak("alpha bravo charlie");
    await vi.waitFor(() => expect(FakeUtterance.latest).not.toBeNull());
    expect(speaker.state.caption).toBe("alpha bravo charlie");
    expect(speaker.state.captionWord).toBeUndefined();

    FakeUtterance.latest!.onboundary?.({ charIndex: 6 });
    expect(speaker.state.captionWord).toBe(1);
    FakeUtterance.latest!.onboundary?.({ charIndex: 12 });
    expect(speaker.state.captionWord).toBe(2);

    FakeUtterance.latest!.onend?.();
    await speaking;
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("applies session speech controls to clips and stamps the snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["alpha bravo charlie"] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    speaker.setSpeechControls({ rate: 1.15, volume: 0.7 });
    const speaking = speaker.speak("alpha bravo charlie");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    expect(FakeAudio.latest!.playbackRate).toBe(1.15);
    expect(FakeAudio.latest!.volume).toBe(0.7);
    expect(speaker.state.rate).toBe(1.15);
    expect(speaker.state.volume).toBe(0.7);

    // mid-clip changes hit the live element immediately
    speaker.setSpeechControls({ volume: 0.5 });
    expect(FakeAudio.latest!.volume).toBe(0.5);
    expect(speaker.state.volume).toBe(0.5);

    FakeAudio.latest!.onended?.();
    await speaking;
    // idle snapshots stay bare, but the controls persist for the next speak
    expect(speaker.state).toEqual({ status: "idle" });
    expect(speaker.speechControls).toEqual({ rate: 1.15, volume: 0.5 });

    speaker.resetSpeechControls();
    expect(speaker.speechControls).toEqual({ rate: 1, volume: 1 });
  });

  it("passes a per-bot voice through preparation and synthesis", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Distinct voice."] })
          : new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(bodies).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });
});
