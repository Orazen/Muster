/**
 * The energy side of barge-in (W4): an AEC'd analysis stream kept open
 * while the bot speaks. Samples RMS off a Web Audio analyser on the
 * monitor cadence and hands them to the guard; a trip means "the human is
 * talking over the bot" — call `onTrip` and release the mic.
 *
 * This is deliberately analysis-only: web SpeechRecognition owns its own
 * capture, so the recognizer is NOT running during playback. The trip
 * stops playback and starts the recognizer fresh — the same beat as
 * pressing Space, with the same small startup latency. Native capture has
 * no AEC on its path and never opens this stream (CallView keeps it
 * web-only); unsupported or denied capture resolves null so the room can
 * say so instead of hanging.
 */

import { createBargeInGuard, type BargeInThresholds, DEFAULT_BARGE_IN } from "./barge-in";

export interface EnergyMonitor {
  stop(): void;
}

export interface BargeInMonitorOptions {
  onTrip: () => void;
  /** Analysis cadence; 50ms matches the guard's 50ms sample math. */
  sampleMs?: number;
  thresholds?: BargeInThresholds;
}

export async function startBargeInMonitor(options: BargeInMonitorOptions): Promise<EnergyMonitor | null> {
  const { onTrip, sampleMs = 50, thresholds = DEFAULT_BARGE_IN } = options;
  // SAFETY: `webkitAudioContext` is the pre-standard spelling of the same
  // constructor — read as an optional field on a known shape, never
  // constructed from untyped input.
  const AudioCtor =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia || !AudioCtor) return null;

  let stream: MediaStream;
  try {
    // echoCancellation is the whole point: the readings must be the human
    // talking over the bot, not the bot itself.
    stream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    return null;
  }

  const context = new AudioCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  const guard = createBargeInGuard(thresholds);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  const timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    if (guard.feed(rms, performance.now())) {
      stop();
      onTrip();
    }
  }, sampleMs);

  return { stop };
}
