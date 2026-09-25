import { describe, expect, it, vi } from "vitest";
import { startVoiceTest, type VoiceTestAudioContext, type VoiceTestStream } from "./voice-test";

/** Minimal WebAudio double: the analyser hands back synthetic magnitudes.
 * A class, not an arrow factory — the probe does `new Ctor()`. */
function makeAudioContext(magnitudes: number[]) {
  const close = vi.fn(async () => {});
  const analyser = {
    fftSize: 0,
    frequencyBinCount: magnitudes.length,
    getByteFrequencyData: (data: Uint8Array) => data.set(magnitudes),
  };
  class Ctor implements VoiceTestAudioContext {
    createAnalyser() {
      return analyser;
    }
    createMediaStreamSource(stream: VoiceTestStream) {
      return { connect: () => void stream };
    }
    close() {
      return close();
    }
  }
  return { close, analyser, Ctor };
}

function makeStream() {
  const stop = vi.fn();
  const stream: VoiceTestStream = { getTracks: () => [{ stop }] };
  return { stream, stop };
}

function manualFrame() {
  const run: Array<() => void> = [];
  return {
    requestFrame: (callback: () => void) => {
      run.push(callback);
      return () => {
        const index = run.indexOf(callback);
        if (index >= 0) run.splice(index, 1);
      };
    },
    /** Fire the most recently scheduled frame callback, consuming it —
     * mirroring rAF, where a fired frame is gone and the callback itself
     * schedules the next one. */
    tick: () => run.pop()?.(),
    pending: () => run.length,
  };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Settle the microtask chain the probe's async body rides on. A macrotask
 * boundary deterministically drains every pending microtask regardless of
 * how many promise layers the (possibly async) getUserMedia double wraps. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe("voice test probe", () => {
  it("emits a scaled level per frame and reports silence when stopped", async () => {
    const { Ctor } = makeAudioContext(Array.from({ length: 64 }, () => 128));
    const { stream } = makeStream();
    const frames = manualFrame();
    const onLevel = vi.fn();
    const onReady = vi.fn();
    const probe = startVoiceTest({ onReady, onLevel, onError: vi.fn() }, {
      getUserMedia: async () => stream,
      createAudioContext: () => new Ctor(),
      requestFrame: frames.requestFrame,
    });

    // let the async body acquire the stream and schedule the first frame
    await settle();

    frames.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    // RMS of 128/255 ≈ 0.502, ×4 → clamped to 1
    expect(onLevel).toHaveBeenLastCalledWith(1);
    expect(frames.pending()).toBe(1);

    probe.stop();
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(frames.pending()).toBe(0);
    // a stopped probe's frame callback is inert
    frames.tick();
    expect(onLevel).toHaveBeenCalledTimes(2);
  });

  it("releases the microphone when stop lands before the OS prompt resolves", async () => {
    const { Ctor } = makeAudioContext([]);
    const { stream, stop } = makeStream();
    const grant = deferred<VoiceTestStream>();
    const onLevel = vi.fn();
    const onError = vi.fn();
    const probe = startVoiceTest({ onReady: vi.fn(), onLevel, onError }, {
      getUserMedia: () => grant.promise,
      createAudioContext: () => new Ctor(),
      requestFrame: () => () => {},
    });

    probe.stop();
    expect(onLevel).toHaveBeenLastCalledWith(0);

    // The user answers "Allow" after backing out: the stream must be handed
    // straight back — no analyser, no level, no leaked microphone.
    grant.resolve(stream);
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onLevel).toHaveBeenCalledTimes(1);
  });

  it("releases the microphone on unmount before the prompt resolves", async () => {
    const { Ctor } = makeAudioContext([]);
    const { stream, stop } = makeStream();
    const grant = deferred<VoiceTestStream>();
    const probe = startVoiceTest({ onReady: vi.fn(), onLevel: vi.fn(), onError: vi.fn() }, {
      getUserMedia: () => grant.promise,
      createAudioContext: () => new Ctor(),
      requestFrame: () => () => {},
    });

    // unmount without an explicit Stop — the effect cleanup path
    probe.stop();
    grant.resolve(stream);
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports a denied prompt as an error while mounted", async () => {
    const onLevel = vi.fn();
    const onError = vi.fn();
    const grant = deferred<VoiceTestStream>();
    startVoiceTest({ onReady: vi.fn(), onLevel, onError }, { getUserMedia: () => grant.promise });

    grant.reject(new Error("NotAllowedError"));
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onLevel).toHaveBeenLastCalledWith(0);

    // a late grant after the error path must not leak either
    const { stream, stop } = makeStream();
    grant.resolve(stream);
    await settle();
    expect(stop).not.toHaveBeenCalled();
  });

  it("stays silent when the prompt is denied after the user backed out", async () => {
    const onLevel = vi.fn();
    const onError = vi.fn();
    const grant = deferred<VoiceTestStream>();
    const probe = startVoiceTest({ onReady: vi.fn(), onLevel, onError }, { getUserMedia: () => grant.promise });

    probe.stop();
    grant.reject(new Error("NotAllowedError"));
    await settle();
    expect(onError).not.toHaveBeenCalled();
  });
});
