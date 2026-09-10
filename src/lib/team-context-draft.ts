export interface TeamContextDraftState {
  text: string;
  status: "loading" | "load-error" | "idle" | "saving" | "saved" | "error";
  error: string | null;
}

/** Keeps each blurred draft in write order. Later typing remains editable
 * while an older save settles, and only the current draft owns feedback. */
export class TeamContextDraft {
  state: TeamContextDraftState = { text: "", status: "loading", error: null };
  private revision = 0;
  private savedRevision = 0;
  private loadAttempt = 0;
  private tail = Promise.resolve();
  private pending = new Map<number, Promise<void>>();
  private listener: ((state: TeamContextDraftState) => void) | null = null;

  constructor(
    private read: () => Promise<string>,
    private write: (text: string) => Promise<void>,
  ) {}

  subscribe(listener: (state: TeamContextDraftState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = null;
      this.loadAttempt += 1;
    };
  }

  private publish(state: TeamContextDraftState) {
    this.state = state;
    this.listener?.(state);
  }

  async load(): Promise<void> {
    if (this.revision > 0) return;
    const attempt = ++this.loadAttempt;
    this.publish({ text: this.state.text, status: "loading", error: null });
    try {
      const text = await this.read();
      if (attempt === this.loadAttempt && this.revision === 0) {
        this.publish({ text, status: "idle", error: null });
      }
    } catch (error) {
      if (attempt === this.loadAttempt && this.revision === 0) {
        this.publish({ text: this.state.text, status: "load-error", error: error instanceof Error ? error.message : "The server could not load your saved brief." });
      }
    }
  }

  edit(text: string) {
    if (this.state.status === "loading" || this.state.status === "load-error") return;
    this.revision += 1;
    this.publish({ text, status: "idle", error: null });
  }

  save(): Promise<void> {
    if (this.state.status === "loading" || this.state.status === "load-error") return Promise.resolve();
    const revision = this.revision;
    if (revision <= this.savedRevision) return Promise.resolve();
    const existing = this.pending.get(revision);
    if (existing) return existing;
    const text = this.state.text;
    this.publish({ text, status: "saving", error: null });
    const request = this.tail.then(async () => {
      try {
        await this.write(text);
        this.savedRevision = revision;
        if (revision === this.revision) this.publish({ text: this.state.text, status: "saved", error: null });
      } catch (error) {
        if (revision === this.revision) {
          this.publish({ text: this.state.text, status: "error", error: error instanceof Error ? error.message : "The server could not save this draft." });
        }
      } finally {
        this.pending.delete(revision);
      }
    });
    this.pending.set(revision, request);
    // Failures are handled inside the queued request, so a later draft or
    // explicit retry still gets its own write attempt.
    this.tail = request;
    return request;
  }
}
