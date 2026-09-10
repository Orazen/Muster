import type { ChatTarget, CompanionClient } from "../hooks/companion-session";

export interface ComposerSnapshot {
  draft: string;
  pending: boolean;
  error: string | null;
}

const connectionIds = new WeakMap<CompanionClient, number>();
let nextConnectionId = 0;
export function composerContextKey(connection: CompanionClient, target: ChatTarget): string {
  let id = connectionIds.get(connection);
  if (id === undefined) { id = ++nextConnectionId; connectionIds.set(connection, id); }
  return JSON.stringify([id, target.kind, target.id, target.threadId]);
}

/** One mounted chat's draft; it never retries or redirects a submitted task. */
export class ComposerDraft {
  private snapshot: ComposerSnapshot = { draft: "", pending: false, error: null };
  private listeners = new Set<() => void>();
  private revision = 0;
  private epoch = 0;
  private active = false;

  constructor(private readonly send: (text: string) => Promise<boolean>) {}

  getSnapshot = (): ComposerSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(next: ComposerSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  // React's development effect replay may attach the same instance again;
  // epochs ensure a completion from its earlier attachment stays obsolete.
  attach = (): (() => void) => {
    this.active = true;
    this.epoch++;
    this.update({ ...this.snapshot, pending: false });
    return () => {
      this.active = false;
      this.epoch++;
    };
  };
  edit = (draft: string): void => {
    if (!this.active) return;
    this.revision++;
    this.update({ ...this.snapshot, draft, error: null });
  };
  submit = async (): Promise<void> => {
    if (!this.active || this.snapshot.pending) return;
    const text = this.snapshot.draft.trim();
    if (!text) return;
    const revision = this.revision, epoch = this.epoch;
    this.update({ ...this.snapshot, pending: true, error: null });
    if (!this.active || this.epoch !== epoch) return;
    try {
      const accepted = await this.send(text);
      if (!this.active || this.epoch !== epoch) return;
      if (!accepted) {
        this.update({ ...this.snapshot, pending: false, error: "This chat changed. Reopen it before sending." });
        return;
      }
      this.update({ draft: this.revision === revision ? "" : this.snapshot.draft, pending: false, error: null });
    } catch (cause) {
      if (!this.active || this.epoch !== epoch) return;
      const error = cause instanceof Error && cause.message.trim() ? cause.message : "Could not send your message. Try again.";
      this.update({ ...this.snapshot, pending: false, error });
    }
  };
}
