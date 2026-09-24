import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardCopy,
  Copy,
  Crown,
  FolderPlus,
  Library,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  Sparkles,
  Puzzle,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot, type Group } from "@/state/store";
import {
  DENSITY_AVATAR,
  DENSITY_WIDTH,
  loadCollapsedSections,
  loadDensity,
  saveCollapsedSections,
  saveDensity,
  type SidebarDensity,
  type SidebarSection,
} from "@/lib/sidebar-preferences";

import { AgentAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { MusterBotMark } from "@/lib/musterbot/MusterBotMark";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import {
  assignBotToSection,
  deriveAttentionInbox,
  type AttentionFacts,
  loadRosterAssignment,
  loadRosterSections,
  removeRosterSection,
  renameRosterSection,
  saveRosterAssignment,
  saveRosterSections,
  type RosterSection,
} from "@/lib/roster-sections";
import { downloadAllBots } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { TemplatesModal } from "./TemplatesModal";
import { RecoveryCard } from "./RecoveryCard";
import { RenameTitle } from "./RenameTitle";

/** "Ramagiritharun" → "RG", "alex" → "A", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? s?.percent == null
          ? "Starting download…"
          : `Downloading… ${Math.round(s.percent)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "installing"
            ? "Restarting to update…"
            : status === "checking"
              ? "Checking for updates…"
              : upToDate
                ? "You're up to date"
                : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative rounded-md p-2 text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const text = last.kind === "activity" && last.tool ? last.tool.name : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping agents in the same slot a bot gets. */
function StackedAgents({ members, size = 56 }: { members: Bot[]; size?: number }) {
  const slot = `${Math.round(size * 0.7)}px`;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className="relative flex shrink-0 items-center justify-center" style={{ width: slot, height: slot }}>
        {b ? <AgentAvatar color={b.color} character={b.character} state="happy" size={size} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: slot, height: slot }}>
      <div className="flex items-center" style={{ marginLeft: -Math.round(size * 0.22) }}>
        {shown.map((b, i) => (
          <span key={b.id} className="relative" style={{ marginLeft: i === 0 ? 0 : -Math.round(size * 0.22), zIndex: i }}>
            <AgentAvatar color={b.color} character={b.character} state="happy" size={Math.round(size * 0.54)} />
          </span>
        ))}
        {extra > 0 && (
          <span className="z-10 flex items-center justify-center rounded-full border border-hairline/40 bg-raised font-medium text-ink-secondary" style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4), marginLeft: -Math.round(size * 0.22), fontSize: Math.max(9, Math.round(size * 0.18)) }}>
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({ group, onMenu, density }: { group: Group; onMenu: (menu: { groupId: string; x: number; y: number }) => void; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  const rowClass = cn(
    "flex w-full items-center gap-3 rounded-xl text-left",
    density === "compact" ? "px-3 py-2" : "px-3 py-2.5",
    density === "icons" ? "justify-center px-2 py-2" : "",
    selected ? "bg-raised" : "hover:bg-raised/50",
  );
  if (density === "icons") {
    return (
      <button
        onClick={() => dispatch({ type: "select", id: group.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
        }}
        title={group.name}
        aria-label={`Open room ${group.name}`}
        className={rowClass}
      >
        <div className="relative">
          <StackedAgents members={members} size={DENSITY_AVATAR.icons} />
          {group.unread && <span className="absolute right-0 top-0 size-2 rounded-full bg-accent" />}
        </div>
      </button>
    );
  }
  return (
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      className={rowClass}
    >
      <div className="relative shrink-0">
        <StackedAgents members={members} size={DENSITY_AVATAR[density]} />
        <PresenceDot activity={group.busyBotId ? "working" : undefined} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate font-semibold text-ink", density === "compact" ? "text-[14px]" : "text-[15px]")}>{group.name}</span>
          {selected && last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-ink-secondary", density === "compact" ? "text-[11.5px]" : "text-[13px]")}>{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const top = Math.min(menu.y, window.innerHeight - 164);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete Room
      </button>
    </div>,
    document.body,
  );
}

/** Pick members → Create. The room name is optional; the server defaults it.
 * "Everyone answers" turns the room into a side-by-side multi-model ask:
 * one question in, every member's answer out. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [everyoneAnswers, setEveryoneAnswers] = useState(false);
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    const compare = everyoneAnswers && picked.size > 1;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      everyoneAnswers: compare,
    });
    track("room_created", { members: picked.size, everyoneAnswers: compare });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Room</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Room name (optional)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {bots.length === 0 && (
            <div className="px-2 py-4 text-center text-[13px] text-ink-secondary">Create a bot first — rooms are made of bots.</div>
          )}
          {bots.map((b) => (
            <button
              key={b.id}
              onClick={() => toggle(b.id)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
            >
              <AgentAvatar color={b.color} character={b.character} state="happy" size={28} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{b.name}</span>
              <span
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                  picked.has(b.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
                )}
              >
                {picked.has(b.id) && <Check size={12} />}
              </span>
            </button>
          ))}
        </div>
        {picked.size > 1 && (
          <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg bg-raised/50 p-2.5">
            <input
              type="checkbox"
              checked={everyoneAnswers}
              onChange={(e) => setEveryoneAnswers(e.target.checked)}
              className="mt-0.5 size-4 accent-[#f0460e]"
            />
            <span className="text-[12.5px] leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">Everyone answers</span> — one question in,
              every bot's answer out, side by side. Great for comparing models.
            </span>
          </label>
        )}
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {everyoneAnswers && picked.size > 1
            ? `Compare ${picked.size} bots`
            : `Create Room${picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}`}
        </button>
      </div>
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? "Choose another Chief of Staff first"
    : visibleBotCount <= 1
      ? "Keep at least one active bot"
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? "Remove Chief of Staff" : "Make Chief of Staff",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? "Choose a Claude or ACP engine first" : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to section…", () =>
          onMoveToSection(bot.id),
        ),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        // The row's unit of work deserves its own door: the same newTask
        // TaskPicker offers in the header, with TaskPicker's busy rule.
        item(<Plus size={16} className="text-ink-secondary" />, "New task", () =>
          dispatch({ type: "newTask", botId: bot.id }),
          { disabled: bot.busy, hint: bot.busy ? "Let this turn finish first" : undefined },
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

/** Benchmark-style presence ring on the avatar: green = working, amber =
 * waiting on you. A resting teammate gets no dot — presence should never
 * out-shout the unread marker. */
function PresenceDot({ activity }: { activity?: Bot["activity"] }) {
  if (activity !== "working" && activity !== "waiting-on-you") return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-panel",
        activity === "working" ? "bg-[#38d591]" : "bg-warning",
      )}
    />
  );
}

/** Collapsible roster section header (Rooms / Teammates). A collapsed
 * header keeps the attention counts the rows can no longer show. */
/** Right-click menu on a roster section header: rename or remove it.
 * Removing never deletes bots — members fall back to the default list. */
function SectionContextMenu({
  menu,
  onClose,
  onRename,
  onRemove,
}: {
  menu: { sectionId: string; x: number; y: number };
  onClose: () => void;
  onRename: (sectionId: string) => void;
  onRemove: (sectionId: string) => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && !e.target.closest("[data-section-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 160));
  const left = Math.min(menu.x, window.innerWidth - 240);
  return (
    <div
      data-section-menu
      style={{ top, left }}
      className="fixed z-40 w-[200px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => {
          onRename(menu.sectionId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <Pencil size={16} className="text-ink-secondary" />
        Rename section
      </button>
      <button
        onClick={() => {
          onRemove(menu.sectionId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Remove section
      </button>
    </div>
  );
}

/** The move/rename sheet: pick an existing section, type a new one, or
 * leave the default roster. One surface for both entry points. */
function SectionAssignPanel({
  mode,
  sections,
  assignment,
  draft,
  onDraft,
  onPick,
  onCreate,
  onUnassign,
  onClose,
}: {
  mode: "move" | "rename";
  sections: RosterSection[];
  assignment: Record<string, string>;
  draft: string;
  onDraft: (name: string) => void;
  onPick: (sectionId: string) => void;
  onCreate: () => void;
  onUnassign: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const canCreate = draft.trim().length > 0 && sections.length < 8;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onMouseDown={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl shadow-black/60"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-[15px] font-medium text-ink">
          {mode === "move" ? "Move to section" : "Rename section"}
        </div>
        {mode === "move" && (
          <div className="mt-3 flex flex-col gap-1">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => onPick(section.id)}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-[13.5px] text-ink hover:bg-raised/70"
              >
                <span className="truncate">{section.name}</span>
                {assignment && Object.values(assignment).filter((id) => id === section.id).length > 0 && (
                  <span className="text-[11px] text-ink-secondary">
                    {Object.values(assignment).filter((id) => id === section.id).length}
                  </span>
                )}
              </button>
            ))}
            {sections.length === 0 && (
              <div className="px-1 py-1 text-[12.5px] text-ink-secondary">No sections yet — name one below.</div>
            )}
            {Object.keys(assignment ?? {}).length > 0 && (
              <button
                onClick={onUnassign}
                className="mt-1 rounded-lg px-3 py-2 text-left text-[13.5px] text-ink-secondary hover:bg-raised/70 hover:text-ink"
              >
                No section (default list)
              </button>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreate();
          }}
          className="mt-3 flex gap-2"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder={mode === "move" ? "New section name" : "Section name"}
            aria-label={mode === "move" ? "New section name" : "Section name"}
            maxLength={24}
            className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary/60 focus:border-accent/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {mode === "move" ? "Create & move" : "Rename"}
          </button>
        </form>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg border border-hairline/40 px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** SAFETY: a stored section id is a non-empty string this module minted
 * (createSectionAndMove), so the template literal always satisfies the
 * `section:${string}` arm of SidebarSection. */
const sectionToggleKey = (sectionId: string): SidebarSection => `section:${sectionId}` as SidebarSection;

function SectionHeader({
  label,
  collapsed,
  onToggle,
  waiting,
  unread,
  compact,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  waiting: number;
  unread: number;
  /** Icons-only rail: no room for the label — a centered chevron carries
   * the toggle, and a dot takes over from the numeric attention badges. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
        title={label}
        className="relative flex w-full items-center justify-center rounded-lg py-1.5 text-ink-secondary transition-colors hover:text-ink"
      >
        <ChevronDown size={12} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
        {collapsed && (waiting > 0 || unread > 0) && (
          <span className={cn("absolute right-2 top-1 size-1.5 rounded-full", waiting > 0 ? "bg-warning" : "bg-accent")} />
        )}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-1.5 rounded-lg px-3 pb-1 pt-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:text-ink"
    >
      <ChevronDown size={12} className={cn("shrink-0 transition-transform duration-200", collapsed && "-rotate-90")} />
      <span className="flex-1">{label}</span>
      {collapsed && waiting > 0 && (
        <span className="min-w-4 rounded-full bg-warning/20 px-1 text-center text-[10px] font-semibold text-warning">{waiting}</span>
      )}
      {collapsed && unread > 0 && (
        <span className="min-w-4 rounded-full bg-accent/20 px-1 text-center text-[10px] font-semibold text-accent">{unread}</span>
      )}
    </button>
  );
}

/** Benchmark threads-under-bot: the rooms a teammate lives in, nested under
 * its row. Attention-first (unread and busy sort up), capped so a busy bot
 * never floods the roster; icons rail has no room for them. */
function BotThreadRows({ bot, density }: { bot: Bot; density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const rooms = state.groups.filter((g) => g.memberIds.includes(bot.id));
  if (rooms.length === 0) return null;
  const attention = (g: Group) => (g.unread ? 0 : g.busyBotId ? 1 : 2);
  const ordered = [...rooms].sort((a, b) => attention(a) - attention(b));
  const shown = ordered.slice(0, 4);
  const rest = ordered.length - shown.length;
  return (
    <div className="ml-[27px] space-y-0.5 border-l border-hairline/40 pb-1 pl-2">
      {shown.map((g) => {
        const active = state.activeView === "chat" && state.selectedId === g.id;
        const peers = g.memberIds
          .filter((id) => id !== bot.id)
          .map((id) => state.bots.find((b) => b.id === id)?.name)
          .filter((n): n is string => Boolean(n));
        const label = peers.length === 1 ? `⇄ ${peers[0]}` : g.name;
        return (
          <button
            key={g.id}
            onClick={() => dispatch({ type: "select", id: g.id })}
            aria-label={`Open thread ${label}`}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left",
              density === "compact" ? "text-[11.5px]" : "text-[12px]",
              active ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                g.unread ? "bg-accent" : g.busyBotId ? "bg-[#38d591]" : "bg-hairline",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {g.busyBotId && !g.unread && (
              <span className="shrink-0 text-[10px] text-ink-secondary/70">working</span>
            )}
          </button>
        );
      })}
      {rest > 0 && (
        <div className="px-2 py-0.5 text-[10.5px] text-ink-secondary/60">+{rest} more</div>
      )}
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  onArchive,
  archiveDisabled,
  density,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
  density: SidebarDensity;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const rowClass = cn(
    "flex w-full items-center gap-3 rounded-xl border text-left",
    density === "compact" ? "px-3 py-2" : "px-3 py-2.5",
    density === "icons" ? "justify-center px-2 py-2" : "pr-10",
    bot.chiefOfStaff
      ? selected
        ? "border-accent/40 bg-accent/15"
        : "border-accent/25 bg-accent/5 hover:bg-accent/10"
      : selected
        ? "border-transparent bg-raised"
        : "border-transparent hover:bg-raised/50",
  );
  const avatar = (
    <div className="relative shrink-0">
      <AgentAvatar
        character={bot.character}
        color={bot.color}
        state={stateForBot({ ...bot, messages: visible })}
        size={DENSITY_AVATAR[density]}
        /* Benchmark cost discipline: a resting row is a single static frame —
           animation runs only where something is actually happening. */
        animated={selected || Boolean(bot.busy) || Boolean(bot.unread)}
      />
      <PresenceDot activity={bot.activity} />
    </div>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };

  // Icons-only rail: the avatar IS the row; the tooltip carries identity,
  // and the unread marker moves to the corner the text used to occupy.
  if (density === "icons") {
    return (
      <div className="group relative">
        <div
          role="button"
          tabIndex={0}
          title={bot.activity === "waiting-on-you" ? `${bot.name} — waiting on you` : bot.name}
          aria-label={`Open ${bot.name}`}
          onClick={() => dispatch({ type: "select", id: bot.id })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              dispatch({ type: "select", id: bot.id });
            }
          }}
          onContextMenu={onContextMenu}
          className={rowClass}
        >
          {avatar}
          {bot.unread && <span className="absolute right-1.5 top-1.5 size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
    );
  }
  const body = (
    <>
      {avatar}
      <div className="min-w-0 flex-1">
        {bot.title && (
          <div className="truncate text-[11px] leading-tight text-ink-secondary">{bot.title}</div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("flex min-w-0 items-center gap-1.5 truncate font-semibold text-ink", density === "compact" ? "text-[14px]" : "text-[15px]")}>
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
          </span>
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-ink-secondary", density === "compact" ? "text-[11.5px]" : "text-[13px]")}>
            {bot.chiefOfStaff && (
              <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent">
                <Crown size={11} /> Chief of Staff
              </span>
            )}
            {bot.chiefOfStaff && preview(bot) && <span className="shrink-0 text-ink-secondary/60">·</span>}
            <span className="truncate">{preview(bot)}</span>
          </span>
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
        {body}
      </div>
    );
  }

  return (
    <div className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={() => dispatch({ type: "select", id: bot.id })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {/* the icons rail returns above — density is comfortable|compact here */}
      <BotThreadRows bot={bot} density={density} />
      <button
        type="button"
        disabled={archiveDisabled}
        onClick={() => onArchive(bot)}
        aria-label={`Archive ${bot.name}`}
        title={
          bot.chiefOfStaff
            ? "Choose another Chief of Staff first"
            : archiveDisabled
              ? "Keep at least one active bot"
              : `Archive ${bot.name}`
        }
        className="absolute right-2 top-2.5 flex size-7 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
      >
        <Archive size={14} />
      </button>
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(`${bots.length} ${bots.length === 1 ? "bot" : "bots"} restored`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Archived bots</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Conversations are kept until you choose to delete a bot.</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore all
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close archived bots"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{bots.length} archived</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <AgentAvatar color={bot.color} character={bot.character} state="happy" size={42} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || "Bot"}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Signing up with an account (cloud or self-hosted auth) sets the auth
  // user's name/email, but that's a separate identity from the local
  // ~/.muster/config.json "profile" field this sidebar historically showed
  // — so a freshly created account's name never appeared here, falling
  // back to a bare "You". The local profile field still wins when set
  // (it's the explicit override), but an authenticated session is now a
  // real fallback instead of being ignored entirely.
  const { user: authUser } = useAuth();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  // Benchmark layout program: three densities (persisted) + collapsible
  // roster sections (Rooms / Teammates) with attention badges.
  const [density, setDensity] = useState<SidebarDensity>(() => loadDensity());
  const [densityMenu, setDensityMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<SidebarSection[]>(() => loadCollapsedSections());
  // OMB parity #1a/#1b: the cross-bot attention inbox and named roster
  // sections (folders). Both persist per profile alongside density.
  const [sections, setSections] = useState<RosterSection[]>(() => loadRosterSections(window.localStorage));
  const [assignment, setAssignment] = useState<Record<string, string>>(() => loadRosterAssignment(window.localStorage));
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sectionMenu, setSectionMenu] = useState<{ sectionId: string; x: number; y: number } | null>(null);

  const setSidebarDensity = (next: SidebarDensity) => {
    setDensity(next);
    saveDensity(next);
    setDensityMenu(false);
    track("sidebar_density", { density: next });
  };
  const toggleSection = (section: SidebarSection) => {
    setCollapsed((prev) => {
      const next = prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section];
      saveCollapsedSections(next);
      return next;
    });
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "all_visible" });
      setTeamFeedback({ error: false, text: `${exported.members} bots exported` });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      const previousChief = result.archived.find((bot) => bot.chiefOfStaff);
      const restoreOthers = await Promise.all(
        result.archived
          .filter((bot) => !bot.chiefOfStaff)
          .map((bot) =>
            api(`/api/bots/${bot.id}`, {
              method: "PATCH",
              body: JSON.stringify({ hidden: false }),
            }),
          ),
      );
      for (const response of restoreOthers) dispatch({ type: "botPatched", bot: response.bot });
      if (previousChief) {
        const response = await api(`/api/bots/${previousChief.id}`, {
          method: "PATCH",
          body: JSON.stringify({ hidden: false, chiefOfStaff: true }),
        });
        dispatch({ type: "botPatched", bot: response.bot });
      }
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: "Previous team restored" });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";

  // OMB #1b — folder management. Every mutation goes through the pure lib
  // and is persisted immediately; the assignment map stays the truth.
  const persistAssignment = (nextSections: RosterSection[], nextAssignment: Record<string, string>) => {
    setSections(saveRosterSections(window.localStorage, nextSections));
    setAssignment(saveRosterAssignment(window.localStorage, nextAssignment));
  };
  const moveToSection = (botId: string, sectionId: string | null) => {
    const moved = assignBotToSection(sections, assignment, botId, sectionId);
    persistAssignment(moved.sections, moved.assignment);
  };
  const createSectionAndMove = (botId: string, name: string) => {
    const clean = name.trim().slice(0, 24);
    if (!clean || sections.length >= 8) return;
    const id = `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const moved = assignBotToSection([...sections, { id, name: clean, botIds: [] }], assignment, botId, id);
    persistAssignment(moved.sections, moved.assignment);
  };
  const removeSection = (sectionId: string) => {
    const next = removeRosterSection(sections, assignment, sectionId);
    persistAssignment(next.sections, next.assignment);
  };
  const renameSection = (sectionId: string, name: string) => {
    setSections(saveRosterSections(window.localStorage, renameRosterSection(sections, sectionId, name)));
  };
  const [pendingMoveBot, setPendingMoveBot] = useState<string | null>(null);
  const [pendingRenameSection, setPendingRenameSection] = useState<string | null>(null);
  const [sectionNameDraft, setSectionNameDraft] = useState("");

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const chiefBot = matchingBots.find((bot) => bot.chiefOfStaff);
  const visibleBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;

  // The attention inbox derives from the feeds the roster already holds —
  // no fetch, no new state: waiting beats failed beats unread; recency
  // breaks ties. `lastToolFailed` is the same fact the mascot's error face
  // reads, so the inbox and the faces can never disagree.
  const botFacts: AttentionFacts[] = matchingBots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    unread: Boolean(bot.unread),
    waiting: bot.activity === "waiting-on-you",
    failed: visibleMessages(bot).some((m) => m.tool?.ok === false),
    at: visibleMessages(bot).at(-1)?.at,
  }));
  const roomFacts: AttentionFacts[] = visibleGroups.map((g) => ({
    id: g.id,
    name: g.name,
    unread: Boolean(g.unread),
    at: g.messages.at(-1)?.at,
  }));
  const attention = deriveAttentionInbox(botFacts, roomFacts);

  // Sections group the roster. The map is the source of truth; section
  // membership lists follow it, so a deleted section's bots fall back to
  // the default list automatically.
  const sectionedBots = new Map<string, string[]>();
  for (const [botId, sectionId] of Object.entries(assignment)) {
    const list = sectionedBots.get(sectionId) ?? [];
    list.push(botId);
    sectionedBots.set(sectionId, list);
  }
  const unsectionedBots = visibleBots.filter((b) => !assignment[b.id]);

  return (
    <aside
      className={cn(
        "glass-shell-sidebar flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200 ease-[cubic-bezier(.24,1,.4,1)]",
        DENSITY_WIDTH[density],
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* macOS owns inset traffic lights; the browser wears the brand. */}
      <div
        className={cn("flex items-center justify-between px-4 pt-3.5 pb-1", density === "icons" && "flex-col gap-2 px-2")}
        // SAFETY: Electron honors the non-standard -webkit-app-region drag
        // style, which React's CSSProperties does not declare.
        style={macInset ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}
      >
        {macInset ? (
          <div className="w-14" />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <MusterBotMark size={22} label="Muster" />
            {density !== "icons" && <span className="text-[15px] font-semibold tracking-tight text-ink">Muster</span>}
          </div>
        ) : <div />}
        <div
          className="relative"
          // SAFETY: Electron honors the non-standard -webkit-app-region drag
          // style, which React's CSSProperties does not declare.
          style={macInset ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setDensityMenu((o) => !o)}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              title="Sidebar density"
              aria-label="Sidebar density"
              aria-expanded={densityMenu}
            >
              <Rows3 size={18} />
            </button>
            {densityMenu && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityMenu(false)} />
                <div className="menu-pop absolute right-8 top-full z-40 mt-1 w-44 origin-top-right overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
                  {([
                    ["comfortable", "Comfortable"],
                    ["compact", "Compact"],
                    ["icons", "Icons only"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => setSidebarDensity(mode)}
                      className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                    >
                      <span className="flex-1">{label}</span>
                      {density === mode && <Check size={14} className="text-accent" />}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              ref={importReturnRef}
              onClick={() => setPlusOpen((o) => !o)}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              title="New or share"
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </div>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60">
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  New Bot
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTemplatesOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Sparkles size={16} className="text-ink-secondary" />
                  Agent Hub
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New Room
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? "Exporting…" : "Export all bots"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  Teams
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived bots</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search — the rail has no room for it; ⌘K and the mobile drawer
          keep the full search. */}
      {density !== "icons" && (
      <div className="px-3 pt-2 pb-3">
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search bots and messages"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>
      )}

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {/* OMB parity #1a — the cross-bot attention inbox: what needs me,
              across every bot and room, waiting first. Derives from the same
              facts the roster rows already show; empty fleets show nothing. */}
          {attention.length > 0 && density !== "icons" && (
            <div className="mb-1.5">
              <SectionHeader
                label={`Needs attention (${attention.length})`}
                collapsed={!inboxOpen}
                onToggle={() => setInboxOpen((o) => !o)}
                waiting={attention.filter((i) => i.reason === "waiting").length}
                unread={attention.filter((i) => i.reason === "unread").length}
              />
              {inboxOpen && (
                <div className="mb-1 space-y-0.5">
                  {attention.map((item) => (
                    <button
                      key={`${item.kind}:${item.id}`}
                      onClick={() => {
                        dispatch({ type: "select", id: item.id });
                        setInboxOpen(false);
                      }}
                      aria-label={`Open ${item.name}`}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          item.reason === "waiting" ? "bg-warning" : item.reason === "failed" ? "bg-danger" : "bg-accent",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{item.name}</span>
                      <span className="shrink-0 text-[10.5px] text-ink-secondary/80">
                        {item.reason === "waiting" ? "waiting" : item.reason === "failed" ? "failed" : "unread"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {state.bots.filter((b) => !b.hidden).length <= 1 && density !== "icons" && <RecoveryCard />}
          {!chiefBot && visibleBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && density !== "icons" && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {chiefBot && (
            <div className="mb-1.5">
              <BotListItem
                bot={chiefBot}
                onMenu={setMenu}
                onArchive={(bot) => void archiveBot(bot)}
                archiveDisabled
                density={density}
              />
            </div>
          )}
          {visibleGroups.length > 0 && (
            <SectionHeader
              label="Rooms"
              collapsed={collapsed.includes("rooms")}
              onToggle={() => toggleSection("rooms")}
              waiting={0}
              unread={visibleGroups.filter((g) => g.unread).length}
              compact={density === "icons"}
            />
          )}
          {!collapsed.includes("rooms") && visibleGroups.map((g) => (
            <GroupListItem key={g.id} group={g} onMenu={setRoomMenu} density={density} />
          ))}
          {visibleBots.length > 0 && (
            <SectionHeader
              label="Teammates"
              collapsed={collapsed.includes("teammates")}
              onToggle={() => toggleSection("teammates")}
              waiting={visibleBots.filter((b) => b.activity === "waiting-on-you").length}
              unread={visibleBots.filter((b) => b.unread).length}
              compact={density === "icons"}
            />
          )}
          {/* OMB parity #1b — named sections (folders). Each renders its
              own collapsible group; bots outside every section stay in the
              default Teammates list below. */}
          {sections.map((section) => {
            const members = (sectionedBots.get(section.id) ?? [])
              .map((id) => visibleBots.find((b) => b.id === id))
              .filter((b): b is Bot => Boolean(b));
            if (members.length === 0) return null;
            return (
              <div key={section.id} className="mb-1">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSection(sectionToggleKey(section.id))}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleSection(sectionToggleKey(section.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSectionMenu({ sectionId: section.id, x: e.clientX, y: e.clientY });
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50"
                >
                  <ChevronDown
                    size={12}
                    className={cn("shrink-0 text-ink-secondary transition-transform duration-200", collapsed.includes(sectionToggleKey(section.id)) && "-rotate-90")}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{section.name}</span>
                  <span className="text-[10.5px] text-ink-secondary/70">{members.length}</span>
                </div>
                {!collapsed.includes(sectionToggleKey(section.id)) &&
                  members.map((b) => (
                    <BotListItem
                      key={b.id}
                      bot={b}
                      onMenu={setMenu}
                      onArchive={(bot) => void archiveBot(bot)}
                      archiveDisabled={activeBotCount <= 1}
                      density={density}
                    />
                  ))}
              </div>
            );
          })}
          {visibleBots.length > 0 && (
            <SectionHeader
              label="Teammates"
              collapsed={collapsed.includes("teammates")}
              onToggle={() => toggleSection("teammates")}
              waiting={unsectionedBots.filter((b) => b.activity === "waiting-on-you").length}
              unread={unsectionedBots.filter((b) => b.unread).length}
              compact={density === "icons"}
            />
          )}
          {!collapsed.includes("teammates") && unsectionedBots.map((b) => (
            <BotListItem
              key={b.id}
              bot={b}
              onMenu={setMenu}
              onArchive={(bot) => void archiveBot(bot)}
              archiveDisabled={activeBotCount <= 1}
              density={density}
            />
          ))}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
      </div>

      {/* Footer */}
      <div className="px-3 pb-3 pt-2">
        <button
          onClick={() => dispatch({ type: "showRoutines" })}
          title="Automations"
          className={cn(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
            density === "icons" && "justify-center px-0",
            state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
          {density !== "icons" && <span className="flex-1 text-[14px]">Automations</span>}
          {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
            <span className="size-2 rounded-full bg-danger" />
          )}
        </button>
        <button
          onClick={() => dispatch({ type: "showSocial" })}
          title="Social"
          className={cn(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
            density === "icons" && "justify-center px-0",
            state.activeView === "social" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
          )}
        >
          <Users size={20} className={state.activeView === "social" ? "text-accent" : "text-ink-secondary"} />
          {density !== "icons" && <span className="flex-1 text-[14px]">Social</span>}
          {(state.social?.incoming.length ?? 0) > 0 && (
            density === "icons" ? (
              <span className="size-2 rounded-full bg-accent" />
            ) : (
              <span className="min-w-5 rounded-full bg-accent/20 px-1.5 text-center text-[11px] font-semibold text-accent">
                {state.social?.incoming.length}
              </span>
            )
          )}
        </button>
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          title="Connected apps"
          className={cn(
            "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50",
            density === "icons" && "justify-center px-0",
          )}
        >
          <Puzzle size={20} className="text-ink-secondary" />
          {density !== "icons" && <span className="text-[14px] text-ink">Connected apps</span>}
        </button>
        <div className="flex items-center">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            title={state.config?.profile?.name?.trim() || authUser?.name?.trim() || "You"}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/50",
              density === "icons" && "justify-center px-0",
            )}
          >
            <InitialsAvatar
              initials={profileInitials({
                name: state.config?.profile?.name || authUser?.name,
                email: state.config?.profile?.email || authUser?.email,
              })}
              size={28}
            />
            {density !== "icons" && (
              <span className="truncate text-[14px] text-ink">
                {state.config?.profile?.name?.trim() ||
                  authUser?.name?.trim() ||
                  state.config?.profile?.email?.trim() ||
                  authUser?.email?.trim() ||
                  "You"}
              </span>
            )}
          </button>
          <UpdateButton />
          {density !== "icons" && (
          <Link to="/os" aria-label="Open Muster OS" title="Open Muster OS"
            className="hidden min-h-9 items-center rounded-md px-2 text-xs font-semibold text-ink-secondary hover:bg-raised hover:text-ink md:flex">
            OS
          </Link>
          )}
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            title="App settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onMoveToSection={(botId) => {
            setPendingMoveBot(botId);
            setSectionNameDraft("");
          }}
        />
      )}
      {sectionMenu && <SectionContextMenu menu={sectionMenu} onClose={() => setSectionMenu(null)} onRename={(id) => { setPendingRenameSection(id); setSectionNameDraft(""); }} onRemove={removeSection} />}
      {(pendingMoveBot || pendingRenameSection) && (
        <SectionAssignPanel
          mode={pendingMoveBot ? "move" : "rename"}
          sections={sections}
          assignment={assignment}
          draft={sectionNameDraft}
          onDraft={setSectionNameDraft}
          onPick={(sectionId) => {
            if (pendingMoveBot) moveToSection(pendingMoveBot, sectionId);
            setPendingMoveBot(null);
          }}
          onCreate={() => {
            if (pendingMoveBot) createSectionAndMove(pendingMoveBot, sectionNameDraft);
            else if (pendingRenameSection) renameSection(pendingRenameSection, sectionNameDraft);
            setPendingMoveBot(null);
            setPendingRenameSection(null);
          }}
          onUnassign={() => {
            if (pendingMoveBot) moveToSection(pendingMoveBot, null);
            setPendingMoveBot(null);
          }}
          onClose={() => {
            setPendingMoveBot(null);
            setPendingRenameSection(null);
          }}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          onClose={() => setTeamLibraryOpen(false)}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamFeedback(
              result.archived.length > 0
                ? {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                    undo: result,
                  }
                : {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                  },
            );
          }}
        />
      )}
      {templatesOpen && createPortal(<TemplatesModal onClose={() => setTemplatesOpen(false)} />, document.body)}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
