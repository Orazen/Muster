import { Component, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JobReceipt } from "../../server/receipts";
import {
  AlertTriangle,
  ReceiptText,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bug,
  Clock,
  Copy,
  Crown,
  Folder,
  Globe,
  Loader2,
  Monitor,
  Pencil,
  RefreshCw,
  Search,
  Square,
  Target,
  Webhook,
  X,
} from "lucide-react";

import { ChatFindBar } from "./ChatFindBar";
import { ConversationHeader } from "./ConversationHeader";
import { TaskUsageStats } from "./TaskUsageStats";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { costCaption, formatTokens, formatUsd, usageChip } from "@/lib/usage";
import {
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { AgentAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { showWorkingDots } from "@/lib/turn-tail";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageBody } from "./MessageBody";
import { CompactionDivider } from "./CompactionDivider";
import { PrivacyNotice } from "./PrivacyNotice";
import { OptionCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { TimelineStrip } from "./TimelineStrip";
import { ConnectorCard } from "./ConnectorCard";
import { ModelPicker } from "./ModelPicker";
import { RenameTitle } from "./RenameTitle";
import { TaskPicker } from "./TaskPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { useFocusMessage } from "@/lib/focus-message";
import { webhookMessageView } from "@/lib/webhook-message";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** GAIA iMessage grouping (vendored from gaia-ui's message-bubble):
 * consecutive same-role text bubbles read as one run — the first tightens
 * its stacking-side corner, the last carries the tail, middles tighten both.
 * Any other row kind (tool chip, card, screen) breaks the run; a run of one
 * keeps the full round bubble, so it maps to nothing here. */
function bubbleRunPositions(messages: Message[]): Map<string, "first" | "middle" | "last"> {
  const out = new Map<string, "first" | "middle" | "last">();
  let run: Message[] = [];
  const flush = () => {
    run.forEach((m, i) => {
      if (run.length === 1) return;
      if (i === 0) out.set(m.id, "first");
      else if (i === run.length - 1) out.set(m.id, "last");
      else out.set(m.id, "middle");
    });
    run = [];
  };
  for (const m of messages) {
    if (m.kind === "text") run.push(m);
    else flush();
  }
  flush();
  return out;
}

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="flex justify-center py-3">
      <span className="rounded-full bg-raised/50 px-3 py-1 text-[11px] font-medium text-ink-secondary">
        {dayLabel(at)} · {formatTime(at)}
      </span>
    </div>
  );
}

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy message"
      title="Copy message"
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** Live extended thinking: shimmer label + collapsible reasoning text.
 * Ephemeral — rendered only while the turn runs, dropped when it settles. */
function ThinkingStrip({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [text, open]);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] min-w-[200px]">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] hover:bg-raised/40"
        >
          <Brain size={13} className="text-ink-secondary" />
          <span className={cn(active ? "thinking-shimmer animate-shimmer" : "text-ink-secondary")}>
            {active ? "Thinking…" : "Thought process"}
          </span>
          <ChevronDown size={12} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div
            ref={tailRef}
            className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-hairline/30 bg-panel px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary"
          >
            {text}
          </div>
        ) : (
          active && (
            <div className="mt-0.5 truncate pl-6 text-[12px] text-ink-secondary/70">
              {text.slice(-120).split("\n").pop()}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-2xl border border-hairline/40 bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-danger/15">
            <AlertTriangle size={12} className="text-danger" />
          </span>
          <span className="text-[13px] font-medium text-ink">Something didn't go through</span>
        </div>
        <div className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{message}</div>
        <div className="mt-2.5 flex items-center gap-2">
          {setupInstance &&
          !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
            <EngineSetup instance={setupInstance} className="text-ink-secondary" />
          ) : (
            onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
              >
                <RefreshCw size={12} /> Try again
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  runPosition,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  /** position in a run of consecutive same-role text bubbles (GAIA grouping) */
  runPosition?: "first" | "middle" | "last";
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
}) {
  const { state, dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const via = !user && message.kind === "text" ? message.via : undefined;
  const viaInstance = via ? state.instances.find((i) => i.instanceId === via.instanceId) : undefined;
  const text = message.text ?? "";
  const webhookView = user ? webhookMessageView(text) : null;
  const visibleText = webhookView?.task ?? text;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing && !webhookView) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group animate-msg-in flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full flex-col gap-1.5", user ? "items-end" : "items-start")}>
        <div
          className={cn(
            "muster-bubble min-w-0 max-w-[88%] rounded-2xl text-[15px] leading-relaxed sm:max-w-[80%]",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "muster-from-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "muster-from-bot px-4 py-2.5 text-ink",
            runPosition && !webhookView ? `muster-${runPosition}` : null,
            // GAIA's tail rides only the last bubble of a run; single
            // messages keep the full round bubble with its tail.
            !webhookView && (!runPosition || runPosition === "last") ? "muster-tail" : null,
          )}
          title={new Date(message.at).toLocaleString()}
        >
          {user && webhookView ? (
            <div className="min-w-0 max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>Webhook task</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">View event payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                <MessageBody text={text} />
              </div>
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text}>
              <MessageBody text={text} markdown />
            </MessageBoundary>
          )}
        </div>
        <div className={cn("conversation-message-actions flex max-w-full flex-wrap items-center gap-0.5", user && "justify-end")}>
          {user && message.kind === "text" && !webhookView && !bot.busy && (
            <button onClick={onStartEdit} aria-label="Edit message" title="Edit message"
              className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100">
              <Pencil size={14} />
            </button>
          )}
          {user && <CopyButton text={visibleText} />}
          {!user && (<>
            <CopyButton text={text} />
            {message.kind === "text" && (
              <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} />
            )}
            {isLastBotText && !bot.busy && onRegenerate && (
              <button
                onClick={onRegenerate}
                aria-label="Regenerate response"
                title="Regenerate response"
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </>)}
          {message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
          <span className="px-1 text-[11px] tabular-nums text-ink-secondary/70">{formatTime(message.at)}</span>
        </div>
        {/* provenance chip: show the harness instead of hiding it — which
            engine + model actually said this (routing visibility pattern).
            The LAST bot answer keeps it visible while idle, so the routing
            fact survives without a hover; history turns stay hover-only. */}
        {via && (
          <span
            className={cn(
              "max-w-full pb-1 text-[10.5px] tabular-nums text-ink-secondary/70 transition-opacity [overflow-wrap:anywhere]",
              isLastBotText && !bot.busy ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            title={via.effort ? `${viaInstance?.displayName ?? via.instanceId} · effort ${via.effort}` : viaInstance?.displayName ?? via.instanceId}
          >
            {via.model}
            {viaInstance && viaInstance.displayName !== via.model ? ` · ${viaInstance.displayName}` : ""}
            {via.effort ? ` · ${via.effort}` : ""}
          </span>
        )}
      </div>
      {/* busy-gated so a flag stranded by a server restart shows nothing */}
      {user && message.queued && bot.busy && (
        <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>Queued — sends when this turn finishes</span>
        </div>
      )}
      <ReactionChips threadId={bot.threadId} message={message} align={user ? "right" : "left"} />
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <AgentAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
      </div>
    </div>
  );
}

/** Status mark for one tool run — shared by the chip and the group header. */
function ToolStatusMark({ tool }: { tool: NonNullable<Message["tool"]> }) {
  const failed = tool.ok === false;
  if (tool.ok === undefined) return <Loader2 size={13} className="animate-spin" />;
  return failed ? <X size={13} /> : <Check size={13} className="text-success" />;
}

/** gaia-ui-style collapsed run: consecutive tool calls become one
 * "Used N tools" section — stacked status marks, expandable to the
 * individual chips. A long agent turn reads as one calm line instead of a
 * wall of chips. */
function ToolRunGroup({ items }: { items: Message[] }) {
  const [open, setOpen] = useState(false);
  const running = items.filter((m) => m.tool?.ok === undefined).length;
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline/40 bg-panel">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
        >
          <span className="flex -space-x-1.5">
            {items.slice(-4).map((m) => (
              <span key={m.id} className="rounded-full border border-hairline/40 bg-panel p-1">
                {m.tool ? <ToolStatusMark tool={m.tool} /> : null}
              </span>
            ))}
          </span>
          <span>
            Used {items.length} tools{running > 0 ? ` · ${running} running` : ""}
          </span>
          <ChevronDown size={14} className={cn("ml-auto transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div className="flex flex-col gap-1 border-t border-hairline/40 p-2">
            {items.map((m) => (
              <ActivityChip key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type RenderItem = { msg: Message } | { group: Message[] };

/** Collapse consecutive plain tool-run messages into single groups. Bot⇄bot
 * comm chips, errors, and everything else pass through untouched. */
function groupToolRuns(messages: Message[]): RenderItem[] {
  const out: RenderItem[] = [];
  let buf: Message[] = [];
  const flush = () => {
    if (buf.length > 1) out.push({ group: buf });
    else if (buf.length === 1) out.push({ msg: buf[0] });
    buf = [];
  };
  for (const msg of messages) {
    if (msg.kind === "activity" && msg.tool && !msg.comm && !msg.tool.name.startsWith("error:")) buf.push(msg);
    else {
      flush();
      out.push({ msg });
    }
  }
  flush();
  return out;
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  // markdown re-parses on a deferred value: when tokens arrive faster than
  // the parser keeps up, React lags the parse instead of janking the frame
  const deferred = useDeferredValue(text);
  return (
    <div className="flex w-full justify-start">
      <div className="muster-bubble muster-from-bot muster-tail max-w-[70%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <MessageBoundary fallbackText={deferred}>
          <ChatMarkdown text={deferred} streaming />
        </MessageBoundary>
        <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  editingId,
  lastBotTextId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
}: {
  bot: Bot;
  messages: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
}) {
  const { dispatch } = useStore();
  const runPositions = useMemo(() => bubbleRunPositions(messages), [messages]);
  // The one card letter hotkeys (A–F) may answer: the newest pending option
  // card in the mounted transcript. Windowing makes that the honest scope —
  // a card scrolled out of the visible tail can't be keyboard-driven.
  const activeOptionsId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.kind === "options" && m.card && !m.card.dismissed && !m.card.answered && !(m.card.requestId && m.card.tool)) {
        return m.id;
      }
    }
    return undefined;
  }, [messages]);
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <AgentAvatar character={bot.character} color={bot.color} state="idle" size={64} motion="none" motionKey={0} />
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {bot.description || "Send a message to start the conversation."}
          </div>
        </div>
      )}
      {(() => {
        let prevMsg: Message | undefined;
        return groupToolRuns(messages).map((item) => {
          if ("group" in item) {
            const first = item.group[0];
            const groupNewDay = !prevMsg || new Date(prevMsg.at).toDateString() !== new Date(first.at).toDateString();
            prevMsg = item.group[item.group.length - 1];
            return (
              <div key={first.id} className="contents">
                {groupNewDay && <DaySeparator at={first.at} />}
                <ToolRunGroup items={item.group} />
              </div>
            );
          }
          const m = item.msg;
          const newDay = !prevMsg || new Date(prevMsg.at).toDateString() !== new Date(m.at).toDateString();
          prevMsg = m;
        const row = (() => {
          switch (m.kind) {
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options":
              // a live permission ask gets the approval box; questions and
              // the onboarding quiz keep the list card
              return m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={bot} message={m} />
              ) : (
                <OptionCard botId={bot.id} message={m} hotkeys={m.id === activeOptionsId} />
              );
            case "activity":
              // a failed turn is an error, not a tool run — render it as one
              return m.tool?.name.startsWith("error:") ? (
                <ErrorRow
                  message={m.tool.name.slice(6).trim()}
                  onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                  setupInstance={m.tool.setup ? engine : undefined}
                />
              ) : (
                <ActivityChip message={m} />
              );
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            case "compaction":
              // The model-context summary marker — quiet, expandable, and
              // proof that nothing was deleted (scrolling still reaches it).
              return m.compaction ? <CompactionDivider data={m.compaction} /> : null;
            case "privacy":
              return m.privacy ? <PrivacyNotice privacy={m.privacy} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  runPosition={runPositions.get(m.id)}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
        })
      })()}
    </>
  );
});

/** Shared header icon-toggle: quiet circle at rest, accent-tinted when its
 * panel is open — one grammar for every icon button in the titlebar. */
const iconToggleClasses =
  "flex size-7 items-center justify-center rounded-full transition-colors";

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);

  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). The boundary is anchored per bot+task; a
  // render-phase reset re-tails it on switch so the old thread's boundary
  // never flashes into the new one. Everything derived below (lastBotTextId,
  // lastUserMessage, working dots) stays computed from the FULL list.
  const transcriptKey = `${bot.id}:${bot.threadId}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(messages.length),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );
  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [bot.id, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, follow]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    const start = expandWindowStart(startIndex);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(messages.length), end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  // on Windows the frameless window's min/max/close overlay sits at the
  // top-right: the header becomes the drag strip and clears room for it
  const isWin = window.ogb?.platform === "win32";
  const [receiptOpen, setReceiptOpen] = useState(false);
  const receiptButtonRef = useRef<HTMLButtonElement>(null);
  const [watermark, setWatermark] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // SAFETY: tier endpoint is optional; a failed read just hides the badge.
        const r = await fetch("/api/tier");
        if (!r.ok) return;
        // SAFETY: wire JSON is untyped; only the boolean flag is consumed.
        const data: unknown = await r.json();
        // SAFETY: single-line container-shape assertion for the tier payload.
        const raw = (data ?? {}) as { watermark?: unknown };
        if (alive) setWatermark(raw.watermark === true);
      } catch {
        /* badge stays hidden offline */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="glass-shell-main relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <ConversationHeader windows={isWin}
        identity={<>
          <button
            onClick={() => dispatch({ type: "toggleSettings" })}
            className="flex shrink-0 items-center rounded-lg p-0.5 hover:bg-raised/50"
            title="Bot settings"
          >
            <AgentAvatar
              character={bot.character}
              color={bot.color}
              state={stateForBot({ ...bot, messages })}
              size={28}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </button>
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="min-w-0 truncate text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
          />
          {bot.chiefOfStaff && (
            <span title="Chief of Staff" className="flex shrink-0 items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Crown size={11} /><span className="conversation-chief-label">Chief of Staff</span>
            </span>
          )}
          {watermark && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary" title="Muster Free — upgrade to Pro to remove">
              Free
            </span>
          )}
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </>}
        interrupt={bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 text-[13px] font-medium text-danger hover:bg-danger/20"
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              Stop
            </button>
          )}
        primary={<>
          <div className="conversation-task-slot"><TaskPicker bot={bot} /></div>
          <div className="conversation-model-slot"><ModelPicker bot={bot} /></div>
        </>}
        tools={<>
          <UsageChip bot={bot} />
          <WorkingFolderChip bot={bot} />
          <button
            ref={receiptButtonRef}
            onClick={() => setReceiptOpen(true)}
            aria-label="Job receipt"
            className={cn(iconToggleClasses, receiptOpen ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
            title="Job receipt — proof of work for this task"
          >
            <ReceiptText size={17} /><span className="conversation-tool-label">Receipt</span>
          </button>
          <CallButton bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            aria-label="Bot's computer"
            aria-pressed={state.computerOpen}
            className={cn(iconToggleClasses, state.computerOpen ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
            title="Bot's computer"
          >
            <Monitor size={17} /><span className="conversation-tool-label">Computer</span>
          </button>
          <button
            onClick={() => dispatch({ type: "toggleBrowserPanel" })}
            aria-label="Browser"
            aria-pressed={state.browserPanelOpen}
            className={cn(iconToggleClasses, state.browserPanelOpen ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
            title="Browser — open a page preview for this bot"
          >
            <Globe size={17} /><span className="conversation-tool-label">Browser</span>
          </button>
          <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in conversation"
            aria-pressed={findOpen}
            className={cn(iconToggleClasses, findOpen ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
            title="Find in conversation (⌘F)"
          >
            <Search size={17} /><span className="conversation-tool-label">Search</span>
          </button>
          <button
            onClick={() => dispatch({ type: "toggleInspector" })}
            aria-label="Inspector"
            aria-pressed={state.inspectorOpen}
            className={cn(iconToggleClasses, state.inspectorOpen ? "bg-accent/10 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
            title="Inspector — runtime events and raw protocol for this thread"
          >
            <Bug size={17} /><span className="conversation-tool-label">Inspector</span>
          </button>
        </>}
      />

      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}
      {receiptOpen && <JobReceiptModal key={`${bot.id}:${bot.threadId}`} bot={bot} onClose={() => setReceiptOpen(false)} onReturnFocus={() => receiptButtonRef.current?.focus()} />}

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume) setBottomFollow(true);
        }}
      >
        <div
          className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4"
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          {hiddenCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show earlier messages ({hiddenCount} more)
              </button>
            </div>
          )}
          <MessagesList
            bot={bot}
            messages={windowedMessages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show later messages ({laterCount} more)
              </button>
            </div>
          )}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {reasoning && bot.busy && <ThinkingStrip text={reasoning} active={!streaming} />}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            showWorkingDots(bot.busy, streaming, messages.at(-1)) && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  {/* OpenManus-style step mark: [→] says "in progress" the
                      way a plan tool renders it, the shimmer says it's alive
                      — no bouncing dots */}
                  <span
                    className="flex size-5 items-center justify-center rounded-md border border-hairline bg-panel font-mono text-[11px] leading-none text-live"
                    aria-hidden="true"
                  >
                    →
                  </span>
                  <span className="thinking-shimmer text-[13px] font-medium">Working</span>
                  <WorkingTimer since={lastUserMessage?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      {/* Execution timeline: what the bot just did / is doing, only while
          a turn runs — idle renders nothing, so no layout shift. */}
      <TimelineStrip bot={bot} messages={messages} />
      <GoalBanner bot={bot} />
      <Composer
        key={bot.id}
        bot={bot}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />

    </main>
  );
}

/** The visible plan loop: while a goal is running on this thread it shows
 * "Goal · round N/M · <text>" with a Stop, so autonomy is something the
 * user watches and can halt — never a hidden loop. The round pips borrow
 * OpenManus's plan-step marks: ✓ done, → running, blank still to come, so
 * progress reads at a glance without parsing numbers. */
function GoalBanner({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const goal = state.goals.find((g) => g.botId === bot.id && g.status === "active");
  if (!goal) return null;
  // one pip per round, capped so a 40-round goal can't stretch the strip
  const pipCount = Math.min(goal.maxRounds, 12);
  const currentRound = Math.min(goal.rounds + 1, goal.maxRounds);
  return (
    <div className="animate-pop-in flex items-center gap-2 border-t border-hairline/40 bg-raised/60 px-4 py-2 text-[12.5px]">
      <Target size={13} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="shrink-0 font-medium tabular-nums">
        Goal · round {currentRound}/{goal.maxRounds}
      </span>
      {pipCount > 1 && (
        <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
          {Array.from({ length: pipCount }, (_, i) => {
            const round = i + 1;
            const done = round <= goal.rounds;
            const active = round === currentRound;
            return (
              <span
                key={round}
                className={cn(
                  "flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[8px] font-bold leading-none",
                  done
                    ? "border-success/50 bg-success/15 text-success"
                    : active
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-hairline text-transparent",
                )}
              >
                {done ? "✓" : active ? "→" : "·"}
              </span>
            );
          })}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ink-secondary" title={goal.text}>
        {goal.text}
      </span>
      <button
        onClick={() => dispatch({ type: "stopGoal", goalId: goal.id })}
        className="shrink-0 rounded-md px-2 py-0.5 text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
      >
        Stop
      </button>
    </div>
  );
}

/** What the open task has spent — quiet until the first turn settles.
 * Click opens the bot's settings, where the Usage card has the breakdown. */
function UsageChip({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const text = usage ? usageChip(usage) : "";
  if (!usage || !text) return null;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const detail = [
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`,
    usage.costUsd != null ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      onClick={() => dispatch({ type: "toggleSettings", open: true })}
      className="rounded-full px-2 py-1 text-[12px] tabular-nums text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
      title={detail}
    >
      {text}
    </button>
  );
}

/** The folder this task's tools run in — an icon-only whisper unless it's
 * somewhere other than home; the full path lives in the hover title, not
 * the titlebar (a raw UUID stretched the header for nothing). */
function WorkingFolderChip({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const folder = task?.cwd === undefined ? bot.cwd : (task.cwd ?? undefined);
  if (!folder) return null;
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  // Auto-pinned workspaces get machine-assigned ids for names — an opaque
  // uuid string is noise in the titlebar, so those show the icon only.
  const meaningfulName = !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
  return (
    <button
      onClick={() => dispatch({ type: "toggleSettings", open: true })}
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
      title={`Working folder: ${folder}`}
    >
      <Folder size={13} />
      {meaningfulName && <span className="hidden max-w-[120px] truncate font-mono lg:inline">{name}</span>}
    </button>
  );
}

/** Proof-of-work card for the active task: who, what, how long, how much. */
function JobReceiptModal({ bot, onClose, onReturnFocus }: { bot: Bot; onClose: () => void; onReturnFocus: () => void }) {
  const [copyState, setCopyState] = useState<"idle" | "busy" | "copied" | "error">("idle");
  const [state, setState] = useState<{ loading: boolean; text: string | null; receipt: JobReceipt | null; error: string | null }>({
    loading: true,
    text: null,
    receipt: null,
    error: null,
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // SAFETY: fetch may fail on a closed server; guarded by catch below.
        const r = await fetch(`/api/receipts/${encodeURIComponent(bot.id)}/${encodeURIComponent(bot.threadId)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // SAFETY: wire JSON is untyped; coerce the one field we render to text.
        const data: unknown = await r.json();
        if (!alive) return;
        // The server returns one receipt and its text from the same snapshot.
        // SAFETY: this same-origin API returns the typed JobReceipt alongside text; missing receipt remains null.
        const raw = (data ?? {}) as { text?: unknown; receipt?: JobReceipt };
        // SAFETY: single-line assertion on the parsed record shape above.
        const text = raw.text == null ? null : String(raw.text);
        setState({ loading: false, text, receipt: raw.receipt ?? null, error: null });
      } catch (e) {
        if (alive) setState({ loading: false, text: null, receipt: null, error: String(e instanceof Error ? e.message : e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [bot.id, bot.threadId]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-lg overflow-y-auto rounded-2xl p-5"
        onCloseAutoFocus={(event) => { event.preventDefault(); onReturnFocus(); }}>
        <DialogHeader className="mb-4 pr-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ReceiptText size={17} className="text-accent" />Job receipt
          </DialogTitle>
          <DialogDescription>Snapshot of recorded work for {bot.name}.</DialogDescription>
        </DialogHeader>
        {state.receipt && <TaskUsageStats usage={state.receipt.turns > 0 || state.receipt.tokensIn + state.receipt.tokensOut > 0
          ? { input: state.receipt.tokensIn, output: state.receipt.tokensOut, turns: state.receipt.turns, costUsd: state.receipt.costUsd }
          : undefined} />}
        {state.loading && <p className="mt-4 text-sm text-ink-secondary" role="status">Loading receipt…</p>}
        {state.error && <p className="mt-4 text-sm text-danger" role="alert">Couldn't build a receipt: {state.error}</p>}
        {state.text && (
          <>
            <pre className="mt-4 max-h-[35dvh] overflow-auto whitespace-pre-wrap rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink [overflow-wrap:anywhere]">
              {state.text}
            </pre>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                disabled={copyState === "busy"}
                onClick={async () => {
                  setCopyState("busy");
                  try {
                    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                    await navigator.clipboard.writeText(state.text ?? "");
                    setCopyState("copied");
                  } catch {
                    setCopyState("error");
                  }
                }}
                className="min-h-10 rounded-lg border border-hairline/60 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-60"
              >
                {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed — try again" : copyState === "busy" ? "Copying…" : "Copy receipt"}
              </button>
              <ReceiptShareButton botId={bot.id} threadId={bot.threadId} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Share this receipt as a public proof-of-work page (/r/<token>), copied
 * to the clipboard on success. */
function ReceiptShareButton({ botId, threadId }: { botId: string; threadId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "copied" | "copy-error" | "error">("idle");
  const [url, setUrl] = useState<string | null>(null);
  async function share(): Promise<void> {
    setState("busy");
    try {
      let sharedUrl = url;
      if (!sharedUrl) {
        const r = await fetch("/api/receipts/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ botId, threadId }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // SAFETY: the same-origin share route returns a local receipt URL in its 201 response.
        const body = (await r.json()) as { url: string };
        sharedUrl = `${window.location.origin}${body.url}`;
        setUrl(sharedUrl);
      }
      try {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(sharedUrl);
        setState("copied");
      } catch {
        // Publishing succeeded. Keep the link available for manual copying.
        setState("copy-error");
      }
    } catch {
      setState("error");
    }
  }
  return (
    <>
    <button
      onClick={() => void share()}
      disabled={state === "busy"}
      className="min-h-10 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-app hover:opacity-90 disabled:opacity-40"
      title="Publish a public proof-of-work link for this job"
    >
      {state === "busy" ? "Sharing…" : state === "copied" ? "Link copied" : state === "error" ? "Sharing failed — retry" : url ? "Copy link" : "Share public link"}
    </button>
    {state === "copy-error" && url && <label className="w-full text-xs text-ink-secondary" role="status">
      Link created. Copy it below:
      <input readOnly value={url} aria-label="Public receipt link" onFocus={(event) => event.currentTarget.select()}
        className="mt-2 w-full min-w-0 rounded-lg border border-hairline bg-inset px-3 py-2 text-sm text-ink" />
    </label>}
    </>
  );
}
