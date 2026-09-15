// Dictation for calls — one surface, two engines.
//
// On desktop the native bridge (Apple SFSpeechRecognizer via window.ogb) is
// used exactly as before. On the web there is no native helper, so calls fall
// back to the browser's OWN speech recognizer — free, no key, no server
// round-trip for audio. The adapter mirrors the bridge's event shape
// (partial/final transcript lines, an end event with a code) so the call
// components keep a single loop instead of branching per platform.
//
// Turn-taking: the browser's recognizer ends an utterance on its own
// (silence detection), which maps onto the native endpointer — a final line
// is followed by an end event, and the call reopens the mic from "listening".

export interface DictationLine {
  text?: string;
  partial?: boolean;
  error?: string;
}

export interface DictationEnd {
  code: number | null;
  reason?: string;
}

export interface DictationSource {
  kind: "native" | "web" | "none";
  /** localized language tag the engine will listen for, when known */
  lang(): string | null;
  speechStart(options?: { endpointMs?: number }): Promise<void>;
  speechStop(): Promise<void>;
  onSpeechTranscript(cb: (line: DictationLine) => void): () => void;
  onSpeechEnd(cb: (info: DictationEnd) => void): () => void;
}

// The vendor API's shape lives in src/types/web-speech.d.ts (ambient, like
// the desktop bridge) — never trust what we read from it beyond those fields.

function webSpeechCtor(): WebSpeechCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function nativeSource(): DictationSource | null {
  const bridge = window.ogb;
  if (!bridge?.speechStart) return null;
  return {
    kind: "native",
    lang: () => null,
    speechStart: (options) => bridge.speechStart(options),
    speechStop: () => bridge.speechStop(),
    onSpeechTranscript: (cb) => bridge.onSpeechTranscript(cb),
    onSpeechEnd: (cb) => bridge.onSpeechEnd(cb),
  };
}

function webSource(ctor: WebSpeechCtor): DictationSource {
  const transcriptCbs = new Set<(line: DictationLine) => void>();
  const endCbs = new Set<(info: DictationEnd) => void>();
  let active: WebSpeechRecognitionLike | null = null;
  let stoppedOnPurpose = false;
  let lastError: string | null = null;
  // permission/service failures must NOT auto-restart (an endless denial
  // loop); silence and the browser's own session timeout are fine to restart
  const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

  return {
    kind: "web",
    lang: () => navigator.language || "en-US",
    async speechStart() {
      // one utterance per listen — the browser's own silence detection is
      // the endpointer, mirroring the native helper's contract
      this.speechStop();
      stoppedOnPurpose = false;
      const rec = new ctor();
      active = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || "en-US";
      rec.onresult = (event) => {
        if (active !== rec) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          transcriptCbs.forEach((cb) => cb({ text, partial: !result.isFinal }));
          if (result.isFinal) {
            // final = the turn ended; close the recognizer so the next
            // listen starts clean, and let the call advance
            stoppedOnPurpose = true;
            rec.stop();
          }
        }
      };
      rec.onerror = (event) => {
        if (active !== rec) return;
        lastError = event.error;
        if (!FATAL_ERRORS.has(event.error)) return;
        transcriptCbs.forEach((cb) => cb({ error: event.error }));
      };
      rec.onend = () => {
        if (active !== rec) return;
        active = null;
        const fatal = lastError !== null && FATAL_ERRORS.has(lastError);
        const info: DictationEnd = stoppedOnPurpose
          ? { code: 0 }
          : fatal
            ? { code: 1, reason: `web-${lastError}` }
            : { code: 0 };
        lastError = null;
        endCbs.forEach((cb) => cb(info));
      };
      rec.start();
    },
    async speechStop() {
      const rec = active;
      if (!rec) return;
      stoppedOnPurpose = true;
      active = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already ended */
      }
    },
    onSpeechTranscript: (cb) => {
      transcriptCbs.add(cb);
      return () => transcriptCbs.delete(cb);
    },
    onSpeechEnd: (cb) => {
      endCbs.add(cb);
      return () => endCbs.delete(cb);
    },
  };
}

let cached: DictationSource | null | undefined;

/** The call components ask once per mount. Native wins when present; the
 * browser recognizer is the free web path; "none" keeps the honest
 * "calls need dictation" gate. */
export function getDictation(): DictationSource {
  if (cached === undefined) {
    const native = nativeSource();
    if (native) cached = native;
    else {
      const ctor = webSpeechCtor();
      cached = ctor ? webSource(ctor) : null;
    }
  }
  return cached ?? {
    kind: "none",
    lang: () => null,
    async speechStart() {
      throw new Error("no dictation engine");
    },
    async speechStop() {
      /* nothing to stop */
    },
    onSpeechTranscript: () => () => {},
    onSpeechEnd: () => () => {},
  };
}

/** Test seam: forget the cached engine (jsdom has no SpeechRecognition, so
 * suite code that stubs one must re-resolve). */
export function resetDictationForTests(): void {
  cached = undefined;
}
