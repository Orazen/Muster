import { describe, expect, it, vi } from "vitest";
import { TeamContextDraft, type TeamContextDraftState } from "./team-context-draft";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("Shared brain draft persistence", () => {
  it("loads the saved brief without writing an untouched draft on blur", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const editor = new TeamContextDraft(async () => "Existing brief", write);
    await editor.load();
    await editor.save();
    expect(editor.state.text).toBe("Existing brief");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the editor unavailable until the initial read settles, then accepts a replacement draft", async () => {
    const read = deferred<string>();
    const editor = new TeamContextDraft(() => read.promise, async () => {});
    const loading = editor.load();
    expect(editor.state.status).toBe("loading");
    editor.edit("The user's new brief");
    expect(editor.state.text).toBe("");
    read.resolve("Older server brief");
    await loading;
    expect(editor.state).toMatchObject({ text: "Older server brief", status: "idle" });
    editor.edit("The user's new brief");
    await editor.load();
    expect(editor.state).toMatchObject({ text: "The user's new brief", status: "idle" });
  });

  it("does not deliver an initial read after its subscriber unmounts", async () => {
    const read = deferred<string>();
    const editor = new TeamContextDraft(() => read.promise, async () => {});
    const listener = vi.fn();
    const unsubscribe = editor.subscribe(listener);
    const loading = editor.load();
    const beforeUnmount = listener.mock.calls.length;
    unsubscribe();
    read.resolve("Late server brief");
    await loading;
    expect(listener).toHaveBeenCalledTimes(beforeUnmount);
    expect(editor.state.text).toBe("");
  });

  it("serializes two blurred edits so a delayed older PUT cannot overwrite the newer brief", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let stored = "Original";
    const write = vi.fn(async (text: string) => {
      await (text === "A" ? first.promise : second.promise);
      stored = text;
    });
    const editor = new TeamContextDraft(async () => stored, write);
    await editor.load();
    editor.edit("A");
    const savedA = editor.save();
    await Promise.resolve();
    editor.edit("B");
    const savedB = editor.save();
    await Promise.resolve();
    expect(write.mock.calls).toEqual([["A"]]);
    expect(editor.state).toMatchObject({ text: "B", status: "saving" });

    first.resolve();
    await savedA;
    expect(write.mock.calls).toEqual([["A"], ["B"]]);
    expect(stored).toBe("A");
    expect(editor.state.status).toBe("saving");
    second.resolve();
    await savedB;
    expect(stored).toBe("B");
    expect(editor.state).toMatchObject({ text: "B", status: "saved" });
  });

  it("does not mark an unblurred newer draft saved when an earlier write finishes", async () => {
    const response = deferred<void>();
    const editor = new TeamContextDraft(async () => "", () => response.promise);
    await editor.load();
    editor.edit("Blurred draft");
    const saving = editor.save();
    editor.edit("Still typing");
    response.resolve();
    await saving;
    expect(editor.state).toMatchObject({ text: "Still typing", status: "idle" });
  });

  it("continues the queue after an old failure without replacing newer feedback", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const write = vi.fn((text: string) => text === "A" ? first.promise : second.promise);
    const editor = new TeamContextDraft(async () => "", write);
    await editor.load();
    const updates: TeamContextDraftState[] = [];
    editor.subscribe((state) => updates.push(state));
    editor.edit("A");
    const savedA = editor.save();
    editor.edit("B");
    const savedB = editor.save();
    first.reject(new Error("Old save failed"));
    await savedA;
    expect(write.mock.calls).toEqual([["A"], ["B"]]);
    expect(updates.some((state) => state.status === "error")).toBe(false);
    expect(editor.state).toMatchObject({ text: "B", status: "saving" });
    second.resolve();
    await savedB;
    expect(editor.state.status).toBe("saved");
  });

  it("keeps a failed current draft and permits an explicit retry", async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce(undefined);
    const editor = new TeamContextDraft(async () => "", write);
    await editor.load();
    editor.edit("Keep this draft");
    await editor.save();
    expect(editor.state).toEqual({ text: "Keep this draft", status: "error", error: "Connection lost" });
    await editor.save();
    expect(write.mock.calls).toEqual([["Keep this draft"], ["Keep this draft"]]);
    expect(editor.state).toEqual({ text: "Keep this draft", status: "saved", error: null });
  });

  it("deduplicates repeated blurs of the same pending or saved draft", async () => {
    const response = deferred<void>();
    const write = vi.fn(() => response.promise);
    const editor = new TeamContextDraft(async () => "", write);
    await editor.load();
    editor.edit("One revision");
    const first = editor.save();
    const second = editor.save();
    expect(second).toBe(first);
    response.resolve();
    await first;
    await editor.save();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("finishes an already requested save without publishing to an unmounted card", async () => {
    const response = deferred<void>();
    const editor = new TeamContextDraft(async () => "", () => response.promise);
    await editor.load();
    const listener = vi.fn();
    const unsubscribe = editor.subscribe(listener);
    editor.edit("Save before leaving");
    const saving = editor.save();
    const beforeUnmount = listener.mock.calls.length;
    unsubscribe();
    response.resolve();
    await saving;
    expect(listener).toHaveBeenCalledTimes(beforeUnmount);
    expect(editor.state.status).toBe("saved");
  });

  it("never saves an empty replacement when loading fails, and allows Retry load", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce("Saved brief");
    const write = vi.fn().mockResolvedValue(undefined);
    const editor = new TeamContextDraft(read, write);
    await editor.load();
    expect(editor.state).toMatchObject({ status: "load-error", error: "Connection lost" });
    editor.edit("Accidental replacement");
    await editor.save();
    expect(write).not.toHaveBeenCalled();
    await editor.load();
    expect(editor.state).toEqual({ text: "Saved brief", status: "idle", error: null });
    editor.edit("Intentional replacement");
    await editor.save();
    expect(write).toHaveBeenCalledWith("Intentional replacement");
  });

  it("ignores an older load when mounting starts a newer request", async () => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const editor = new TeamContextDraft(read, async () => {});
    const unsubscribe = editor.subscribe(() => {});
    const oldLoading = editor.load();
    unsubscribe();
    editor.subscribe(() => {});
    const newLoading = editor.load();
    newRead.resolve("Current brief");
    await newLoading;
    editor.edit("Current draft");
    oldRead.resolve("Stale brief");
    await oldLoading;
    expect(editor.state).toMatchObject({ text: "Current draft", status: "idle" });
  });
});
