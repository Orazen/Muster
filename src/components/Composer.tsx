import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AudioLines, Clock, Mic, Square, Target, Users, X } from "lucide-react";
import { useStore, useStopCleanup, visibleMessages, api, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { startCall } from "@/lib/call";
import { getDictation } from "@/lib/dictation";
import { markVoiceFirstRunSeen, voiceFirstRunSeen } from "@/lib/voice-first-run";
import { useComposerDraft } from "@/lib/drafts";
import { AgentAvatar } from "./Avatar";
import { ComposerAttachments } from "./ComposerAttachments";
import { VoiceFirstRunCard } from "./VoiceFirstRunCard";
import {
  composeMessage,
  isLongPaste,
  pasteAttachment,
  type Attachment,
} from "@/lib/composer-attachments";
import { commandQueryAt, matchCommands, type ComposerCommand, type ComposerCommandId } from "@/lib/composer-commands";
import { MAX_IMAGE_BYTES, uploadImageAttachment } from "@/lib/image-upload";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint } from "@/lib/group-routing";
import { modelAcceptsImages, type SteerQueueSnapshot } from "../../server/contracts";
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

/** The 1:1 follow-up queue as a strip above the composer: every send the
 * busy bot is holding, each one removable, all of them behind the
 * hold/resume chip — OpenMuse's multi-item queue adapted onto Muster's
 * persisted messages (the same words still live in the transcript above).
 * Pure by design: it renders the server's snapshot and never acts on its
 * own, so server-rendered tests can pin the markup without a store. */
export function QueuedSendStrip({
  queue,
  busyName,
  onRemove,
  onSetPaused,
}: {
  queue: SteerQueueSnapshot | null;
  busyName: string;
  onRemove: (messageId: string) => void;
  onSetPaused: (paused: boolean) => void;
}) {
  if (!queue || !queue.items.length) return null;
  const { items, paused } = queue;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-hairline/40 bg-panel text-[12.5px] text-ink-secondary">
      <div className="flex items-center gap-2 border-b border-hairline/30 px-3 py-2">
        <Clock size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {paused
            ? `Queue paused — ${items.length} ${items.length === 1 ? "message holds" : "messages hold"}, nothing sends until you resume`
            : `Queued — sends when ${busyName} finishes · ${items.length}`}
        </span>
        <button
          onClick={() => onSetPaused(!paused)}
          aria-label={paused ? "Resume queued messages" : "Hold the queue"}
          title={paused ? "Release the hold — the queue drains as one turn" : "Hold the queue — nothing sends until you resume"}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
            paused
              ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
              : "border-hairline/40 hover:bg-raised hover:text-ink",
          )}
        >
          {paused ? "Resume queued messages" : "Hold"}
        </button>
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.messageId} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{item.text}</span>
            <button
              onClick={() => onRemove(item.messageId)}
              aria-label="Remove queued message"
              title="Take this message off the queue"
              className="shrink-0 rounded p-0.5 hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const { action: stopAction } = useStopCleanup(group ? undefined : bot?.id);
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
  // Vellum's voice-mode entry: a composer control that opens the spoken
  // conversation (first tap shows the one-time welcome card).
  const [voiceCardOpen, setVoiceCardOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  // ── /command picker (U4): the composer's own actions, typed. `command`
  // is null in rooms and after an @ — every command is a bot-scoped action,
  // and the two pickers never share the caret. ──
  const command = bot && !group && !mention ? commandQueryAt(text, caret) : null;
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

  useEffect(() => setHighlight(0), [mention?.start, mention?.query, command?.start, command?.query]);

  // grow the textarea with its content (capped by max-h in the className)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Reply-quote handshake: ChatView prefills this thread's draft (appendDraft)
  // and asks for focus. The draft store notifies the hook, so by the time this
  // runs the quoted text is already in the textarea — only the caret is ours.
  const composerThreadId = group ? `group:${group.id}` : `bot:${bot?.id ?? ""}`;
  useEffect(() => {
    const onFocus = (event: Event) => {
      // SAFETY: the only emitter is ChatView's reply handler, which always
      // attaches `{ threadId }`; an alien event without detail fails the
      // guard below and is ignored.
      const detail = (event as CustomEvent<{ threadId: string }>).detail;
      if (detail?.threadId !== threadId) return;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    };
    window.addEventListener("muster:composer-focus", onFocus);
    return () => window.removeEventListener("muster:composer-focus", onFocus);
  }, [threadId, composerThreadId]);

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
  // ── 1:1 follow-up queue (S2): the server's steer-queue, as a strip ──
  // Rooms keep their single parked strip below; a 1:1 thread shows every
  // send the busy bot is holding — each removable, held and resumed
  // together behind the chip. The snapshot is the ONLY queue state the
  // strip renders: what drained (or what a restart stranded) is absent
  // rather than re-promised. Refetches ride the same SSE patches that
  // update the transcript's queued flags: any flag-count change or busy
  // edge means the queue itself may have moved.
  const [queue, setQueue] = useState<SteerQueueSnapshot | null>(null);
  const botId = bot?.id;
  const isRoom = Boolean(group);
  const queuedFlags = bot && !group ? bot.messages.filter((m) => m.role === "user" && m.queued).length : 0;
  const refreshQueue = useCallback(async () => {
    if (isRoom || !botId) return;
    try {
      // SAFETY: GET /api/bots/:id/queue always answers {queue} — the route's
      // only other reply shapes are 4xx errors, which api() throws on.
      const body = (await api(`/api/bots/${botId}/queue`)) as { queue: SteerQueueSnapshot | null };
      setQueue(body.queue);
    } catch {
      // the strip is advisory: keep the last snapshot instead of flicker
    }
  }, [botId, isRoom]);
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue, queuedFlags, busy]);
  const removeQueued = async (messageId: string) => {
    if (!botId) return;
    try {
      // SAFETY: DELETE /api/bots/:id/queue/:messageId answers {queue} on
      // success; 404 "not queued" and other 4xxs are thrown by api().
      const body = (await api(`/api/bots/${botId}/queue/${messageId}`, { method: "DELETE" })) as {
        queue: SteerQueueSnapshot | null;
      };
      setQueue(body.queue);
    } catch {
      void refreshQueue(); // already drained elsewhere — resync, don't lie
    }
  };
  const holdQueue = async (paused: boolean) => {
    if (!botId) return;
    try {
      // SAFETY: PATCH /api/bots/:id/queue answers {queue} on success; a
      // 400/404 reply is a 4xx, which api() throws before this runs.
      const body = (await api(`/api/bots/${botId}/queue`, {
        method: "PATCH",
        body: JSON.stringify({ paused }),
      })) as { queue: SteerQueueSnapshot | null };
      setQueue(body.queue);
    } catch {
      void refreshQueue();
    }
  };
  // a chip on its own is a message: the send control has to appear for it
  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  // Goal mode: the next send starts a bounded autonomy loop instead of a
  // single turn. A per-composer toggle, not a persisted setting — the send
  // arrow becomes a target so the user always knows what the click means.
  const [goalMode, setGoalMode] = useState(false);
  const goalArmed = Boolean(bot && !group && goalMode && !busy);
  // Vellum's voice-mode entry: same availability rule as the header call
  // button — a recognizer to hear with and a voice (paid or free) to answer
  // with. First tap shows the one-time welcome card; later taps go straight
  // into the call room.
  const dictationKind = getDictation().kind;
  const voiceSupported =
    dictationKind === "web" || (dictationKind === "native" && capabilities.dictation.available);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- capability probe of a window global, not input shaping
  const freeVoice = typeof window !== "undefined" && "speechSynthesis" in window;
  const voiceModeAvailable = Boolean(bot) && !group && voiceSupported && (Boolean(state.config?.tts?.configured) || freeVoice);
  const startVoiceMode = () => {
    if (!bot) return;
    if (!voiceFirstRunSeen(bot.id)) {
      setVoiceCardOpen(true);
      return;
    }
    track("voice_mode_started", { botId: bot.id });
    startCall(bot.id);
  };
  // ── /command matching: each command gated by the exact rule its button
  // uses (voice: availability probe; goal/new: not while a turn runs;
  // stop: only while one runs). `command` implies bot && !group. ──
  // `satisfies Record<ComposerCommandId, boolean>` is the contract: every
  // command must have an availability rule, and no drift is possible.
  const commandAvailability = {
    voice: voiceModeAvailable,
    goal: !busy,
    new: !busy,
    stop: busy,
    settings: true,
  } satisfies Record<ComposerCommandId, boolean>;
  const commandMatches: Array<ComposerCommand & { available: boolean }> =
    !command || command.start === dismissedAt
      ? []
      : matchCommands(command.query).map((c) => ({ ...c, available: commandAvailability[c.id] }));
  const commandOpen = commandMatches.length > 0;
  const anyPickerOpen = pickerOpen || commandOpen;
  const runCommand = (chosen: (ComposerCommand & { available: boolean }) | undefined) => {
    if (!chosen) return;
    if (!chosen.available) {
      // Consume the key without running: close the menu and keep the text —
      // Enter must never fall through and send "/goal" as literal words.
      setDismissedAt(command?.start ?? null);
      return;
    }
    if (bot) {
      if (chosen.id === "voice") startVoiceMode();
      else if (chosen.id === "goal") setGoalMode(true);
      else if (chosen.id === "new") dispatch({ type: "newTask", botId: bot.id });
      else if (chosen.id === "stop") dispatch({ type: "interrupt", botId: bot.id });
      else if (chosen.id === "settings") dispatch({ type: "toggleSettings", open: true });
    }
    setText("");
    setCaret(0);
    track("composer_command_used", { command: chosen.id });
  };
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
      if (goalArmed) {
        dispatch({ type: "startGoal", botId: bot.id, text: t });
        track("goal_started", { driver: bot.modelSelection?.instanceId });
        setGoalMode(false);
      } else {
        dispatch({ type: "send", botId: bot.id, text: t });
        track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy });
      }
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
        {bot && !group && (
          <QueuedSendStrip
            queue={queue}
            busyName={busyName}
            onRemove={(messageId) => void removeQueued(messageId)}
            onSetPaused={(paused) => void holdQueue(paused)}
          />
        )}
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
        {commandOpen && (
          <div
            role="listbox"
            aria-label="Composer commands"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {commandMatches.map((c, i) => (
              <button
                key={c.id}
                role="option"
                aria-selected={i === highlight}
                disabled={!c.available}
                onClick={() => runCommand(c)}
                onMouseEnter={() => setHighlight(i)}
                title={c.available ? c.hint : `${c.hint} — not available right now`}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                  c.available ? "text-ink" : "cursor-default opacity-40",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{c.label}</span>
                <span className="shrink-0 text-xs text-ink-secondary">/{c.id}</span>
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
              cancelPending={Boolean(stopAction.pending)}
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
        {/* GAIA composer layout (ui.heygaia.io composer, tokens remapped to
            Muster's scale): rounded-3xl inset bubble, input row on top,
            circular toolbar buttons below — context controls left, send
            right. All Muster behavior (drafts, mentions, goal mode, dictation)
            is unchanged; see chat/message-bubble.css for the bubble tokens. */}
        <div className="muster-composer px-1 pt-1 pb-2" data-tour="composer">
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
            if (anyPickerOpen) {
              const rowCount = pickerOpen ? candidates.length : commandMatches.length;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + rowCount) % rowCount);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (pickerOpen) pickMention(candidates[highlight]);
                else runCommand(commandMatches[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt((pickerOpen ? mention?.start : command?.start) ?? null);
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
          className="max-h-40 w-full resize-none bg-transparent px-3 py-3 text-[15px] font-light leading-6 text-ink placeholder:text-ink-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex items-center justify-between px-2 pt-1">
          {/* Left: the voice that joins the conversation (GAIA context-button
              treatment — circular raised chips). */}
          <div className="flex items-center gap-1">
            {voiceModeAvailable && !recording && (
              <button
                onClick={startVoiceMode}
                aria-label="Start voice mode"
                title="Talk out loud with voice mode"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-[filter] hover:brightness-110 active:scale-[0.97]"
              >
                <AudioLines size={16} strokeWidth={2} />
              </button>
            )}
            {!busy && !hasContent && capabilities.dictation.available && (
              <button
                onClick={toggleMic}
                aria-label={recording ? "Stop dictation" : "Start dictation"}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  recording
                    ? "animate-pulse bg-danger/20 text-danger"
                    : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
                title={recording ? "Stop dictation (Esc)" : "Dictate"}
              >
                <Mic size={18} />
              </button>
            )}
            {bot && !group && !busy && (
              <button
                onClick={() => setGoalMode((v) => !v)}
                aria-pressed={goalMode}
                aria-label={goalMode ? "Goal mode on — the next message starts an autonomous loop" : "Goal mode — work toward the next message autonomously"}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  goalMode
                    ? "bg-accent/15 text-accent"
                    : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
                )}
                title={goalMode ? "Goal mode on — the next message becomes a self-driving loop" : "Goal mode — let the bot work toward this on its own"}
              >
                <Target size={16} />
              </button>
            )}
          </div>
          {/* Right: stop (while a turn runs) or the GAIA circular send. */}
          <div className="flex items-center gap-1">
            {busy && (
              <button
                onClick={() => {
                  if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                  else if (bot) dispatch({ type: "interrupt", botId: bot.id });
                }}
                aria-label="Stop this turn"
                disabled={Boolean(stopAction.pending)}
                aria-busy={Boolean(stopAction.pending)}
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink disabled:opacity-50"
                title="Stop"
              >
                <Square size={14} className="fill-current" />
              </button>
            )}
            {hasContent && (
              <button
                onClick={send}
                aria-label={goalArmed ? "Start goal" : busy ? "Queue message" : "Send message"}
                title={goalArmed ? "Start goal loop" : busy ? "Sends when the current turn finishes" : "Send"}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full text-white transition-[filter,background-color]",
                  busy
                    ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                    : "bg-accent muster-send-glow hover:brightness-110",
                )}
              >
                {goalArmed ? <Target size={15} /> : busy ? <Clock size={15} /> : <ArrowUp size={17} />}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
      {bot && !group && (
        <VoiceFirstRunCard
          bot={bot}
          open={voiceCardOpen}
          onDismiss={() => setVoiceCardOpen(false)}
          onStart={() => {
            markVoiceFirstRunSeen(bot.id);
            setVoiceCardOpen(false);
            track("voice_mode_started", { botId: bot.id, firstRun: true });
            startCall(bot.id);
          }}
          onPickVoice={(voice) => dispatch({ type: "updateBot", botId: bot.id, patch: { voice } })}
        />
      )}
    </div>
  );
}
