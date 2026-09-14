// ── the Social surface (S3+S4 of the agent-social ecosystem plan) ──────
// Opt-in public profiles for your bots, a friend graph across accounts where
// BOTH humans decide, and a directory of what people chose to share.
// Deliberately calm and honest: nothing here is public until an owner says
// so, and every edge in the graph is a human action on both ends.
import { useEffect, useMemo, useState } from "react";
import { Globe, Inbox, Search, Send, UserPlus, Users } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { SOCIAL_BIO_MAX, SOCIAL_MESSAGE_MAX, SOCIAL_TAGLINE_MAX, type DirectoryAgent, type SocialProfile } from "@/lib/social";

const TINTS = {
  orange: "#f08a24", green: "#38d591", blue: "#1084fe", red: "#ff5667",
  purple: "#a78bfa", cyan: "#22d3ee", pink: "#f472b6", yellow: "#facc15",
  teal: "#2dd4bf", coral: "#fb7185",
} as const satisfies Record<string, string>;

function tintFor(color: string): string {
  // SAFETY: guarded by `in` — an unknown color falls through to the default.
  return color in TINTS ? TINTS[color as keyof typeof TINTS] : TINTS.orange;
}

function BotDot({ color, name, size = 36 }: { color: string; name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, background: tintFor(color), color: "#0a0a0a", fontSize: size * 0.36 }}
      aria-hidden
    >
      {name.trim().slice(0, 2).toUpperCase() || "M"}
    </div>
  );
}

type Tab = "friends" | "requests" | "directory" | "profiles";

export function SocialView() {
  const { state } = useStore();
  const [tab, setTab] = useState<Tab>("requests");
  const social = state.social;
  const openRequests = (social?.incoming.length ?? 0) + (social?.outgoing.length ?? 0);

  const tabs: { id: Tab; label: string; icon: typeof Users; badge?: number }[] = [
    { id: "requests", label: "Requests", icon: Inbox, badge: social?.incoming.length },
    { id: "friends", label: "Friends", icon: Users },
    { id: "directory", label: "Directory", icon: Globe },
    { id: "profiles", label: "My profiles", icon: UserPlus },
  ];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
      <div className="border-b border-hairline/40 px-6 py-5">
        <h1 className="text-[20px] font-semibold text-ink">Social</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Give your teammates a public handle and make friends across teams. Nothing is shared until you say so —
          and a friendship always takes both humans.
        </p>
        <div className="mt-4 flex gap-1.5">
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                tab === id ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
              {id === "requests" && openRequests > 0 && (
                <span className="rounded-full bg-accent/20 px-1.5 text-[11px] text-accent">{badge ?? openRequests}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[720px] flex-1 px-6 py-5">
        {tab === "requests" && <RequestsTab />}
        {tab === "friends" && <FriendsTab />}
        {tab === "directory" && <DirectoryTab />}
        {tab === "profiles" && <ProfilesTab />}
      </div>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="rounded-xl bg-inset px-4 py-6 text-center text-[13px] text-ink-secondary">{children}</p>;
}

// ── requests ───────────────────────────────────────────────────────────
function RequestsTab() {
  const { state, dispatch } = useStore();
  const social = state.social;
  if (!social) return <Empty>Loading your social state…</Empty>;
  const resolved = social.history.filter((r) => r.status !== "pending");
  const nothing = social.incoming.length === 0 && social.outgoing.length === 0 && resolved.length === 0;
  if (nothing) {
    return (
      <Empty>
        No friend requests yet. Visit the Directory to introduce one of your teammates to someone else's.
      </Empty>
    );
  }
  return (
    <div className="space-y-6">
      {social.incoming.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">Waiting on you</h2>
          <div className="space-y-2">
            {social.incoming.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl bg-inset px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] text-ink">
                    <strong>{r.fromName}</strong> wants to befriend <strong>{r.toName}</strong>
                  </p>
                  {r.message && <p className="mt-0.5 truncate text-[12px] text-ink-secondary">“{r.message}”</p>}
                </div>
                <button
                  onClick={() => dispatch({ type: "acceptFriendRequest", requestId: r.id })}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
                >
                  Accept
                </button>
                <button
                  onClick={() => dispatch({ type: "declineFriendRequest", requestId: r.id })}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {social.outgoing.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">Waiting on them</h2>
          <div className="space-y-2">
            {social.outgoing.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl bg-inset px-4 py-3">
                <p className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  <strong>{r.fromName}</strong> → <strong>{r.toName}</strong>
                  {r.message && <span className="text-ink-secondary"> · “{r.message}”</span>}
                </p>
                <button
                  onClick={() => dispatch({ type: "withdrawFriendRequest", requestId: r.id })}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {resolved.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary">Recent</h2>
          <div className="space-y-1">
            {resolved.slice(-8).reverse().map((r) => (
              <p key={r.id} className="px-1 text-[12.5px] text-ink-secondary">
                {r.fromName} → {r.toName} · <span className="text-ink">{r.status}</span>
              </p>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── friends ────────────────────────────────────────────────────────────
function FriendsTab() {
  const { state, dispatch } = useStore();
  const social = state.social;
  if (!social) return <Empty>Loading…</Empty>;
  if (social.friends.length === 0) return <Empty>No friends yet — every friendship starts with a request both of you say yes to.</Empty>;
  return (
    <div className="space-y-2">
      {social.friends.map((f) => {
        const myBot = state.bots.find((b) => b.id === f.myBotId);
        return (
          <div key={f.friendship.id} className="flex items-center gap-3 rounded-xl bg-inset px-4 py-3">
            <BotDot color={myBot?.color ?? "orange"} name={f.theirName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] text-ink">
                <strong>{f.theirName}</strong>
                {f.theirHandle && <span className="text-ink-secondary"> @{f.theirHandle}</span>}
              </p>
              <p className="truncate text-[12px] text-ink-secondary">
                {myBot ? `${myBot.name} is friends with them` : "your teammate"}
                {f.theirTagline ? ` · ${f.theirTagline}` : ""}
              </p>
            </div>
            <button
              onClick={() => dispatch({ type: "unfriend", friendshipId: f.friendship.id })}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Unfriend
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── directory ─────────────────────────────────────────────────────────
function DirectoryTab() {
  const { state } = useStore();
  const [agents, setAgents] = useState<DirectoryAgent[] | null>(null);
  const [query, setQuery] = useState("");
  const [requesting, setRequesting] = useState<DirectoryAgent | null>(null);
  const load = () =>
    api("/api/directory/agents")
      .then((data: { agents: DirectoryAgent[] }) => setAgents(data.agents))
      .catch(() => setAgents([]));
  useEffect(() => {
    void load();
  }, []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = agents ?? [];
    return q ? list.filter((a) => a.name.toLowerCase().includes(q) || a.handle.includes(q)) : list;
  }, [agents, query]);
  const myBots = state.bots.filter((b) => !b.hidden);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl bg-inset px-3.5 py-2">
        <Search size={15} className="text-ink-secondary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shared profiles…"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-secondary/60"
        />
      </div>
      {agents === null && <Empty>Scanning the commons…</Empty>}
      {agents !== null && visible.length === 0 && (
        <Empty>
          No shared profiles yet. Public is opt-in — when someone publishes a teammate's profile in “My profiles”,
          it appears here.
        </Empty>
      )}
      {visible.map((a) => (
        <div key={a.handle} className="rounded-xl bg-inset px-4 py-3">
          <div className="flex items-center gap-3">
            <BotDot color={a.color} name={a.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] text-ink">
                <strong>{a.name}</strong> <span className="text-ink-secondary">@{a.handle}</span>
              </p>
              <p className="truncate text-[12px] text-ink-secondary">{a.tagline || "no tagline"}</p>
            </div>
            <a
              href={`/p/${a.handle}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Profile
            </a>
            <button
              onClick={() => setRequesting(requesting?.handle === a.handle ? null : a)}
              disabled={myBots.length === 0}
              className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              Request
            </button>
          </div>
          {requesting?.handle === a.handle && <RequestComposer to={a} myBots={myBots.map((b) => ({ id: b.id, name: b.name }))} onDone={() => setRequesting(null)} />}
        </div>
      ))}
    </div>
  );
}

function RequestComposer({
  to,
  myBots,
  onDone,
}: {
  to: DirectoryAgent;
  myBots: { id: string; name: string }[];
  onDone: () => void;
}) {
  const { dispatch } = useStore();
  const [fromBotId, setFromBotId] = useState(myBots[0]?.id ?? "");
  const [message, setMessage] = useState("");
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-panel px-3 py-3">
      <div className="flex items-center gap-2">
        <select
          value={fromBotId}
          onChange={(e) => setFromBotId(e.target.value)}
          className="rounded-lg bg-inset px-2 py-1.5 text-[13px] text-ink outline-none"
          aria-label="Which teammate sends the request"
        >
          {myBots.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <span className="text-[13px] text-ink-secondary">→ @{to.handle}</span>
      </div>
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, SOCIAL_MESSAGE_MAX))}
        placeholder={`A short note for ${to.name}'s owner (optional)`}
        className="w-full rounded-lg bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised">Cancel</button>
        <button
          onClick={() => {
            if (!fromBotId) return;
            dispatch({ type: "sendFriendRequest", input: { fromBotId, toHandle: to.handle, message: message.trim() } });
            onDone();
          }}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
        >
          <Send size={13} /> Send request
        </button>
      </div>
    </div>
  );
}

// ── my profiles ────────────────────────────────────────────────────────
function ProfilesTab() {
  const { state, dispatch } = useStore();
  const social = state.social;
  const bots = state.bots.filter((b) => !b.hidden);
  if (!social) return <Empty>Loading…</Empty>;
  if (bots.length === 0) return <Empty>Muster a teammate first — profiles belong to bots.</Empty>;
  return (
    <div className="space-y-3">
      {bots.map((bot) => (
        <ProfileCard key={bot.id} botId={bot.id} name={bot.name} color={bot.color} profile={social.profiles.find((p) => p.botId === bot.id) ?? null} onSave={(input) => dispatch({ type: "setSocialProfile", input })} />
      ))}
    </div>
  );
}

function ProfileCard({
  botId,
  name,
  color,
  profile,
  onSave,
}: {
  botId: string;
  name: string;
  color: string;
  profile: SocialProfile | null;
  onSave: (input: { botId: string; tagline?: string; bio?: string; visibility: "private" | "public"; handle?: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [tagline, setTagline] = useState(profile?.tagline ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const isPublic = profile?.visibility === "public";
  return (
    <div className="rounded-xl bg-inset px-4 py-3">
      <div className="flex items-center gap-3">
        <BotDot color={color} name={name} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] text-ink">
            <strong>{name}</strong>
            {profile && <span className="text-ink-secondary"> @{profile.handle}</span>}
          </p>
          <p className="truncate text-[12px] text-ink-secondary">
            {profile ? (isPublic ? `Public · ${profile.tagline || "no tagline"}` : "Private — only you can see this teammate") : "No profile yet"}
          </p>
        </div>
        {profile && isPublic && (
          <a href={`/p/${profile.handle}`} target="_blank" rel="noreferrer" className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
            View
          </a>
        )}
        <button
          onClick={() => {
            if (editing) {
              onSave({ botId, tagline: tagline.trim(), bio: bio.trim(), handle: handle.trim().toLowerCase() || undefined, visibility: isPublic ? "public" : "private" });
            }
            setEditing(!editing);
          }}
          className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised"
        >
          {editing ? "Save" : profile ? "Edit" : "Create profile"}
        </button>
        {profile && (
          <button
            onClick={() => {
              const next = isPublic ? "private" : "public";
              onSave({ botId, tagline: profile.tagline, bio: profile.bio, visibility: next });
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-medium",
              isPublic ? "bg-danger/10 text-danger hover:bg-danger/20" : "bg-accent/15 text-accent hover:bg-accent/25",
            )}
          >
            {isPublic ? "Make private" : "Make public"}
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-3 space-y-2">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value.slice(0, 32))}
            placeholder="handle (lowercase, e.g. wren-scout)"
            className="w-full rounded-lg bg-panel px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value.slice(0, SOCIAL_TAGLINE_MAX))}
            placeholder={`One-line tagline (max ${SOCIAL_TAGLINE_MAX})`}
            className="w-full rounded-lg bg-panel px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value.slice(0, SOCIAL_BIO_MAX))}
            placeholder={`Short bio — what this teammate does (max ${SOCIAL_BIO_MAX})`}
            rows={3}
            className="w-full resize-none rounded-lg bg-panel px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          <p className="text-[11.5px] text-ink-secondary">
            Public means listed: handle, tagline and bio only — never transcripts, memory or your identity. Your
            handle is permanent once friends use it.
          </p>
        </div>
      )}
    </div>
  );
}
