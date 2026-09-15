// The speaker — one voice for the whole window.
//
// Deliberately a singleton: two bots talking over each other is never what
// anyone wants, so starting a new utterance cancels whatever was speaking.
// That single rule is also what makes interrupting work — call mode just
// calls stop().
//
// Audio comes from the harness (POST /api/tts/speak), which holds the
// ElevenLabs key. The renderer never sees it, and never talks to
// ElevenLabs directly.
//
// Text is split into utterances by the harness too, next to the transform
// that produced it — it is the piece most likely to be tuned against real
// transcripts, and keeping it in one place is the same reasoning as the
// server-computed approval key.

import { speechText } from "./speech-text";
import { DEFAULT_SPEECH_CONTROLS, type SpeechControls } from "./session-controls";
import { cursorWords, wordIndexFromCharIndex, wordIndexFromProgress } from "./word-cursor";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  /** what is being spoken, so the UI can show a stop button in the right place */
  botId?: string;
  messageId?: string;
  /** the utterance currently audible — call mode shows it as a caption */
  caption?: string;
  /** 0-based index into caption of the word the voice is (estimated to be) on */
  captionWord?: number;
  /** session speech controls currently in effect (voice session controls) */
  rate?: number;
  volume?: number;
  error?: string;
}

/** The snapshot fields a caption playhead update must carry forward. */
type CaptionBase = Pick<SpeechSnapshot, "status" | "botId" | "messageId" | "caption">;

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  /** Voice session controls (W5): how the voice speaks, per session. */
  private controls: SpeechControls = { ...DEFAULT_SPEECH_CONTROLS };

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    // Non-idle snapshots always carry the live controls so the call UI can
    // show them; idle stays bare (it means "nothing happening", not "nothing
    // happening at 1.15x").
    this.snapshot =
      next.status === "idle" ? next : { ...next, rate: this.controls.rate, volume: this.controls.volume };
    for (const watcher of this.watchers) watcher(this.snapshot);
  }

  get speechControls(): SpeechControls {
    return { ...this.controls };
  }

  /** Apply new rate/volume, effective immediately — even mid-clip. */
  setSpeechControls(next: Partial<SpeechControls>) {
    this.controls = { ...this.controls, ...next };
    if (this.audio) {
      this.audio.volume = this.controls.volume;
      this.audio.playbackRate = this.controls.rate;
    }
    if (this.snapshot.status !== "idle") this.set(this.snapshot);
  }

  /** Calls start with a neutral voice: last session's settings don't leak. */
  resetSpeechControls() {
    this.setSpeechControls({ ...DEFAULT_SPEECH_CONTROLS });
  }

  /** True while this exact message is the one being spoken. */
  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.token += 1;
    this.request?.abort();
    this.request = null;
    // Pausing/removing an <audio> source does not reliably fire `ended` or
    // `error`. Resolve the play promise ourselves so every interrupted
    // speak() settles and call mode cannot leak a forever-pending task.
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * Speak a message. Resolves when it finishes, is interrupted, or fails —
   * never rejects, because a voice failing is a thing to show, not a thing
   * that should take a caller's turn down with it.
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    // Spoken register first: agent replies are written for eyes, and a
    // voice reciting markdown reads out syntax instead of meaning.
    text = speechText(text);
    if (!text) {
      this.set(IDLE);
      return;
    }
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    let freeVoice = false;
    try {
      utterances = await this.prepare(text, opts.voiceId, controller.signal);
    } catch (e) {
      // No ElevenLabs key (or the harness rejected the request): fall back to
      // the browser's built-in voice — free, offline, zero keys, the Elysia
      // insight. The harness's utterance splitter already ran server-side
      // where it could; the browser speaks the raw text when prepare never
      // produced a list.
      const message = e instanceof Error ? e.message : String(e);
      // speechSynthesis is a browser-global capability probe, not a runtime
      // type check — the fallback applies wherever the API exists.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- capability probe of a window global, not input shaping
      const hasNativeVoice = typeof window !== "undefined" && "speechSynthesis" in window;
      if (/elevenlabs|voice service/i.test(message) && hasNativeVoice) {
        freeVoice = true;
        utterances = [text];
      } else {
        if (live()) this.set({ ...IDLE, error: message });
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    // Free-voice path: no ElevenLabs anywhere — speak through the browser's
    // built-in speechSynthesis, one utterance at a time, same caption states
    // as the rendered path so every voice UI treats both identically.
    if (freeVoice) {
      const synth = window.speechSynthesis;
      for (let i = 0; i < utterances.length; i += 1) {
        if (!live()) return;
        const base: CaptionBase = {
          status: "speaking",
          botId: opts.botId,
          messageId: opts.messageId,
          caption: utterances[i],
        };
        this.set(base);
        const finished = await this.playNative(synth, utterances[i], base, controller.signal, live);
        if (!finished) return;
      }
      if (live()) this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    // Prefetch: request utterance n+1 while n is audible. This is what buys
    // responsiveness without holding a streaming socket open for the whole
    // turn — the only gap the listener hears is the first.
    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts.voiceId, controller.signal).then(
        (blob) => ({ blob }),
        (error: Error) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0]);
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1]) : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      const base: CaptionBase = {
        status: "speaking",
        botId: opts.botId,
        messageId: opts.messageId,
        caption: utterances[i],
      };
      this.set(base);
      const finished = await this.play(rendered.blob, base, live);
      if (!finished || !live()) {
        if (live()) this.set({ ...IDLE, error: "The generated voice clip couldn't be played." });
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the voice service returned ${res.status}`);
    if (!body.ready) throw new Error("Add an ElevenLabs key and pick a voice in App Settings to turn on voice.");
    return body.utterances ?? [];
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `the voice service returned ${res.status}`);
    }
    return res.blob();
  }

  /** Free voice: speak one utterance through the browser's built-in
   * speechSynthesis. Resolves true when finished, false when interrupted,
   * mirroring play() exactly so callers treat both paths the same.
   * Boundary events (where the engine emits them) drive the caption
   * word-cursor; engines that don't simply leave the caption unhighlighted. */
  private playNative(
    synth: SpeechSynthesis,
    text: string,
    base: CaptionBase,
    signal: AbortSignal,
    live: () => boolean,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      synth.cancel(); // one voice for the whole window — new cancels old
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.controls.rate;
      utterance.volume = this.controls.volume;
      const wordCount = cursorWords(text).length;
      let lastWord = -1;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        utterance.onend = null;
        utterance.onerror = null;
        utterance.onboundary = null;
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = () => {
        synth.cancel();
        done(false);
      };
      signal.addEventListener("abort", onAbort);
      utterance.onboundary = (event) => {
        if (!live() || wordCount === 0 || !Number.isFinite(event.charIndex)) return;
        const idx = wordIndexFromCharIndex(text, event.charIndex);
        if (idx === lastWord) return;
        lastWord = idx;
        this.set({ ...base, captionWord: idx });
      };
      utterance.onend = () => done(true);
      utterance.onerror = () => done(false);
      synth.speak(utterance);
    });
  }

  private play(blob: Blob, base: CaptionBase, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      audio.volume = this.controls.volume;
      audio.playbackRate = this.controls.rate;
      // The clip carries no word timeline, so the cursor estimates one:
      // played fraction, rate-capped (see word-cursor.ts) — the cap scales
      // with playbackRate because a 1.3x clip really does say more words
      // per second. timeupdate fires a few times a second — enough
      // granularity for a word that lasts longer than that, and cheap
      // enough to not need rAF.
      const wordCount = cursorWords(base.caption ?? "").length;
      let lastWord = -1;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onerror = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.ontimeupdate = () => {
        if (!live() || wordCount === 0) return;
        const idx = wordIndexFromProgress(audio.currentTime, audio.duration, wordCount, 3.2 * this.controls.rate);
        if (idx === lastWord) return;
        lastWord = idx;
        this.set({ ...base, captionWord: idx });
      };
      audio.onended = () => done(true);
      // a clip that cannot decode should not strand the whole message
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();
