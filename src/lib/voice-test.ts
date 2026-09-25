/** Live microphone level probe for the onboarding voice-setup beat.
 *
 * getUserMedia plus an analyser level read on a rAF loop, with one absolute
 * rule: every path — Stop, unmount, or an OS prompt answered after any of
 * them — ends in cleanup. The grant is awaited asynchronously, so a prompt
 * can settle long after the user backed out; a probe that opened the analyser
 * anyway would leave the microphone live (OS mic indicator on, level bar
 * crawling for a beat that no longer exists) until the tab closed. That
 * timing race is why this is a module and not inline component state: it is
 * decided here, once, under test.
 */

export interface VoiceTestStream {
  getTracks(): Array<{ stop(): void }>;
}

export interface VoiceTestAnalyser {
  frequencyBinCount: number;
  getByteFrequencyData(data: Uint8Array): void;
}

export interface VoiceTestAudioContext {
  /** An analyser already fed by the stream, ready for getByteFrequencyData. */
  createAnalyser(stream: VoiceTestStream): VoiceTestAnalyser;
  close(): Promise<void>;
}

export interface VoiceTestHandle {
  /** Ends the probe and releases the microphone. Idempotent, and safe to
   * call before the grant resolves. */
  stop(): void;
}

export interface VoiceTestHandlers {
  /** The stream is live and levels will follow. */
  onReady(): void;
  /** RMS level 0..1 per frame; a final 0 when the probe stops. */
  onLevel(level: number): void;
  /** The prompt was denied or the device failed. Never fires after stop(). */
  onError(): void;
}

export interface VoiceTestOptions {
  /** Defaults to navigator.mediaDevices.getUserMedia; injectable so the
   * late-grant race is testable without a renderer or a real device. */
  getUserMedia?(constraints: { audio: boolean }): Promise<VoiceTestStream>;
  /** Defaults to the DOM AudioContext; injectable for tests. */
  createAudioContext?(): VoiceTestAudioContext;
  /** Defaults to requestAnimationFrame; injectable for deterministic tests. */
  requestFrame?(callback: () => void): () => void;
}

function defaultRequestFrame(callback: () => void): () => void {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
}

function defaultAudioContext(): VoiceTestAudioContext {
  const ctx = new AudioContext();
  return {
    createAnalyser(stream) {
      // SAFETY: in the default (browser) path the stream is the MediaStream
      // getUserMedia produced; MediaStream satisfies the structural
      // VoiceTestStream surface, which is all the probe ever relies on.
      const source = ctx.createMediaStreamSource(stream as MediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return analyser;
    },
    close: () => ctx.close(),
  };
}

export function startVoiceTest(handlers: VoiceTestHandlers, options: VoiceTestOptions = {}): VoiceTestHandle {
  let stopped = false;
  let cleanup: (() => void) | null = null;

  const handle: VoiceTestHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      cleanup?.();
      cleanup = null;
      handlers.onLevel(0);
    },
  };

  const requestMedia =
    options.getUserMedia ?? ((constraints: { audio: boolean }) => navigator.mediaDevices.getUserMedia(constraints));
  const makeContext = options.createAudioContext ?? defaultAudioContext;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;

  void (async () => {
    try {
      const stream = await requestMedia({ audio: true });
      // The prompt can settle after stop(): never open the analyser, never
      // request a frame — hand the tracks straight back and end quietly.
      if (stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const ctx = makeContext();
      const analyser = ctx.createAnalyser(stream);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let cancelFrame: (() => void) | null = null;
      const tick = () => {
        if (stopped) return;
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const rms = Math.sqrt(sum / data.length) / 255;
        handlers.onLevel(Math.min(1, rms * 4));
        cancelFrame = requestFrame(tick);
      };
      cancelFrame = requestFrame(tick);
      handlers.onReady();
      cleanup = () => {
        cancelFrame?.();
        for (const track of stream.getTracks()) track.stop();
        void ctx.close().catch(() => {});
      };
    } catch {
      // A rejected prompt must surface while the beat is still mounted;
      // after stop() the user already moved on — stay silent.
      if (!stopped) {
        handle.stop();
        handlers.onError();
      }
    }
  })();

  return handle;
}
