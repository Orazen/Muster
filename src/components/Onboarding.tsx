import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, AlertTriangle, Loader2, Mic, ArrowLeft, Sparkles, ShieldCheck } from "lucide-react";
import { MusterBloom } from "./MusterBloom";
import { AgentAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, emailGateDone, serverGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { AGENT_CHARACTERS, AGENT_COLORS, AGENT_COLOR_NAMES, type AgentCharacter, type AgentColor } from "@/lib/mascot";
import { api, useStore, type Bot } from "@/state/store";
import { useAuth } from "@/lib/auth";
import type { InstanceInfo } from "@/state/store";
import { createOnboardingFinishSession } from "@/state/onboarding-finish";
import {
  clearOnboardingDraft,
  readOnboardingDraft,
  resolveInitialTaskDraft,
  saveOnboardingDraft,
} from "@/state/onboarding-draft";

// First-run onboarding, vellum-assistant style: a wizard that talks about the
// product by building it — welcome, live engine checks, assemble your first
// teammate (face + name), set its personality, permissions, then a concrete
// first task. Every step is skippable; finishing must never brick the app.
// The wizard is component state, not routes: browser Back stays inert, the
// same property vellum gets from replace-navigating one history entry.

type InstanceRow = InstanceInfo;

const STEP_LABELS = ["Welcome", "Engines", "Teammate", "Permissions", "First task"] as const;

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

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  // teammate state
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botColor, setBotColor] = useState<AgentColor>("orange");
  const [botCharacter, setBotCharacter] = useState<AgentCharacter>("star");


  // personality state
  const [axes, setAxes] = useState<Axes>(NEUTRAL_AXES);
  const [showPersonality, setShowPersonality] = useState(false);
  const about = useMemo(() => personalityAbout(axes), [axes]);

  // first task
  const [suggestion, setSuggestion] = useState("");
  const [customTask, setCustomTask] = useState("");
  const [creating, setCreating] = useState(false);
  // Setup failure keeps the wizard open with every input intact — the
  // message surfaces verbatim from the API (e.g. the free-tier bot cap).
  const [setupError, setSetupError] = useState("");
  // Re-entry guard: quick start, both skips, and the finish button all call
  // finish(); a double-click must not double-create or double-send.
  const finishingRef = useRef(false);
  const [finishSession] = useState(createOnboardingFinishSession);
  // Draft hydration runs once per account; saving starts only after it.
  const restoredRef = useRef(false);
  const [draftReady, setDraftReady] = useState(false);

  useEffect(() => {
    finishSession.activate();
    return () => finishSession.dispose();
  }, [finishSession]);

  // Browser mic permission (web only — desktop uses the OS TCC flow below).
  const [webMic, setWebMic] = useState<"prompt" | "granted" | "denied" | "unsupported">("prompt");
  const isDesktop = Boolean(window.ogb);

  // Existing users skip silently: decide only once the store has connected,
  // so a slow SSE doesn't flash the wizard over a populated roster. A fresh
  // install is never empty — seedIfEmpty() plants one greeting-only bot — so
  // "has a user ever said anything" is the real existing-user signal, not
  // bot count. The gate flag doubles as "has seen onboarding" and lives on
  // the ACCOUNT (server) with this browser's localStorage as the fast path:
  // an account that finished via email sign-in must not see the wizard
  // again on its next Google sign-in, or vice versa.
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    if (decided || !state.connected) return;
    const hasRealHistory = state.bots.some((b) => b.messages.some((m) => m.role === "user"));
    let cancelled = false;
    void serverGateDone().then((serverDone) => {
      if (cancelled) return;
      setDecided(true);
      if (serverDone || emailGateDone(user?.id)) {
        onDone();
      } else if (hasRealHistory) {
        setEmailGateDone(user?.id, "skipped");
        onDone();
      } else if (user) {
        setName(user.name ?? "");
        setEmail(user.email ?? "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [decided, state.connected, state.bots, user, onDone]);

  // Prefill the profile step from the account identity as soon as it is
  // known — independent of the decide-effect above, which settles on store
  // connect and can beat better-auth's session fetch (user still undefined
  // when the gate resolves), leaving step 1 empty for a signed-in account.
  // `current ||` keeps anything the user already typed.
  useEffect(() => {
    if (!user || draftReady) return;
    setName((current) => current || user.name || "");
    setEmail((current) => current || user.email || "");
  }, [user, draftReady]);

  // Draft hydration: a reload or the sign-in round trip used to wipe every
  // field. Restore once per account before exposing editable controls,
  // and prefill the first task from an allowlisted
  // ?template= id only when nothing better is at hand. Templates never
  // auto-send; sending stays an explicit finish-button press.
  useEffect(() => {
    if (!user || !decided || restoredRef.current) return;
    restoredRef.current = true;
    const stored = readOnboardingDraft(user.id);
    if (stored) {
      if (stored.name !== undefined) setName(stored.name);
      if (stored.email !== undefined) setEmail(stored.email);
      setStep(stored.step);
      setBotName((current) => current || stored.botName);
      setBotRole((current) => current || stored.botRole);
      const savedColor = AGENT_COLOR_NAMES.find((color) => color === stored.botColor);
      const savedCharacter = AGENT_CHARACTERS.find((character) => character === stored.botCharacter);
      if (savedColor) setBotColor(savedColor);
      if (savedCharacter) setBotCharacter(savedCharacter);
      setAxes(stored.axes);
      setShowPersonality(stored.showPersonality);
    }
    const firstTask = resolveInitialTaskDraft(stored, new URLSearchParams(window.location.search).get("template"));
    setSuggestion(firstTask.suggestion);
    setCustomTask(firstTask.customTask);
    setDraftReady(true);
  }, [user, decided]);

  // Persist the draft while the wizard is open — strictly after hydration,
  // so the first paint never overwrites the stored draft with pristine
  // state. Cleared on success and deliberate abandonment (Escape / Maybe
  // later); a failed finish keeps it, so nothing typed is lost.
  useEffect(() => {
    if (!draftReady || !user) return;
    saveOnboardingDraft(user.id, {
      version: 1,
      name,
      email,
      step,
      botName,
      botRole,
      botColor,
      botCharacter,
      suggestion,
      customTask,
      showPersonality,
      axes,
    });
  }, [draftReady, user, name, email, step, botName, botRole, botColor, botCharacter, suggestion, customTask, showPersonality, axes]);

  useEffect(() => {
    track("onboarding_step", { step, name: STEP_LABELS[step] });
  }, [step]);

  // Escape dismisses onboarding and persists the skip — the modal is
  // full-screen with no backdrop click target, so keyboard was the only
  // sane escape hatch (it previously had none at all).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || finishingRef.current || !finishSession.active) return;
      track("email_skipped");
      setEmailGateDone(user?.id, "skipped");
      // Deliberate abandonment discards the draft — it exists to protect
      // against accidental loss (reload, auth bounce, failure), not to
      // resurrect sessions the user walked away from.
      clearOnboardingDraft(user?.id);
      onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user?.id, onDone, finishSession]);

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
    if (step === 3 && capabilities.dictation.available) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  useEffect(() => {
    if (step !== 3 || isDesktop) return;
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

  /** Finish: reuse an eligible greeting bot when present, create only when
   * nothing is eligible, then hand off to chat.
   * Responses are checked through api(); a failure keeps the wizard open
   * with every input preserved, surfaces the API's message, and never
   * marks the gate done. */
  const finish = async () => {
    if (finishingRef.current || !finishSession.active) return;
    finishingRef.current = true;
    setCreating(true);
    setSetupError("");
    let completing = false;
    try {
      const task = customTask.trim() || suggestion.trim();
      const result = await finishSession.finish({
        // SSE connected is not a roster/history readiness signal. Read the
        // authenticated snapshot before choosing or creating a teammate.
        readRoster: async () => {
          const snapshot: { bots: Bot[] } = await api("/api/bots");
          return snapshot.bots;
        },
        identity: botName.trim()
          ? { name: botName.trim(), color: botColor, character: botCharacter, title: botRole.trim(), description: about }
          : null,
        task,
        createBot: () => api("/api/bots", { method: "POST" }),
        patchBot: (botId, persona) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({
              name: persona.name,
              color: persona.color,
              character: persona.character,
              title: persona.title,
              description: persona.description,
            }),
          }),
        // Select before sending, so a fast SSE reply cannot be overwritten
        // later by the pre-send roster snapshot.
        onBotReady: (bot) => dispatch({ type: "botAdded", bot: { ...bot, messages: bot.messages ?? [] } }),
        sendTask: (botId, text) => api(`/api/bots/${botId}/messages`, {
          method: "POST",
          body: JSON.stringify({ text }),
        }),
      });
      if (!result || !finishSession.active) return;
      if (result.message) dispatch({ type: "messageAdded", threadId: result.bot.threadId, message: result.message });
      completing = true;
      // Persist the account gate only after task acceptance. If this request
      // fails, the session retains its accepted result and retry only repeats
      // completion; the task is never sent again for a bookkeeping failure.
      await api("/api/me/onboarding", {
        method: "PUT",
        body: JSON.stringify({ status: "submitted" }),
      });
      if (!finishSession.active) return;
      clearOnboardingDraft(user?.id);
      try {
        track("onboarding_completed", {
          engines_available: instances?.filter((i) => i.snapshot.state === "available").length ?? -1,
          mic: perms?.mic ?? "n/a",
          teammate: Boolean(botName.trim()),
          first_task: Boolean(result.task),
        });
      } catch {
        // Analytics must not turn an accepted task into a retryable failure.
      }
      onDone();
    } catch (error) {
      if (!finishSession.active) return;
      setSetupError(
        completing
          ? "Your teammate is ready, but saving setup failed. Try again to finish — your task will not be sent again."
          : error instanceof Error && error.message
          ? error.message
          : "Setting up your teammate failed — try again.",
      );
    } finally {
      finishingRef.current = false;
      if (finishSession.active) setCreating(false);
    }
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

  if (!decided || !draftReady) return null;

  // dense array indexed by step — steps are 0..5 by construction
  const stepContent = [
    (
      <div className="flex flex-col items-center">
        <MusterBloom size={96} wordmark />
        <h1 className="mt-4 text-[20px] font-semibold text-ink">Welcome to Muster</h1>
        <p className="mt-1.5 text-center text-[14px] leading-relaxed text-ink-secondary">
          A roster of AI agents that do real work on their own computer. Let&rsquo;s set yours up —
          it takes a minute.
        </p>
        {/* Trust line: the top question a first-run user has is "where does
            my stuff go" — answer it before they type anything (pattern from
            local-first peers). Desktop is genuinely local; web holds provider
            keys per account, so say "yours" without claiming on-device. */}
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <ShieldCheck size={13} className="shrink-0 text-[#38d591]" />
          {isDesktop
            ? "Local-first: your keys and transcripts stay on your machine, and every bot asks before acting."
            : "Your keys stay yours, and every bot asks before acting on anything risky."}
        </p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          className="mt-5 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
          placeholder="you@example.com"
          aria-label="Email address"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={saveProfile}
          className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
        >
          Continue
        </button>
        {/* Vellum-style express path: one click from welcome into a working
            app — finish() plants the default greeting bot and skips every
            optional screen. The full wizard stays available via Continue. */}
        <button
          onClick={() => {
            track("onboarding_quick_start");
            finish();
          }}
          disabled={creating}
          className="mt-2 w-full rounded-lg border border-hairline/60 bg-raised py-2 text-[13.5px] font-medium text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
        >
          Quick start — skip setup, just get me in
        </button>
        <button
          onClick={() => {
            track("email_skipped");
            // "Maybe later" means come back never: persist the gate so the
            // modal stops reappearing on every reload (web audit 2026-08-23
            // found it bouncing straight back because nothing was saved).
            setEmailGateDone(user?.id, "skipped");
            // Deliberate abandonment discards the draft (same rule as Escape).
            clearOnboardingDraft(user?.id);
            onDone();
          }}
          disabled={creating}
          className="mt-3 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
        >
          Maybe later
        </button>
      </div>
    ),

    (
      <div className="flex min-h-0 flex-col">
        <h1 className="text-[18px] font-semibold text-ink">
          {isDesktop ? "Your engines" : "Connect a provider"}
        </h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          {isDesktop
            ? "Bots run on AI tools installed on this computer — here's what we found."
            : "Web bots run on API-key providers — Claude, GPT, Gemini and more. Paste a key now, or set it up later in Settings → Providers."}
        </p>
        {/* Subscription path (free-trial spec): most people already pay for
            ChatGPT Plus or Claude Pro — say out loud that those count, and
            point desktop users at the CLI engines that use them directly.
            No hosted inference, no new billing surface needed. */}
        <div className="mt-3 rounded-lg border border-accent/25 bg-accent/8 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-secondary">
          {isDesktop ? (
            <>
              <span className="font-medium text-ink">Already have ChatGPT Plus or Claude Pro?</span> The
              engines below log in with your existing subscription — no API key required for those.
            </>
          ) : (
            <>
              <span className="font-medium text-ink">Already have ChatGPT Plus or Claude Pro?</span> Download
              the Muster desktop app to use your subscription directly through its CLI engines — no API
              key needed. Or paste a provider key to stay on the web.
            </>
          )}
        </div>
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
              {isDesktop && setupEngines.length > 0 && (
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
        {!isDesktop && (
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "providers" })}
            className="mt-4 w-full shrink-0 rounded-lg border border-hairline/60 bg-raised py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-raised-hover"
          >
            Add a provider key
          </button>
        )}
        <button
          onClick={() => setStep(2)}
          className="mt-5 w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
        >
          Continue
        </button>
        <button
          onClick={() => setStep(2)}
          className="mt-2 w-full shrink-0 text-[12.5px] text-ink-secondary transition-colors hover:text-ink"
        >
          Set up later
        </button>
      </div>
    ),

    (
      <div className="flex min-h-0 flex-col">
        {/* Vellum-style: centered column, avatar front-and-center, scroll strips below */}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4">
          <div className="flex items-center justify-center py-2">
            <AgentAvatar
              color={botColor}
              character={botCharacter}
              size={160}
              state={botName.trim() ? "happy" : "idle"}
              animated
            />
          </div>

          {(botName.trim() || botRole.trim()) && (
            <p className="-mt-1 text-center">
              <span className="text-[16px] font-semibold text-ink">{botName.trim() || "Your teammate"}</span>
              {botRole.trim() && <span className="ml-1.5 text-[13px] text-ink-secondary">· {botRole.trim()}</span>}
            </p>
          )}

          {/* Shape strip — horizontal scroll, musterbot shapes */}
          <div className="w-full max-w-md overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-2">
              {AGENT_CHARACTERS.filter((c) => !["cursor", "lottie", "star", "capsule"].includes(c)).map((sh) => (
                <button
                  key={sh}
                  onClick={() => setBotCharacter(sh)}
                  aria-label={sh}
                  aria-pressed={botCharacter === sh}
                  className={`flex size-[52px] shrink-0 items-center justify-center rounded-xl border transition ${
                    botCharacter === sh ? "border-accent bg-raised" : "border-hairline/30 hover:bg-raised"
                  }`}
                >
                  <AgentAvatar color={botColor} character={sh} size={38} state="idle" animated={false} />
                </button>
              ))}
              <button
                onClick={() => setBotCharacter("star")}
                aria-label="Star"
                aria-pressed={botCharacter === "star"}
                className={`flex size-[52px] shrink-0 items-center justify-center rounded-xl border transition ${
                  botCharacter === "star" ? "border-accent bg-raised" : "border-hairline/30 hover:bg-raised"
                }`}
              >
                <AgentAvatar color={botColor} character="star" size={38} state="idle" animated={false} />
              </button>
            </div>
          </div>

          {/* Colour strip — horizontal scroll */}
          <div className="w-full max-w-md overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-1.5">
              {AGENT_COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  onClick={() => setBotColor(c)}
                  aria-label={c}
                  aria-pressed={botColor === c}
                  className={`size-7 shrink-0 rounded-full transition ${
                    botColor === c ? "ring-2 ring-accent ring-offset-1 ring-offset-app" : "hover:brightness-110"
                  }`}
                  style={{ background: AGENT_COLORS[c] }}
                />
              ))}
            </div>
          </div>

          {/* Identity */}
          <input
            autoFocus
            type="text"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="Name your teammate (e.g. Scout)"
            aria-label="Teammate name"
            className="mt-1 w-full max-w-sm rounded-lg border border-hairline/40 bg-inset px-3.5 py-2.5 text-center text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <input
            type="text"
            value={botRole}
            onChange={(e) => setBotRole(e.target.value)}
            placeholder="Role — research, writing, ops… (optional)"
            aria-label="Teammate role (optional)"
            className="w-full max-w-sm rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-center text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />

          {/* Collapsed in from the old dedicated Personality step: optional,
              off by default so the default path stays one screen shorter. */}
          <button
            onClick={() => setShowPersonality((s) => !s)}
            className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-secondary hover:text-ink"
          >
            <Sparkles size={12} /> {showPersonality ? "Hide personality" : "Tune its personality (optional)"}
          </button>
          {showPersonality && (
            <div className="w-full max-w-sm rounded-xl bg-card p-3.5">
              <div className="flex flex-col gap-2.5">
                {AXES.map(({ key, left, right }) => (
                  <div key={key}>
                    <div className="flex items-center justify-between text-[11.5px] text-ink-secondary">
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
                      className="mt-0.5 w-full accent-[var(--color-accent)]"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 border-t border-hairline/30 pt-2 text-[12px] leading-relaxed text-ink-secondary">
                {about}
              </div>
            </div>
          )}

          <div className="mt-2 flex w-full max-w-sm gap-3">
            <button
              onClick={() => setStep(1)}
              disabled={creating}
              className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[14px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              Back to Engines
            </button>
            <button
              onClick={() => (botName.trim() ? setStep(3) : finish())}
              disabled={creating}
              className="flex-1 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:opacity-40"
            >
              {creating ? "Setting up…" : botName.trim() ? "Continue" : "Skip — no teammate yet"}
            </button>
          </div>
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
            onClick={() => setStep(3)}
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
        <button onClick={finish} disabled={creating} className="mt-3 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40">
          Skip for now
        </button>
        {/* Set the expectation before the handoff: the wizard closes into a
            working conversation, not a dashboard — say so, and repeat the
            approval guarantee once now that a real task is about to run. */}
        <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-secondary">
          {botName.trim() ? `${botName.trim()} gets` : "Your bot gets"} straight to work — you&rsquo;ll see it think and act,
          and it asks you before anything risky.
        </p>
      </div>
    ),
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-app p-4">
      <div aria-hidden="true" className="onboarding-scene">
        <div className="onboarding-petal onboarding-petal-a"><MusterBloom size={480} interactive={false} /></div>
        <div className="onboarding-petal onboarding-petal-b"><MusterBloom size={360} interactive={false} /></div>
        <div className="onboarding-petal onboarding-petal-c"><MusterBloom size={120} interactive={false} /></div>
      </div>
      <div
        className={`onboarding-card flex max-h-full min-h-0 w-full flex-col rounded-2xl border border-hairline/40 bg-panel/95 p-6 shadow-xl backdrop-blur-xl sm:p-8 ${
          step === 1 ? "max-w-[680px]" : "max-w-[460px]"
        }`}
      >
        {/* progress: step label carries the intent ("What are we doing"),
            the dots just keep count — Mercury's label-first grammar */}
        <div className="mb-2 text-center text-[11px] font-semibold uppercase tracking-[0.32em] text-ink-secondary">
          {STEP_LABELS[step]}
        </div>
        <div
          className="mb-6 flex items-center justify-center gap-1.5"
          aria-label={`Step ${step + 1} of ${STEP_LABELS.length}: ${STEP_LABELS[step]}`}
        >
          {STEP_LABELS.map((label, i) => (
            <span
              key={label}
              className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-accent" : i < step ? "w-1.5 bg-accent/50" : "w-1.5 bg-hairline"}`}
            />
          ))}
        </div>
        {/* No AnimatePresence here: its mode="wait" exit handshake hung on
            framer-motion v13, leaving the previous step mounted with the
            new step's label — the wizard became un-navigable mid-funnel.
            A hard swap is boring and always correct. */}
        <fieldset key={step} disabled={creating} className="wizard-step m-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain border-0 px-1 pb-1 pt-0">
          {stepContent[step]}
        </fieldset>
        {/* Recovery: a failed finish keeps the wizard open with every input
            intact and says what went wrong, instead of closing on a failure
            like it used to. */}
        {setupError && (
          <div
            role="alert"
            className="mx-1 mt-3 flex items-start gap-2 rounded-xl border border-[#ff5c5c40] bg-[#ff5c5c14] px-3.5 py-2.5 text-[13px] leading-relaxed text-ink"
          >
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#ff7a7a]" />
            <span>{setupError}</span>
          </div>
        )}
        {step === 1 && (
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
