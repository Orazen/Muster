import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Clock, Mic, Square, Users, X } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { useComposerDraft } from "@/lib/drafts";
import { AgentAvatar } from "./Avatar";
import { ComposerAttachments } from "./ComposerAttachments";
import {
  composeMessage,
  isLongPaste,
  pasteAttachment,
  type Attachment,
} from "@/lib/composer-attachments";
import { MAX_IMAGE_BYTES, uploadImageAttachment } from "@/lib/image-upload";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint } from "@/lib/group-routing";
import { modelAcceptsImages } from "../../server/contracts";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** Room id -> text parked while the room was busy. Lives at module scope so
 * switching rooms (which unmounts the Composer) cannot lose a queued send. */
const queuedSends = new Map<string, string>();

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

export function Composer({
  bot,
  group,
  members,
  onEditLast,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((b) => b.id === approval?.message.from?.botId) ??
      members?.find((b) => b.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "A bot")
    : (bot?.name ?? "The bot");
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    group ? `group:${group.id}` : `bot:${bot?.id ?? ""}`,
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => setAttachments((prev) => [...prev, ...next]),
    [setAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    [setAttachments],
  );

  // ── image gating ──
  // An engine that cannot open an image by path must never be handed one:
  // the paste/drop affordance checks the driver's declared capability, and
  // refusal says so plainly instead of silently degrading what the bot sees.
  // In a room, any vision-capable member unlocks it — routing picks who
  // answers, and a path tag is inert text to anyone who can't read it.
  const engineSupportsImages = useCallback(
    (b?: Bot) => {
      if (!b) return false;
      const inst = state.instances.find((i) => i.instanceId === b.modelSelection.instanceId);
      // Same rule dispatch applies before sending parts (server/contracts
      // modelAcceptsImages): driver capability first, then per-model gating
      // on mixed catalogs so a text-only model can't be handed an image it
      // would 4xx on.
      return modelAcceptsImages(inst?.models, inst?.capabilities, b.modelSelection.model);
    },
    [state.instances],
  );
  const allowImages = group
    ? (members ?? []).some((m) => engineSupportsImages(m))
    : engineSupportsImages(bot);
  const engineLabel = group ? group.name : (bot?.name ?? "This engine");
  // refusals + upload failures for pasted images (drops report through the
  // attachment strip's own notice)
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const attachPastedImages = useCallback(
    async (files: File[]) => {
      let refused = false;
      const results = await Promise.all(
        files.map(async (file): Promise<{ ok: true; chip: Attachment } | { ok: false; message: string }> => {
          if (!allowImages) {
            refused = true;
            return { ok: false, message: file.name };
          }
          if (file.size > MAX_IMAGE_BYTES) {
            return { ok: false, message: `${file.name} is over the image size limit` };
          }
          try {
            return { ok: true, chip: await uploadImageAttachment(file) };
          } catch (e) {
            return {
              ok: false,
              message: `${file.name}: ${e instanceof Error ? e.message : "upload failed"}`,
            };
          }
        }),
      );
      if (refused) {
        setImageNotice(`${engineLabel}'s engine can't read images yet.`);
        return;
      }
      const chips = results.flatMap((r) => (r.ok ? [r.chip] : []));
      const failures = results.flatMap((r) => (r.ok ? [] : [r.message]));
      if (chips.length) addAttachments(chips);
      setImageNotice(failures.length ? failures.join(" ") : null);
    },
    [allowImages, engineLabel, addAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // grow the textarea with its content (capped by max-h in the className)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    setText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // Rooms hold one message client-side while a member speaks; it auto-sends
  // the moment the room settles. 1:1 sends go straight to the server even
  // mid-turn — the harness queues them (steer-queue), so the message shows
  // in the transcript immediately with a queued affordance.
  const [queued, setQueued] = useState<string | null>(() =>
    group ? (queuedSends.get(group.id) ?? null) : null,
  );
  // The queued text used to live only in this component's state, so
  // switching rooms mid-turn unmounted it into thin air. Parking it in a
  // module-level map keyed by room id keeps it across remounts until the
  // settle effect flushes it (or the user navigates away for good — same
  // lifetime as the draft store, minus restarts).
  const parkQueued = (value: string | null) => {
    setQueued(value);
    if (!group) return;
    if (value) queuedSends.set(group.id, value);
    else queuedSends.delete(group.id);
  };
  // a chip on its own is a message: the send control has to appear for it
  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const send = () => {
    const t = composeMessage(text, attachments);
    if (!t) return;
    if (busy && group) {
      parkQueued(t);
      setText("");
      setAttachments([]);
      return;
    }
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: t });
      track("message_sent", { room: true });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, text: t });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy });
    }
    setText("");
    setAttachments([]);
  };
  useEffect(() => {
    if (!busy && queued && group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: queued });
      track("message_sent", { room: true, queued: true });
      parkQueued(null);
    }
  }, [busy, queued, group, dispatch]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      // ogb.d.ts declares text as an optional string, so truthiness is the
      // whole contract — no representation sniffing needed.
      if (line.text) {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  return (
    <div className="px-5 pb-5 pt-2">
      {speechError && (
        <div className="mx-auto mb-2 max-w-[900px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="relative mx-auto max-w-[900px]">
        {queued && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Queued — sends when {busyName} finishes: “{queued}”
            </span>
            <button
              onClick={() => setQueued(null)}
              aria-label="Discard queued message"
              className="rounded p-0.5 hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {pickerOpen && (
          <div
            role="listbox"
            aria-label="Tag a bot"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {peer.bot ? (
                  <AgentAvatar
                    character={peer.bot.character}
                    color={peer.bot.color}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">{peer.bot ? "Agent" : "Room"}</span>
              </button>
            ))}
          </div>
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          allowImages={allowImages}
          engineLabel={engineLabel}
          externalNotice={imageNotice}
          onDismissExternalNotice={() => setImageNotice(null)}
        />
        {/* Gaia composer: rounded bubble-container, hairline ring, bg-inset,
            accent border while focused (see chat/message-bubble.css) */}
        <div className="muster-composer flex items-end gap-2 py-2.5 pl-4 pr-2.5">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            // A screenshot paste arrives as clipboard FILES, not text — route
            // it before the text branch can swallow the event.
            const imageFiles = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (imageFiles.length) {
              e.preventDefault();
              void attachPastedImages(imageFiles);
              return;
            }
            // a wall of text becomes a chip instead of burying the input
            const pasted = e.clipboardData.getData("text/plain");
            if (!isLongPaste(pasted)) return;
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== end) {
              setText(`${text.slice(0, start)}${text.slice(end)}`);
              setCaret(start);
            }
            setAttachments((prev) => [...prev, pasteAttachment(pasted)]);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          disabled={Boolean(approval)}
          placeholder={
            approval
              ? "Answer the approval above to continue"
              : recording
              ? "Listening…"
              : busy
                ? group
                  ? `${busyName} is working — Enter queues your message`
                  : `${busyName} is working — sends when this turn finishes`
                : group
                  ? `Message ${group.name} — ${groupComposerHint(group, members ?? [])}`
                  : `Message ${bot?.name ?? ""}`
          }
          aria-label={`Message ${group ? group.name : (bot?.name ?? "")}`}
          className="max-h-40 w-full resize-none self-center bg-transparent py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {busy && (
          <button
            onClick={() => {
              if (group) dispatch({ type: "interruptGroup", groupId: group.id });
              else if (bot) dispatch({ type: "interrupt", botId: bot.id });
            }}
            aria-label="Stop this turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!busy && !hasContent && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? "Stop dictation" : "Start dictation"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        {hasContent && (
          <button
            onClick={send}
            aria-label={busy ? "Queue message" : "Send message"}
            title={busy ? "Sends when the current turn finishes" : "Send"}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full text-white",
              busy
                ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                : "bg-accent muster-send-glow hover:brightness-110",
            )}
          >
            {busy ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
