import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  AlertTriangle,
  Loader2,
  Mic,
  ArrowLeft,
  Sparkles,
  ShieldCheck,
  GitBranch,
  MessageSquare,
  Mail,
  Calendar,
  Globe,
  MessagesSquare,
  BellRing,
  Lock,
} from "lucide-react";
import { FlowerCharacter } from "@/components/FlowerCharacter";
import { speaker } from "@/lib/tts";
import { AgentAvatar } from "./Avatar";
import { identifyEmail, setEmailGateDone, emailGateDone, serverGateDone, consumeTourReplay, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { AGENT_CHARACTERS, AGENT_COLORS, AGENT_COLOR_NAMES, type AgentCharacter, type AgentColor, type AgentState } from "@/lib/mascot";
import { api, useStore, type Bot } from "@/state/store";
import { useAuth } from "@/lib/auth";
import type { InstanceInfo } from "@/state/store";
import { createOnboardingFinishSession } from "@/state/onboarding-finish";
import {
  clearOnboardingDraft,
  ONBOARDING_STEPS,
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

const STEP_LABELS = ONBOARDING_STEPS.map((step) => step.label);

/** The guide's expression per beat — the mascot as a single guide through the
 * whole wizard (the OMB welcome-flow pattern). Faces come from the shipped
 * character vocabulary; the narrated line mirrors the step's job in first
 * person, so the guide always tells the truth about where you are. Dense
 * array indexed by step, like stepContent — steps are 0..6 by construction. */
const GUIDE_BEATS: ReadonlyArray<{ state: AgentState; line: string }> = [
  { state: "happy", line: "Hi! I'll set your team up in a minute." },
  { state: "thinking", line: "Here's what your bots can do." },
  { state: "working", line: "Checking which engines are installed…" },
  { state: "notifying", line: "Your team can reach you anywhere." },
  { state: "curious", line: "Let's shape your first teammate." },
  { state: "listening", line: "Let's check your voice setup." },
  { state: "celebrate", line: "All set — they're ready to work!" },
];

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

/* ── Tour: what your bots can do ──
 * Animated product panels in the onboarding (pattern from OpenMausBot's
 * tour step): auto-advance with a manual Next, built from real DOM mocks
 * like LandingPage so every claim mirrors a shipped feature. Reduced
 * motion keeps the panels static — dots and Next still work. */
const TOUR: { title: string; caption: string; body: ReactNode }[] = [
  {
    title: "Every chat is a real agent",
    caption: "Give a task in plain words — your bot plans, runs commands, and reports back.",
    body: (
      <div className="flex flex-col gap-2 text-[13px]">
        <div className="self-end rounded-2xl rounded-br-sm bg-accent px-3 py-1.5 text-white">
          Run the test suite and tell me what&rsquo;s broken.
        </div>
        <div className="self-start max-w-[85%] rounded-2xl rounded-bl-sm bg-raised px-3 py-1.5 text-ink">
          <div className="text-[11.5px] text-ink-secondary">Running pnpm test…</div>
          42 passed · 0 failed — all green.
        </div>
      </div>
    ),
  },
  {
    title: "They have hands",
    caption: "The Computer panel shows every click and screenshot — and bots ask before anything risky.",
    body: (
      <div className="rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] text-ink">
        <div className="font-sans text-[11px] uppercase tracking-wide text-ink-secondary">Computer</div>
        <div className="mt-1.5">&rarr; Clicking &quot;Book the 3 pm slot&quot;</div>
        <div className="mt-1 flex items-center gap-1.5 text-[#38d591]">
          <Check size={12} /> Confirmed — screenshot saved
        </div>
      </div>
    ),
  },
  {
    title: "Connected apps",
    caption: "Sign in once and every bot can use them as tools.",
    body: (
      <div className="flex flex-wrap justify-center gap-2.5">
        {[
          { icon: GitBranch, label: "Repos" },
          { icon: MessageSquare, label: "Chat" },
          { icon: Mail, label: "Mail" },
          { icon: Calendar, label: "Calendar" },
          { icon: Globe, label: "Web" },
        ].map(({ icon: Icon, label }) => (
          <span
            key={label}
            className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink"
          >
            <Icon size={14} className="text-ink-secondary" /> {label}
          </span>
        ))}
      </div>
    ),
  },
  {
    title: "Put bots in a room",
    caption: "Add teammates to a group chat, @mention them, and merge the answers.",
    body: (
      <div className="flex flex-col gap-2 text-[13px]">
        <div className="text-[11.5px] font-medium text-ink-secondary"># launch</div>
        <div className="self-start rounded-2xl rounded-bl-sm bg-raised px-3 py-1.5 text-ink">
          @Scout research the top three competitors by Friday
        </div>
        <div className="self-start rounded-2xl rounded-bl-sm bg-raised px-3 py-1.5 text-ink text-ink-secondary">
          Scout is on it — drafting the brief…
        </div>
      </div>
    ),
  },
  {
    title: "Set it and forget it",
    caption: "Routines run on a schedule — weekly reports, webhooks, recurring chores.",
    body: (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5 rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-[13px] text-ink">
          <Calendar size={15} className="shrink-0 text-ink-secondary" /> Every Monday 9:00 — draft the weekly report
        </div>
        <div className="flex items-center gap-2.5 rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-[13px] text-ink">
          <Globe size={15} className="shrink-0 text-ink-secondary" /> POST a webhook whenever a task finishes
        </div>
      </div>
    ),
  },
  {
    title: "Run it from the terminal too",
    caption: "The same roster, scriptable — one command and your workspace is ready.",
    body: (
      <div className="rounded-lg bg-[#0b0b0b] p-3 font-mono text-[12px] leading-relaxed">
        <div className="text-ink-secondary">$ muster</div>
        <div className="mt-1 text-ink">workspace ready — 3 bots online</div>
      </div>
    ),
  },
];

const PHONE_POINTS = [
  { icon: MessagesSquare, title: "Your conversations", detail: "Every chat answers from another device, right where you left off." },
  { icon: BellRing, title: "Quick approvals", detail: "When a bot asks before something risky, approve it from your phone." },
  { icon: Lock, title: "Private by default", detail: "Only devices you approve can connect to your Muster." },
];

/** Live microphone test for the voice-setup beat: getUserMedia once, an
 * AnalyserNode level read in a rAF loop, and honest cleanup on stop/unmount.
 * `onActive` lifts "sound is coming through" to the guide mascot, which swaps
 * to its dictating face while you speak. */
function VoiceTest({ onActive }: { onActive: (active: boolean) => void }) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stop = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setTesting(false);
    setLevel(0);
    onActive(false);
  };

  useEffect(() => () => cleanupRef.current?.(), []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const rms = Math.sqrt(sum / data.length) / 255;
        setLevel(Math.min(1, rms * 4));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        for (const track of stream.getTracks()) track.stop();
        void ctx.close();
        onActive(false);
      };
      setTesting(true);
      onActive(true);
    } catch {
      setError("The browser blocked the microphone — allow it and try again.");
    }
  };

  return (
    <div className="rounded-xl bg-card p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div>
            <div className="text-[14px] font-medium text-ink">Try your microphone</div>
            <div className="mt-0.5 text-[12.5px] text-ink-secondary">
              {testing ? "Say something — the bar follows your voice." : "A five-second check that your voice reaches your bots."}
            </div>
          </div>
        </div>
        <button
          onClick={() => (testing ? stop() : void start())}
          className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
        >
          {testing ? "Stop" : "Test"}
        </button>
      </div>
      {testing && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-inset" aria-hidden="true">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-75"
            style={{ width: `${Math.round(8 + level * 92)}%` }}
          />
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[12.5px] text-ink">{error}</p>}
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const { state, dispatch } = useStore();
  const { user } = useAuth();

  const [step, setStep] = useState(0);
  // tour panel index for the "What your bots can do" step (step 1)
  const [tourStep, setTourStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [instances, setInstances] = useState<InstanceRow[] | null>(null);
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  // teammate state
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botColor, setBotColor] = useState<AgentColor>("orange");
  const [botCharacter, setBotCharacter] = useState<AgentCharacter>("flower");


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
  const shellRef = useRef<HTMLDivElement>(null);
  const stageTitleRef = useRef<HTMLHeadingElement>(null);
  const stageScrollRef = useRef<HTMLDivElement>(null);
  const setupErrorRef = useRef<HTMLDivElement>(null);
  const revealedSetupErrorRef = useRef("");

  useEffect(() => {
    finishSession.activate();
    return () => finishSession.dispose();
  }, [finishSession]);

  // Browser mic permission (web only — desktop uses the OS TCC flow below).
  const [webMic, setWebMic] = useState<"prompt" | "granted" | "denied" | "unsupported">("prompt");
  const isDesktop = Boolean(window.ogb);
  // The voice-setup beat: while the live mic test hears you, the guide
  // mascot swaps to its dictating face.
  const [micTesting, setMicTesting] = useState(false);

  // Existing users skip silently: decide only once the store has connected,
  // so a slow SSE doesn't flash the wizard over a populated roster. A fresh
  // install is never empty — seedIfEmpty() plants one greeting-only bot — so
  // "has a user ever said anything" is the real existing-user signal, not
  // bot count. The gate flag doubles as "has seen onboarding" and lives on
  // the ACCOUNT (server) with this browser's localStorage as the fast path:
  // an account that finished via email sign-in must not see the wizard
  // again on its next Google sign-in, or vice versa.
  const [decided, setDecided] = useState(false);
  // Read the replay intent exactly once (the effect below can re-run before
  // `decided` settles; a second consumeTourReplay() would return false and
  // let the history guard auto-skip a deliberate replay).
  const replayRef = useRef<boolean | null>(null);
  if (replayRef.current === null) replayRef.current = consumeTourReplay();
  useEffect(() => {
    if (decided || !state.connected) return;
    const hasRealHistory = state.bots.some((b) => b.messages.some((m) => m.role === "user"));
    // A deliberate "Replay welcome tour" (set by the Settings card before its
    // reload) overrides the returning-user auto-skip below — consumed once so
    // a later fresh visit keeps the guard that stops nagging returning users.
    const replay = replayRef.current;
    let cancelled = false;
    void serverGateDone().then((serverDone) => {
      if (cancelled) return;
      setDecided(true);
      if (!replay && (serverDone || emailGateDone(user?.id))) {
        onDone();
      } else if (!replay && hasRealHistory) {
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
      setStep(ONBOARDING_STEPS.findIndex((entry) => entry.id === stored.step));
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
    const currentStep = ONBOARDING_STEPS[step];
    if (!draftReady || !user || !currentStep) return;
    saveOnboardingDraft(user.id, {
      version: 2,
      name,
      email,
      step: currentStep.id,
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
      if (e.key !== "Escape" || e.defaultPrevented || state.appSettingsOpen || finishingRef.current || !finishSession.active) return;
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
  }, [user?.id, onDone, finishSession, state.appSettingsOpen]);

  // Only semantic navigation/restoration moves focus. Edits, engine polls,
  // tour panels and Settings opening/closing leave the current control alone.
  useLayoutEffect(() => {
    if (!decided || !draftReady) return;
    stageScrollRef.current?.scrollTo({ top: 0 });
    stageTitleRef.current?.focus({ preventScroll: true });
  }, [decided, draftReady, step, user?.id]);

  // Reveal each new failure once, without moving focus during edits or
  // tour animation. Settings keeps its own focus while it is open.
  useLayoutEffect(() => {
    if (!setupError) {
      revealedSetupErrorRef.current = "";
      return;
    }
    if (state.appSettingsOpen || revealedSetupErrorRef.current === setupError) return;
    const alert = setupErrorRef.current;
    if (!alert) return;
    revealedSetupErrorRef.current = setupError;
    alert.scrollIntoView({ block: "nearest", inline: "nearest" });
    alert.focus({ preventScroll: true });
  }, [setupError, state.appSettingsOpen]);

  // Tour auto-advance — only while the tour step is showing, and never
  // under prefers-reduced-motion (the panel then stays put; Next/dots work).
  useEffect(() => {
    if (step !== 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setTourStep((v) => (v + 1) % TOUR.length), 3600);
    return () => clearInterval(t);
  }, [step]);

  useEffect(() => {
    if (step !== 2) return;
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
    if (step === 5 && capabilities.dictation.available) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const t = setInterval(poll, 2000);
      return () => clearInterval(t);
    }
  }, [step, capabilities.dictation.available]);

  useEffect(() => {
    if (step !== 5 || isDesktop) return;
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
  const finish = async (sendFirstTask = true) => {
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
        sendFirstTask,
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

  // dense array indexed by step — steps are 0..6 by construction
  const stepContent = [
    (
      <div className="flex flex-col items-center">
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
            finish(false);
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
      // The video's "What your bots can do" beat: show the product working
      // before asking for any setup. Panels are DOM mocks of real features
      // (chat, Computer panel, connectors, group chat, routines, CLI).
      <div className="flex flex-col">
        <h1 className="text-center text-[18px] font-semibold text-ink">What your bots can do</h1>
        <div key={tourStep} className="tour-panel mt-4 flex min-h-[168px] flex-col justify-center rounded-xl border border-hairline/40 bg-card p-4">
          {TOUR[tourStep].body}
          <div className="mt-3 text-[13.5px] font-medium text-ink">{TOUR[tourStep].title}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{TOUR[tourStep].caption}</div>
        </div>
        <div className="mt-3 flex justify-center gap-1.5">
          {TOUR.map((panel, i) => (
            <button
              key={panel.title}
              onClick={() => setTourStep(i)}
              aria-label={`Tour panel ${i + 1}: ${panel.title}`}
              aria-pressed={i === tourStep}
              className={`h-1.5 rounded-full transition-all ${i === tourStep ? "w-5 bg-accent" : "w-1.5 bg-hairline"}`}
            />
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(0)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => (tourStep < TOUR.length - 1 ? setTourStep(tourStep + 1) : setStep(2))}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
          >
            {tourStep < TOUR.length - 1 ? "Next" : "Set up my bots"}
          </button>
        </div>
        <button
          onClick={() => setStep(2)}
          className="mt-2 self-center text-[12px] text-ink-secondary hover:text-ink"
        >
          Skip tour
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
          onClick={() => setStep(3)}
          className="mt-5 w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
        >
          Continue
        </button>
        <button
          onClick={() => setStep(3)}
          className="mt-2 w-full shrink-0 text-[12.5px] text-ink-secondary transition-colors hover:text-ink"
        >
          Set up later
        </button>
      </div>
    ),

    (
      // The video's "Your phone" beat: companion device promise, fully
      // skippable. On the web the primary button opens this very server's
      // /pair page; desktop IS the trusted device, so it just continues.
      <div className="flex flex-col">
        <h1 className="text-[18px] font-semibold text-ink">Your phone</h1>
        <p className="mt-1 text-[13.5px] text-ink-secondary">
          Your roster travels with you — check in and approve work from anywhere.
        </p>
        <div className="mt-4 flex flex-col gap-2.5">
          {PHONE_POINTS.map(({ icon: Icon, title, detail }) => (
            <div key={title} className="flex items-start gap-3 rounded-xl bg-card p-3.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Icon size={13} />
              </span>
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">{title}</div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{detail}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(2)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => {
              if (!isDesktop) window.open(`${window.location.origin}/pair`, "_blank", "noopener");
              setStep(4);
            }}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white"
          >
            {isDesktop ? "Continue" : "Set up another device"}
          </button>
        </div>
        {!isDesktop && (
          <button
            onClick={() => setStep(4)}
            className="mt-2 self-center text-[12px] text-ink-secondary hover:text-ink"
          >
            Not now
          </button>
        )}
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
                onClick={() => setBotCharacter("blob")}
                aria-label="Blob"
                aria-pressed={botCharacter === "blob"}
                className={`flex size-[52px] shrink-0 items-center justify-center rounded-xl border transition ${
                  botCharacter === "blob" ? "border-accent bg-raised" : "border-hairline/30 hover:bg-raised"
                }`}
              >
                <AgentAvatar color={botColor} character="blob" size={38} state="idle" animated={false} seed="picker-blob" />
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
              onClick={() => setStep(3)}
              disabled={creating}
              className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[14px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              Back
            </button>
            <button
              onClick={() => (botName.trim() ? setStep(5) : finish(false))}
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
          {/* Voice control setup: the live mic check (guide mascot reacts),
              and a spoken sample when a voice is already configured. */}
          <VoiceTest onActive={setMicTesting} />
          {state.config?.tts?.ready && (
            <div className="rounded-xl bg-card p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                  <div>
                    <div className="text-[14px] font-medium text-ink">Hear your team speak</div>
                    <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                      Your voice is configured — teammates can read replies aloud.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() =>
                    void speaker.speak("Hi! I'm your Muster teammate. Give me a task, and I'll ask before anything risky.")
                  }
                  className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                >
                  Play sample
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => setStep(4)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => setStep(6)}
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
            onClick={() => setStep(5)}
            className="rounded-lg border border-hairline/40 px-4 py-2.5 text-[15px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={() => finish(true)}
            disabled={creating}
            className="flex-1 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {creating ? "Setting up…" : botName.trim() ? `Muster ${botName.trim()} →` : "Start using Muster"}
          </button>
        </div>
        <button
          onClick={() => finish(false)}
          disabled={creating}
          className="mt-3 text-[12px] text-ink-secondary hover:text-ink disabled:opacity-40"
        >
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
    <div
      ref={shellRef}
      role="region"
      aria-labelledby="onboarding-title"
      className="onboarding-shell"
      onKeyDown={(event) => {
        // Settings is a sibling dialog with its own keyboard boundary and
        // focus restoration. This handler receives events inside setup only.
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || state.appSettingsOpen) return;
        const shell = shellRef.current;
        if (!shell) return;
        const controls = Array.from(shell.querySelectorAll<HTMLElement>(
          'button, a[href], input, textarea, select, summary, [tabindex]',
        )).filter((element) => !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) {
          event.preventDefault();
          stageTitleRef.current?.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === stageTitleRef.current || document.activeElement === setupErrorRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="onboarding-frame">
        <aside className="onboarding-guide" aria-label="Your setup guide">
          <div className="onboarding-guide-intro">
            <div className="onboarding-guide-flower" aria-hidden="false">
              {/* The living guide: the interactive character with a per-beat
                  face and first-person line. Poke it — it stays honest about
                  which setup step you are on while it reacts. */}
              <FlowerCharacter
                color={botColor}
                size={112}
                state={micTesting ? "dictating" : setupError ? "thinking" : creating ? "working" : (GUIDE_BEATS[step]?.state ?? "idle")}
                status={creating ? "working" : "idle"}
                task={micTesting ? "Listening…" : undefined}
                withLabel={true}
                focusable={false}
                label={`Your setup guide — ${GUIDE_BEATS[step]?.line ?? ""} (poke to wave)`}
              />
            </div>
            <div className="onboarding-guide-copy">
              <p className="onboarding-wordmark">Muster</p>
              <h2 id="onboarding-title" className="onboarding-guide-title">Set up Muster</h2>
              <p className="onboarding-guide-note">{GUIDE_BEATS[step]?.line ?? "Meet your teammate. Choose how you work."}</p>
            </div>
          </div>
          <ol className="onboarding-progress" aria-label="Setup progress">
            {ONBOARDING_STEPS.map((entry, index) => (
              <li
                key={entry.id}
                aria-current={index === step ? "step" : undefined}
                data-complete={index < step || undefined}
                className="onboarding-progress-step"
              >
                <span className="onboarding-progress-number" aria-hidden="true">
                  {index < step ? <Check size={13} /> : index + 1}
                </span>
                <span className="onboarding-progress-label">{entry.label}</span>
              </li>
            ))}
          </ol>
        </aside>
        <div className="onboarding-stage">
          <header className="onboarding-stage-head">
            <p className="onboarding-stage-count">Step {step + 1} of {ONBOARDING_STEPS.length}</p>
            <h2
              ref={stageTitleRef}
              tabIndex={-1}
              data-testid="onboarding-stage-title"
              className="onboarding-stage-title"
            >
              {STEP_LABELS[step]}
            </h2>
          </header>
          <div ref={stageScrollRef} data-testid="onboarding-stage-scroll" className="onboarding-stage-scroll">
            {/* A new failure is revealed above the form. It shares the
                scroll area, so long recovery text and retry stay reachable. */}
            {setupError && (
              <div
                ref={setupErrorRef}
                role="alert"
                tabIndex={-1}
                className="onboarding-error mb-4 flex items-start gap-2 rounded-xl border border-[#ff5c5c40] bg-[#ff5c5c14] px-3.5 py-2.5 text-[13px] leading-relaxed text-ink"
              >
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#ff7a7a]" />
                <span className="min-w-0 break-words">{setupError}</span>
              </div>
            )}
            {/* Preserve the hard swap: the old exit-animation handshake could
                leave stale content mounted beneath the next step's label. The
                keyed remount doubles as the beat morph — each step's card
                rises in (CSS, reduced-motion guarded). */}
            <fieldset key={step} disabled={creating} className="wizard-step onboard-beat m-0 min-w-0 border-0 p-0">
              {stepContent[step]}
            </fieldset>
            {step === 2 && (
              <button
                onClick={() => setStep(step - 1)}
                className="mx-auto mt-4 flex items-center gap-1 text-[12px] text-ink-secondary hover:text-ink"
              >
                <ArrowLeft size={12} /> Back to {STEP_LABELS[step - 1]}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
