import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, AlertTriangle, Loader2, Mic, ArrowLeft, Sparkles } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AgentAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, emailGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { AGENT_CHARACTERS, AGENT_COLORS, AGENT_COLOR_NAMES, type AgentCharacter, type AgentColor } from "@/lib/mascot";
import { useStore } from "@/state/store";
import { useAuth } from "@/lib/auth";
import type { InstanceInfo } from "@/state/store";

// First-run onboarding, vellum-assistant style: a wizard that talks about the
// product by building it — welcome, live engine checks, assemble your first
// teammate (face + name), set its personality, permissions, then a concrete
// first task. Every step is skippable; finishing must never brick the app.
// The wizard is component state, not routes: browser Back stays inert, the
// same property vellum gets from replace-navigating one history entry.

type InstanceRow = InstanceInfo;

const STEP_LABELS = ["Welcome", "Engines", "Teammate", "Personality", "Permissions", "First task"] as const;

function StatusRow({
  ok,
  warn,
  title,
  detail,
  mark,
  children,
}: {
  ok: boolean;
  warn?: boolean;
  title: string;
  detail?: string;
  mark?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card p-3.5">
      <span
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
          ok ? "bg-[#00c97222] text-[#38d591]" : warn ? "bg-[#ff980022] text-[#ff9800]" : "bg-raised text-ink-secondary"
        }`}
      >
        {ok ? <Check size={14} /> : <AlertTriangle size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          {mark}
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {detail && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

interface EngineEntry {
  instance: InstanceRow;
  label: string;
  readyNote: string;
}

function engineReady(instance: InstanceRow): boolean {
  return (
    instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false)
  );
}

function engineTitle({ instance, label }: EngineEntry): string {
  const version = instance?.snapshot.version ? ` · ${instance.snapshot.version.split(" ")[0]}` : "";
  return `${label}${version}`;
}

function ReadyTile(entry: EngineEntry) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-card p-3">
      <ProviderMark driverKind={entry.instance.driverKind} size={17} />
      <div className="min-w-0">
        <div className="truncate text-[13.5px] font-medium text-ink">{engineTitle(entry)}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">{entry.readyNote}</div>
      </div>
    </div>
  );
}

function SetupRow(entry: EngineEntry) {
  return (
    <StatusRow
      ok={false}
      warn
      title={engineTitle(entry)}
      mark={<ProviderMark driverKind={entry.instance.driverKind} size={16} />}
    >
      <EngineSetup
        instance={entry.instance}
        className="mt-0.5"
        intent={entry.instance.access === "custom" ? "inject" : "cloud"}
      />
    </StatusRow>
  );
}

/* ── Personality ──
 * Five axes, vellum's vocabulary mapped to how a Muster bot is prompted.
 * The sliders generate the About text that lands in the bot's system
 * prompt (server/index.ts builds its persona from title + description). */

const AXES = [
  { key: "companion", left: "Companion", right: "Coworker" },
  { key: "tone", left: "Gen Z", right: "Boomer" },
  { key: "independence", left: "Independent", right: "Collaborative" },
  { key: "depth", left: "Concise", right: "Thorough" },
  { key: "honesty", left: "Polite", right: "Unfiltered" },
] as const;

type AxisKey = (typeof AXES)[number]["key"];
type Axes = Record<AxisKey, number>;

const NEUTRAL_AXES = { companion: 62, tone: 50, independence: 40, depth: 55, honesty: 60 } satisfies Axes;

function personalityAbout(a: Axes): string {
  const pick = (v: number, lo: string, mid: string, hi: string) => (v < 35 ? lo : v > 65 ? hi : mid);
  return [
    pick(a.companion, "Warm and companion-like — the conversation matters, not just the output.", "Friendly but businesslike.", "A pragmatic coworker — outcomes over pleasantries."),
    pick(a.tone, "Casual, internet-native tone.", "Natural, neutral tone.", "Measured, experienced tone."),
    pick(a.independence, "Works independently; checks in only when it truly matters.", "Independent by default, collaborative when stakes are high.", "Collaborative — aligns before acting."),
    pick(a.depth, "Answers are short and to the point.", "Concise by default, detailed when it counts.", "Thorough — shows reasoning and covers edge cases."),
    pick(a.honesty, "Diplomatic and tactful.", "Honest with tact.", "Blunt and unfiltered — says what needs saying."),
  ].join(" ");
}

/* ── First-task suggestions ── */

const SUGGESTIONS = [
  { title: "Get on top of my week", prompt: "Help me get on top of my week — ask what's on my plate and figure out what to prioritize." },
  { title: "Brief me on my field", prompt: "Put together a quick brief on what's new in my field right now." },
  { title: "Draft from rough notes", prompt: "I'll paste some rough notes — turn them into a polished first draft." },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const { state, dispatch } = useStore();
  const { user } = useAuth();
  const reduced = useReducedMotion();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  // teammate state
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botColor, setBotColor] = useState<AgentColor>("green");
  const [botCharacter, setBotCharacter] = useState<AgentCharacter>("star");

  // personality state
  const [axes, setAxes] = useState<Axes>(NEUTRAL_AXES);
  const about = useMemo(() => personalityAbout(axes), [axes]);

  // first task
  const [suggestion, setSuggestion] = useState("");
  const [customTask, setCustomTask] = useState("");
  const [creating, setCreating] = useState(false);

  // Browser mic permission (web only — desktop uses the OS TCC flow below).
  const [webMic, setWebMic] = useState<"prompt" | "granted" | "denied" | "unsupported">("prompt");
  const isDesktop = Boolean(window.ogb);

  // Existing users skip silently: decide only once the store has connected,
  // so a slow SSE doesn't flash the wizard over a populated roster. A fresh
  // install is never empty — seedIfEmpty() plants one greeting-only bot — so
  // "has a user ever said anything" is the real existing-user signal, not
  // bot count. The old email-gate flag doubles as "has seen onboarding".
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    if (decided || !state.connected) return;
    setDecided(true);
    const hasRealHistory = state.bots.some((b) => b.messages.some((m) => m.role === "user"));
    if (emailGateDone(user?.id)) {
      onDone();
    } else if (hasRealHistory) {
      setEmailGateDone(user?.id, "skipped");
      onDone();
    } else if (user) {
      setName(user.name ?? "");
      setEmail(user.email ?? "");
    }
  }, [decided, state.connected, state.bots, user, onDone]);

  useEffect(() => {
    track("onboarding_step", { step, name: STEP_LABELS[step] });
  }, [step]);

  useEffect(() => {
    if (step !== 1) return;
    let active = true;
    let latestRequest = 0;
    const refresh = () => {
      const request = ++latestRequest;
      fetch("/api/instances")
        .then((r) => r.json())
        .then((d) => active && request === latestRequest && setInstances(d.instances ?? []))
        .catch(() => active && request === latestRequest && setInstances([]));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [step]);

  useEffect(() => {
    if (step === 4 && capabilities.dictation.available) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  useEffect(() => {
    if (step !== 4 || isDesktop) return;
    navigator.permissions
      ?.query(
        // SAFETY: "microphone" is valid at runtime in every browser that
        // ships navigator.permissions; TS's DOM lib predates it.
        { name: "microphone" as PermissionName },
      )
      .then((status) => {
        setWebMic(status.state);
        status.onchange = () => setWebMic(status.state);
      })
      .catch(() => setWebMic("unsupported"));
  }, [step, isDesktop]);

  const enableWebMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setWebMic("granted");
    } catch {
      setWebMic("denied");
    }
  };

  const saveProfile = () => {
    if (valid) {
      identifyEmail(email.trim().toLowerCase());
      // persisted server-side (~/.muster/config.json) — the sidebar
      // footer reads it back through /api/config
      void fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
      }).catch(() => {});
    }
    setStep(1);
  };

  /** Finish: assemble the teammate (if one was named), hand off to chat.
   * Bot creation is best-effort — a failed POST must not trap the user
   * in the wizard. */
  const finish = async () => {
    track("onboarding_completed", {
      engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
      mic: perms?.mic ?? "n/a",
      teammate: Boolean(botName.trim()),
      first_task: (customTask.trim() || suggestion.trim()) || null,
    });
    const task = customTask.trim() || suggestion.trim();
    if (botName.trim()) {
      setCreating(true);
      try {
        const created = await fetch("/api/bots", { method: "POST" }).then((r) => r.json());
        const patched = await fetch(`/api/bots/${created.bot.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: botName.trim(),
            color: botColor,
            character: botCharacter,
            title: botRole.trim(),
            description: about,
          }),
        }).then((r) => r.json());
        // botAdded also selects the bot and switches to the chat view —
        // the handoff lands the user in their teammate's conversation
        dispatch({ type: "botAdded", bot: { ...patched.bot, messages: created.bot.messages } });
        if (task) dispatch({ type: "send", botId: patched.bot.id, text: task });
      } catch {
        // leave the user in the app; they can create a bot any time
      }
      setCreating(false);
    }
    setEmailGateDone(user?.id, "submitted");
    onDone();
  };

  const engines: EngineEntry[] = (instances ?? [])
    .filter((instance) => instance.install)
    .map((instance) => ({
      instance,
      label: instance.displayName,
      readyNote:
        instance.access === "custom"
          ? "Installed — ready for a local model."
          : "Installed — ready to power bots.",
    }));
  const readyEngines = engines.filter((e) => engineReady(e.instance));
  const setupEngines = engines.filter((e) => !engineReady(e.instance));

  if (!decided) return null;

  // dense array indexed by step — steps are 0..5 by construction
  const stepContent = [
    (
      <div className="flex flex-col items-center">
        <AgentAvatar color="green" character="star" state="happy" size={72} />
        <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to Muster</h1>
        <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
          A roster of AI agents that do real work on their own computer. Let&rsquo;s set yours up —
          it takes a minute.
        </p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
          placeholder="you@example.com"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={saveProfile}
          className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
        >
          Continue
        </button>
        <button
          onClick={() => {
            track("email_skipped");
            setStep(1);
          }}
          className="mt-3 text-[12px] text-ink-secondary hover:text-ink"
        >
          Maybe later
        </button>
      </div>
    ),

    (
      <div className="flex min-h-0 flex-col">
        <h1 className="text-[18px] font-semibold text-ink">Your engines</h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          Bots run on AI tools installed on this computer — here&rsquo;s what we found.
        </p>
        <div className="mt-4 flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {!instances ? (
            <div className="flex items-center gap-2 py-6 text-ink-secondary">
              <Loader2 size={16} className="animate-spin" /> Checking…
            </div>
          ) : (
            <>
              {readyEngines.length > 0 && (
                <>
                  <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Ready</div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {readyEngines.map((e) => (
                      <ReadyTile key={e.label} {...e} />
                    ))}
                  </div>
                </>
              )}
              {setupEngines.length > 0 && (
                <>
                  <div className={`text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary ${readyEngines.length ? "mt-2" : ""}`}>
                    Needs setup
                  </div>
                  {setupEngines.map((e) => (
                    <SetupRow key={e.label} {...e} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
        <button
          onClick={() => setStep(2)}
          className="mt-5 w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
        >
          Continue
        </button>
      </div>
    ),

    (
      <div className="flex min-h-0 flex-col">
        <h1 className="text-[18px] font-semibold text-ink">Meet your first teammate</h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          Give one agent a face and a name. You can add more any time.
        </p>
        <div className="mt-4 grid grid-cols-4 justify-items-center gap-2">
          {AGENT_CHARACTERS.map((character) => (
            <button
              key={character}
              onClick={() => setBotCharacter(character)}
              aria-pressed={botCharacter === character}
              className={`flex w-full flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-colors ${
                botCharacter === character ? "border-accent bg-raised" : "border-hairline/40 hover:bg-raised"
              }`}
            >
              <AgentAvatar color={botColor} character={character} size={44} state="happy" />
              <span className="text-[10.5px] capitalize text-ink-secondary">{character}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {AGENT_COLOR_NAMES.map((c) => (
            <button
              key={c}
              onClick={() => setBotColor(c)}
              aria-label={`Color: ${c}`}
              aria-pressed={botColor === c}
              className={`size-6 rounded-full transition-transform ${
                botColor === c ? "scale-110 ring-2 ring-ink ring-offset-2 ring-offset-panel" : "hover:scale-105"
              }`}
              style={{ backgroundColor: AGENT_COLORS[c] }}
            />
          ))}
        </div>
        <input
          autoFocus
          type="text"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && botName.trim() && setStep(3)}
          placeholder="Name your teammate (e.g. Scout)"
          className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <input
          type="text"
          value={botRole}
          onChange={(e) => setBotRole(e.target.value)}
          placeholder="Role — research, writing, ops… (optional)"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(1)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => (botName.trim() ? setStep(3) : finish())}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
          >
            {botName.trim() ? "Continue" : "Skip — no teammate yet"}
          </button>
        </div>
      </div>
    ),

    (
      <div className="flex min-h-0 flex-col">
        <h1 className="text-[18px] font-semibold text-ink">How should {botName.trim() || "your teammate"} behave?</h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          This becomes its personality — it writes how the bot thinks and talks.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {AXES.map(({ key, left, right }) => (
            <div key={key}>
              <div className="flex items-center justify-between text-[12px] text-ink-secondary">
                <span>{left}</span>
                <span>{right}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={axes[key]}
                aria-label={`${left} to ${right}`}
                onChange={(e) => setAxes((a) => ({ ...a, [key]: Number(e.target.value) }))}
                className="mt-1 w-full accent-[var(--color-accent)]"
              />
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-card p-3.5 text-[13px] leading-relaxed text-ink-secondary">
          <span className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide">
            <Sparkles size={12} /> What your bot gets
          </span>
          {about}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(2)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => setStep(4)}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
          >
            Continue
          </button>
        </div>
      </div>
    ),

    (
      <div className="flex flex-col">
        <h1 className="text-[18px] font-semibold text-ink">Permissions</h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          Optional, and only ever used when you ask for the feature.
        </p>
        <div className="mt-4 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-3.5">
            <div className="flex items-start gap-3">
              <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[14px] font-medium text-ink">Microphone & speech</div>
                <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                  {isDesktop
                    ? "Voice dictation into the composer, transcribed on-device."
                    : "Voice input in the composer — your browser will ask for access."}
                </div>
              </div>
            </div>
            {isDesktop ? (
              perms?.mic === "granted" ? (
                <Check size={16} className="shrink-0 text-[#38d591]" />
              ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("mic")}
                  className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              ) : (
                <button
                  onClick={() =>
                    window.ogb?.permRequestMic?.().then(() => window.ogb?.permStatus?.().then(setPerms))
                  }
                  className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                >
                  Enable
                </button>
              )
            ) : webMic === "granted" ? (
              <Check size={16} className="shrink-0 text-[#38d591]" />
            ) : webMic === "denied" ? (
              <span className="shrink-0 text-[12px] text-ink-secondary">Blocked in site settings</span>
            ) : webMic === "unsupported" ? (
              <span className="shrink-0 text-[12px] text-ink-secondary">Not available here</span>
            ) : (
              <button
                onClick={enableWebMic}
                className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
              >
                Enable
              </button>
            )}
          </div>
          {/* Screen Recording deliberately has no row here: macOS 15+
              makes a pre-grant unreliable (per-process status caching,
              helper misattribution, periodic re-prompts) — the OS flow
              triggers on the first real capture in the Computer panel,
              which is the moment the user has context for the dialog. */}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(3)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => setStep(5)}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
          >
            Continue
          </button>
        </div>
      </div>
    ),

    (
      <div className="flex flex-col">
        <h1 className="text-[18px] font-semibold text-ink">
          {botName.trim() ? `Give ${botName.trim()} a first task` : "Start with a task"}
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          Pick one to jump in, or skip and start your own thing.
        </p>
        <div className="mt-4 flex flex-col gap-2.5">
          {SUGGESTIONS.map((s) => {
            const selected = suggestion === s.prompt && !customTask.trim();
            return (
              <button
                key={s.title}
                onClick={() => {
                  setSuggestion(s.prompt);
                  setCustomTask("");
                }}
                aria-pressed={selected}
                className={`rounded-xl border p-3.5 text-left transition-colors ${
                  selected ? "border-accent bg-raised" : "border-hairline/40 bg-card hover:bg-raised"
                }`}
              >
                <div className="text-[14px] font-medium text-ink">{s.title}</div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{s.prompt}</div>
              </button>
            );
          })}
          <input
            type="text"
            value={customTask}
            onChange={(e) => setCustomTask(e.target.value)}
            placeholder="Or type your own first task…"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(4)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={finish}
            disabled={creating}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {creating ? "Setting up…" : botName.trim() ? `Muster ${botName.trim()} →` : "Start using Muster"}
          </button>
        </div>
        <button onClick={finish} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
          Skip for now
        </button>
      </div>
    ),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app p-8">
      <div
        className={`flex max-h-full w-full flex-col rounded-2xl border border-hairline/40 bg-panel p-8 ${
          step === 1 ? "max-w-[680px]" : "max-w-[460px]"
        }`}
      >
        {/* progress dots — one per step, filled up to the current one */}
        <div className="mb-5 flex items-center justify-center gap-1.5" aria-label={`Step ${step + 1} of ${STEP_LABELS.length}: ${STEP_LABELS[step]}`}>
          {STEP_LABELS.map((label, i) => (
            <span
              key={label}
              className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-accent" : i < step ? "w-1.5 bg-accent/50" : "w-1.5 bg-hairline"}`}
            />
          ))}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={reduced ? false : { opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? undefined : { opacity: 0, x: -18 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {stepContent[step]}
          </motion.div>
        </AnimatePresence>
        {step > 0 && step !== 5 && (
          <button
            onClick={() => setStep(step - 1)}
            className="mt-4 flex items-center gap-1 self-center text-[12px] text-ink-secondary hover:text-ink"
          >
            <ArrowLeft size={12} /> Back to {STEP_LABELS[step - 1]}
          </button>
        )}
      </div>
    </div>
  );
}
