import { visibleMessages, type Bot, type Message } from "@/state/store";
import type { AgentState } from "@/lib/mascot";

export interface WorkspaceItem {
  bot: Bot;
  title: string;
  detail: string;
  at?: number;
}

export interface WorkspaceSummary {
  decisions: WorkspaceItem[];
  working: WorkspaceItem[];
  replies: WorkspaceItem[];
  available: WorkspaceItem[];
  disconnected: WorkspaceItem[];
}

interface Classification {
  bucket: keyof WorkspaceSummary;
  item: WorkspaceItem;
  avatar: AgentState;
}

function lastKnownStatus(bot: Bot, messages: Message[]): Classification {
  const pending = messages
    .filter((message) => message.kind === "options" && message.card?.requestId
      && !message.card.answered && !message.card.dismissed)
    .sort((a, b) => a.at - b.at)[0];
  if (pending?.card) {
    return {
      bucket: "decisions", avatar: "curious",
      item: {
        bot, title: pending.card.title.trim() || "Decision requested",
        detail: pending.card.subtitle.trim() || "Open chat to review the request.", at: pending.at,
      },
    };
  }
  if (bot.activity === "waiting-on-you") {
    return {
      bucket: "decisions", avatar: "curious",
      item: { bot, title: "Waiting for your decision", detail: "Request details are not loaded. Open chat to check." },
    };
  }

  const last = messages.at(-1);
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.kind === "text" && message.text?.trim()) {
      userIndex = index;
      break;
    }
  }
  const task = messages[userIndex];
  // An explicit activity value is stronger than the legacy busy flag.
  // Waiting, idle and disconnected states must never become active work
  // merely because a stale snapshot still carries busy=true.
  if (bot.activity === "working" || (bot.activity === undefined && bot.busy)) {
    return {
      bucket: "working", avatar: "working",
      item: {
        bot, title: "Working",
        detail: task?.text?.trim() || "A turn is in progress. Open chat to follow it.",
        at: last?.at,
      },
    };
  }

  // This is a new reply to review, not a successful-outcome certificate.
  // Require the visible tail itself to be a settled reply: a later user
  // task, tool event or pending request must not surface an older answer.
  if (!bot.busy && bot.unread && userIndex >= 0 && userIndex < messages.length - 1
    && last?.role === "bot" && last.kind === "text" && last.text?.trim()) {
    return {
      bucket: "replies", avatar: "notifying",
      item: { bot, title: "New reply", detail: last.text.trim(), at: last.at },
    };
  }

  return {
    bucket: "available", avatar: "idle",
    item: {
      bot,
      title: bot.busy ? "Status updating" : "Available",
      detail: bot.busy ? "Activity signals disagree. Open chat to check."
        : last?.kind === "activity" && last.tool?.ok === false
          ? "The last activity reported an error. Open chat to check."
          : "No active task reported. Open chat when you have a task.",
    },
  };
}

function classify(bot: Bot, connected: boolean): Classification {
  const known = lastKnownStatus(bot, visibleMessages(bot));
  if (!connected || bot.activity === "no-signal" || bot.activity === "dead") {
    return {
      bucket: "disconnected", avatar: "idle",
      item: {
        ...known.item,
        title: !connected ? "Connection lost" : bot.activity === "no-signal" ? "No signal" : "Offline",
        detail: `Last known: ${known.item.title}. ${known.item.detail}`,
      },
    };
  }
  return known;
}

/** Operational truth only: profile keywords and chosen resting expressions
 * do not imply work, approval requests, or completed results. */
export function operationalAvatarState(bot: Bot, connected: boolean): AgentState {
  return classify(bot, connected).avatar;
}

/** Each visible teammate appears once. Decisions are oldest first; new
 * replies newest first. Neither input arrays nor transcript order change. */
export function buildWorkspaceSummary(bots: Bot[], connected: boolean): WorkspaceSummary {
  const summary: WorkspaceSummary = { decisions: [], working: [], replies: [], available: [], disconnected: [] };
  for (const bot of bots) {
    if (bot.hidden) continue;
    const { bucket, item } = classify(bot, connected);
    summary[bucket].push(item);
  }
  summary.decisions.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.bot.id.localeCompare(b.bot.id));
  summary.replies.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.bot.id.localeCompare(b.bot.id));
  return summary;
}
