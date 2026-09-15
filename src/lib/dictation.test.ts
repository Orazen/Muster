// The dictation adapter: engine selection (native wins, web fallback, none
// is honest) and the web engine's event mapping — final result closes the
// turn (code 0), a permission error must NOT auto-restart (code 1).
// The suite runs in node; `window` is a stub like every other client test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDictation, resetDictationForTests, type DictationEnd, type DictationLine } from "./dictation";

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  started = 0;
  aborted = 0;
  onresult: ((event: { resultIndex: number; results: { length: number; [i: number]: unknown } }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start() {
    this.started += 1;
  }
  stop() {
    /* manual stop */
  }
  abort() {
    this.aborted += 1;
  }
  /** drive one recognizer result like the browser would */
  emit(text: string, isFinal: boolean) {
    const result = { isFinal, length: 1, 0: { transcript: text, confidence: 0.9 } };
    const results = { length: 1, 0: result };
    this.onresult?.({ resultIndex: 0, results });
  }
  emitError(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

let fake: FakeRecognition | null = null;

function stubWindow(withWeb: boolean) {
  const Ctor = function (this: unknown) {
    const rec = new FakeRecognition();
    fake = rec;
    return rec;
  } as unknown as new () => FakeRecognition;
  const win: Record<string, unknown> = {};
  if (withWeb) win.webkitSpeechRecognition = Ctor;
  vi.stubGlobal("window", win);
  return win;
}

beforeEach(() => {
  resetDictationForTests();
  fake = null;
  stubWindow(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDictationForTests();
});

function collect(source: ReturnType<typeof getDictation>) {
  const lines: DictationLine[] = [];
  const ends: DictationEnd[] = [];
  source.onSpeechTranscript((line) => lines.push(line));
  source.onSpeechEnd((info) => ends.push(info));
  return { lines, ends };
}

describe("dictation adapter", () => {
  it("chooses the browser engine when no native bridge exists", () => {
    expect(getDictation().kind).toBe("web");
  });

  it("reports none honestly when neither engine exists", () => {
    stubWindow(false);
    resetDictationForTests();
    expect(getDictation().kind).toBe("none");
  });

  it("native bridge wins when present", () => {
    const win = stubWindow(true);
    win.ogb = {
      speechStart: () => Promise.resolve(),
      speechStop: () => Promise.resolve(),
      onSpeechTranscript: () => () => {},
      onSpeechEnd: () => () => {},
    };
    resetDictationForTests();
    expect(getDictation().kind).toBe("native");
  });

  it("interim then final transcript lines, and a final result ends the turn with code 0", async () => {
    const source = getDictation();
    const { lines, ends } = collect(source);
    await source.speechStart();
    fake!.emit("hel", false);
    fake!.emit("hello there", true);
    // the browser fires onend after a stop() following the final result
    fake!.onend?.();
    expect(lines).toEqual([
      { text: "hel", partial: true },
      { text: "hello there", partial: false },
    ]);
    expect(ends).toEqual([{ code: 0 }]);
  });

  it("a permission error surfaces as a line error and end code 1 — no auto-restart", async () => {
    const source = getDictation();
    const { lines, ends } = collect(source);
    await source.speechStart();
    fake!.emitError("not-allowed");
    expect(lines).toEqual([{ error: "not-allowed" }]);
    expect(ends).toEqual([{ code: 1, reason: "web-not-allowed" }]);
  });

  it("silence timeout (no-speech) restarts cleanly — end code 0, no error line", async () => {
    const source = getDictation();
    const { lines, ends } = collect(source);
    await source.speechStart();
    fake!.emitError("no-speech");
    expect(lines).toEqual([]);
    expect(ends).toEqual([{ code: 0 }]);
  });

  it("speechStop retires the old recognizer — its late events are dropped", async () => {
    const source = getDictation();
    const { lines, ends } = collect(source);
    await source.speechStart();
    const rec = fake!;
    await source.speechStop();
    rec.emit("late ghost", true);
    expect(lines).toEqual([]);
    expect(ends).toEqual([]);
  });

  it("a second listen replaces the first recognizer", async () => {
    const source = getDictation();
    await source.speechStart();
    const first = fake!;
    await source.speechStart();
    expect(fake).not.toBe(first);
    expect(fake!.started).toBe(1);
  });
});
