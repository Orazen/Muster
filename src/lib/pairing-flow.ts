import { z } from "zod";

const pairingResponse = z.object({
  code: z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
});
const errorResponse = z.object({ error: z.string().trim().min(1) });
export type PairingCode = z.infer<typeof pairingResponse>;
export interface PairingState {
  status: "idle" | "loading" | "ready" | "error";
  pairing: PairingCode | null;
  error: string | null;
  copy: "idle" | "copying" | "copied" | "manual";
}

export function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** One active read per page instance; effect re-subscription never refreshes
 * or rotates a live code. Clipboard feedback belongs to its exact revision. */
export class PairingFlow {
  state: PairingState = { status: "idle", pairing: null, error: null, copy: "idle" };
  private started = false;
  private request?: Promise<void>;
  private listener?: (state: PairingState) => void;
  private copyRevision = 0;
  private copyTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
    private readonly writeText: (code: string) => Promise<void> = (code) => navigator.clipboard.writeText(code),
  ) {}

  subscribe(listener: (state: PairingState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener !== listener) return;
      this.listener = undefined;
      this.clearCopyFeedback();
      this.state = { ...this.state, copy: "idle" };
    };
  }

  start(): Promise<void> {
    if (this.started) return this.request ?? Promise.resolve();
    this.started = true;
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (this.request) return this.request;
    this.clearCopyFeedback();
    this.publish({ ...this.state, status: "loading", error: null, copy: "idle" });
    this.request = this.load().finally(() => { this.request = undefined; });
    return this.request;
  }

  get canCopy(): boolean {
    return this.state.status === "ready" && this.state.pairing !== null && this.state.pairing.expiresAt > this.now();
  }

  async copy(): Promise<"copied" | "manual" | "ignored"> {
    if (!this.canCopy || this.state.copy === "copying" || !this.state.pairing) return "ignored";
    const pairing = this.state.pairing;
    const revision = ++this.copyRevision;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.publish({ ...this.state, copy: "copying" });
    const current = () => {
      if (revision !== this.copyRevision || this.state.pairing !== pairing) return false;
      if (this.canCopy) return true;
      this.publish({ ...this.state, copy: "idle" });
      return false;
    };
    try {
      await this.writeText(pairing.code);
      if (!current()) return "ignored";
      this.publish({ ...this.state, copy: "copied" });
      this.copyTimer = setTimeout(() => {
        this.copyTimer = undefined;
        if (revision === this.copyRevision) this.publish({ ...this.state, copy: "idle" });
      }, 1500);
      return "copied";
    } catch {
      if (!current()) return "ignored";
      this.publish({ ...this.state, copy: "manual" });
      return "manual";
    }
  }

  private clearCopyFeedback() {
    this.copyRevision++;
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = undefined;
  }

  private publish(state: PairingState) {
    this.state = state;
    this.listener?.(state);
  }

  private async load(): Promise<void> {
    try {
      const response = await this.transport("/api/pair/create", { method: "POST", credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = errorResponse.safeParse(body);
        throw new Error(failure.success ? failure.data.error : "Could not get a pairing code. Try again.");
      }
      const parsed = pairingResponse.safeParse(body);
      if (!parsed.success) throw new Error("Muster returned an incomplete pairing code. Try again.");
      if (parsed.data.expiresAt <= this.now()) throw new Error("This pairing code has expired. Try getting a new code.");
      this.publish({ status: "ready", pairing: parsed.data, error: null, copy: "idle" });
    } catch (error) {
      this.publish({ ...this.state, status: "error", copy: "idle",
        error: error instanceof Error && !(error instanceof TypeError) ? error.message : "Could not reach Muster. Check your connection and try again." });
    }
  }
}
