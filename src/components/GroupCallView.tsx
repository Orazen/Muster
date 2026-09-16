// Conference call mode — one microphone, several room members.
//
// Capture stays half-duplex for the same reason as one-to-one calls: the
// native recognizer has no acoustic echo cancellation. Bot replies are
// explicitly queued so a fast second member never cuts off the first.
import { useCallback, useEffect, useRef, useState } from "react";
import { Captions, CaptionsOff, Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";

import { currentCall, deferCallCleanup, endCall, useOnCall } from "@/lib/call";
import { getDictation } from "@/lib/dictation";
import { routeSpokenGroupMessage } from "@/lib/group-call";
import { track } from "@/lib/analytics";
import { normalizeState } from "@/lib/mascot";
import { speaker } from "@/lib/tts";
import { applySpeechControl, CONTROL_ACKS, matchSpeechControl } from "@/lib/tts/session-controls";
import { useSpeech } from "@/lib/tts/useSpeech";
import { roomToneForColor, voiceRoomVars } from "@/lib/voice-surface";
import { usePushToTalk } from "@/lib/push-to-talk";
import { useStore, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { AgentAvatar } from "./Avatar";
import { CallTargetButton } from "./CallView";
import { SpeechControlChips } from "./SpeechControlChips";
import { VoiceCaption } from "./VoiceCaption";
import { pendingApprovals } from "./PendingApproval";

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
/** Same spoken-handshake rule as one-to-one calls: only a leading, explicit
 * end-call phrase hangs up — a sentence that merely mentions a call does not. */
const END_CALL = /^\s*(please\s+)?(end|stop|finish|close|leave)( the)? call\b|^\s*(hang up|goodbye)\b/i;
const CALL_ENDPOINT_MS = 850;

/** Speech-helper stdout is line-delimited JSON; only primitive strings are transcript text. */
const isText = (v: string | undefined): v is string => Object.is(String(v), v);

type Phase = "listening" | "muted" | "sending" | "working" | "speaking";

export function GroupCallButton({ group, members }: { group: Group; members: Bot[] }) {
  if (group.dm) return null;
  return (
    <CallTargetButton
      targetId={group.id}
      targetName={group.name}
      voices={members.map((member) => member.voice)}
      onStart={() => track("group_call_started", { memberCount: members.length })}
    />
  );
}

export function GroupCallOverlay({ group, members }: { group: Group; members: Bot[] }) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return <GroupCall group={group} members={members} />;
}

function questionIn(messages: Message[]): Message | undefined {
  return messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );
}

function GroupCall({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = group.busyBotId ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  // Partial transcripts render grey until finalized (CallView parity).
  const [heardFinal, setHeardFinal] = useState(false);
  // Mute is mic-only: the room keeps talking, un-mute rejoins anywhere.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [captions, setCaptions] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [speakingMemberId, setSpeakingMemberId] = useState<string | null>(null);
  const pushToTalk = usePushToTalk(group.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = group.messages;
  const approval = pendingApprovals(messages)[0];
  const question = questionIn(messages);
  const membersRef = useRef(members);
  const busyRef = useRef(Boolean(group.busyBotId));
  const defaultResponderRef = useRef(group.defaultResponder);
  membersRef.current = members;
  busyRef.current = Boolean(group.busyBotId);
  defaultResponderRef.current = group.defaultResponder;

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const message of messages) spokenIds.current.add(message.id);
  }

  const askedApproval = useRef<{ requestId: string; member?: Bot } | null>(null);
  const askedQuestion = useRef<{ requestId: string; member?: Bot } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);
  const queueGeneration = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queuedJobs = useRef(new Set<number>());
  const nextJobId = useRef(0);
  const listenWhenDrained = useRef(false);
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowBargeIn = useRef(false);

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void getDictation().speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== group.id) return;
    // Mute is a closed mic, not an ended call: every path that would open
    // the microphone lands in "muted" instead, and un-mute rejoins here.
    if (mutedRef.current) {
      move("muted");
      return;
    }
    move("listening");
    setSpeakingMemberId(null);
    setHeard("");
    setHeardFinal(false);
    setNote(null);
    void getDictation().speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === group.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [group.id, move]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      hush();
      if (phaseRef.current === "listening") move("muted");
    } else if (phaseRef.current === "muted") {
      listen();
    }
  }, [hush, listen, move]);

  const scheduleListen = useCallback(
    (force = false, delay = 140) => {
      if (listenTimer.current) clearTimeout(listenTimer.current);
      listenTimer.current = setTimeout(() => {
        listenTimer.current = null;
        if (!alive.current || currentCall() !== group.id || queuedJobs.current.size) return;
        if (force || allowBargeIn.current || !busyRef.current) listen();
      }, delay);
    },
    [group.id, listen],
  );

  const say = useCallback(
    async (text: string, member?: Bot) => {
      if (!alive.current || currentCall() !== group.id) return false;
      const mine = ++sayGeneration.current;
      move("speaking");
      setSpeakingMemberId(member?.id ?? null);
      hush();
      await speaker.speak(text, { botId: member?.id, voiceId: member?.voice });
      return alive.current && currentCall() === group.id && sayGeneration.current === mine;
    },
    [group.id, hush, move],
  );

  const enqueueSpeech = useCallback(
    (text: string, member?: Bot, answerAfter = false) => {
      const generation = queueGeneration.current;
      const jobId = ++nextJobId.current;
      queuedJobs.current.add(jobId);
      if (answerAfter) listenWhenDrained.current = true;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (generation !== queueGeneration.current) return;
          await say(text, member);
        })
        .finally(() => {
          if (generation !== queueGeneration.current) return;
          queuedJobs.current.delete(jobId);
          if (queuedJobs.current.size) return;
          setSpeakingMemberId(null);
          const force = listenWhenDrained.current;
          listenWhenDrained.current = false;
          scheduleListen(force);
        });
    },
    [say, scheduleListen],
  );

  const interruptSpeech = useCallback(() => {
    const wasBusy = busyRef.current;
    queueGeneration.current += 1;
    queue.current = Promise.resolve();
    queuedJobs.current.clear();
    listenWhenDrained.current = false;
    sayGeneration.current += 1;
    speaker.stop();
    setSpeakingMemberId(null);
    allowBargeIn.current = true;
    if (wasBusy) dispatch({ type: "interruptGroup", groupId: group.id });
    listen();
  }, [dispatch, group.id, listen]);

  useEffect(() => {
    alive.current = true;
    // Per-call voice: every room call starts with a neutral voice.
    speaker.resetSpeechControls();
    return () => {
      alive.current = false;
      queueGeneration.current += 1;
      sayGeneration.current += 1;
      if (listenTimer.current) clearTimeout(listenTimer.current);
      deferCallCleanup(group.id, () => alive.current);
    };
  }, [group.id]);

  useEffect(() => {
    const dictation = getDictation();
    if (dictation.kind === "none") return;
    const offTranscript = dictation.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== group.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote(
          dictation.kind === "web"
            ? "The browser stopped listening. Check the microphone permission for this site."
            : "Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.",
        );
        return;
      }
      if (!isText(line.text)) return;
      setHeard(line.text);
      setHeardFinal(line.partial === false);
      if (line.partial !== false) return;
      const said = line.text.trim();
      if (!said) return listen();
      if (END_CALL.test(said)) {
        endCall(group.id);
        return;
      }
      // Voice session controls (same rule as one-to-one calls): consumed
      // here, never routed to the room.
      const control = matchSpeechControl(said);
      if (control) {
        speaker.setSpeechControls(applySpeechControl(speaker.speechControls, control));
        enqueueSpeech(CONTROL_ACKS[control], undefined, true);
        return;
      }

      const openApproval = askedApproval.current;
      if (openApproval) {
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          askedApproval.current = null;
          allowBargeIn.current = false;
          dispatch({
            type: "decideRequest",
            threadId: group.threadId,
            requestId: openApproval.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a group call.",
          });
          move("working");
          return;
        }
        enqueueSpeech("Sorry — is that a yes or a no?", openApproval.member, true);
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        allowBargeIn.current = false;
        dispatch({
          type: "decideRequest",
          threadId: group.threadId,
          requestId: openQuestion.requestId,
          behavior: "answer",
          message: said,
        });
        move("working");
        return;
      }

      const routed = routeSpokenGroupMessage(said, membersRef.current);
      if (defaultResponderRef.current.kind === "mentions" && !routed.addressed) {
        listen();
        const names = membersRef.current.map((member) => member.name).join(", ");
        setNote("Say a member's name" + (names ? " — " + names : "") + " — or say everyone.");
        return;
      }

      allowBargeIn.current = false;
      move(busyRef.current ? "working" : "sending");
      dispatch({ type: "sendGroup", groupId: group.id, text: routed.text });
      scheduleListen(false, 600);
    });
    const offEnd = dictation.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== group.id) return;
      if (code === 2) {
        setNote("Calls need speech recognition, which isn't available here yet.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : reason?.startsWith("web-")
              ? "The browser's speech service refused to run. Check the microphone permission for this site."
              : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if (group.busyBotId && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void dictation.speechStop();
    };
    // Live busy/card changes are handled below without restarting native capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, enqueueSpeech, group.id, group.threadId, listen, move, scheduleListen]);

  useEffect(() => {
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }

    if (approval && askedApproval.current?.requestId !== approval.requestId) {
      const member = members.find((candidate) => candidate.id === approval.message.from?.botId);
      askedApproval.current = { requestId: approval.requestId, member };
      spokenIds.current.add(approval.message.id);
      const name = member?.name ?? approval.message.from?.name ?? "A room member";
      enqueueSpeech(
        name + " wants to " + approval.tool + ". " + approval.detail + ". Should I allow it?",
        member,
        true,
      );
    }

    if (question?.card?.requestId && askedQuestion.current?.requestId !== question.card.requestId) {
      const member = members.find((candidate) => candidate.id === question.from?.botId);
      askedQuestion.current = { requestId: question.card.requestId, member };
      spokenIds.current.add(question.id);
      const name = member?.name ?? question.from?.name ?? "A room member";
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? " The options are " + question.card.options.join(", ") + "."
        : "";
      enqueueSpeech(
        name + " asks: " + detail + (/[.!?]$/.test(detail) ? "" : ".") + choices,
        member,
        true,
      );
    }

    const fresh = messages.filter((message) => !spokenIds.current.has(message.id));
    if (!fresh.length) return;
    for (const message of fresh) spokenIds.current.add(message.id);

    const replies = fresh.filter(
      (message) => message.role === "bot" && message.kind === "text" && message.text?.trim(),
    );
    for (const reply of replies) {
      const member = members.find((candidate) => candidate.id === reply.from?.botId);
      enqueueSpeech(reply.text!, member);
    }
    if (!replies.length) {
      const chip = [...fresh].reverse().find((message) => message.kind === "activity" && message.tool?.spoken);
      if (chip?.tool?.spoken) {
        const member = members.find((candidate) => candidate.id === chip.from?.botId);
        enqueueSpeech(chip.tool.spoken, member);
      }
    }
  }, [approval, enqueueSpeech, members, messages, question]);

  useEffect(() => {
    const busy = Boolean(group.busyBotId);
    busyRef.current = busy;
    if (busy) {
      if (
        (phaseRef.current === "listening" || phaseRef.current === "sending") &&
        !askedApproval.current &&
        !askedQuestion.current &&
        !allowBargeIn.current
      ) {
        move("working");
        hush();
      }
      return;
    }
    allowBargeIn.current = false;
    if (
      (phaseRef.current === "working" || phaseRef.current === "sending") &&
      !askedApproval.current &&
      !askedQuestion.current
    ) {
      scheduleListen();
    }
  }, [group.busyBotId, hush, move, scheduleListen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        endCall(group.id);
      } else if (event.code === "Space" && speaker.isSpeaking()) {
        event.preventDefault();
        interruptSpeech();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group.id, interruptSpeech]);

  const speakingMember = members.find((member) => member.id === speakingMemberId);
  const workingMember = members.find((member) => member.id === group.busyBotId);
  const focusId = speakingMember?.id ?? workingMember?.id;
  const status =
    phase === "muted"
      ? "Muted"
      : phase === "listening"
        ? pushToTalk
          ? "Push to talk"
          : "Listening"
        : phase === "sending"
          ? "Bringing the room in"
          : phase === "speaking"
            ? (speakingMember?.name ?? "Room member") + " is speaking"
            : workingMember
              ? workingMember.name + " is working"
              : "Working";

  // The room wears the speaking member's color (Vellum paints the session
  // assistant's); a member-less room falls to the deep ambient dark.
  const roomTone = roomToneForColor(speakingMember?.color ?? workingMember?.color ?? members[0]?.color);

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 px-8"
      style={voiceRoomVars(roomTone)}
    >
      <button
        onClick={() => endCall(group.id)}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-[var(--room-fg-muted)] transition-colors hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]"
      >
        <X size={18} />
      </button>

      <div className="max-w-full overflow-x-auto px-4 py-3">
        <div className="flex min-w-max items-end justify-center gap-3">
          {members.map((member) => {
            const focused = member.id === focusId;
            const state =
              speakingMember?.id === member.id
                ? "sending"
                : workingMember?.id === member.id
                  ? "working"
                  : phase === "listening"
                    ? "listening"
                    : normalizeState(member.mascotExpression) ?? "happy";
            return (
              <div
                key={member.id}
                className={cn(
                  "flex w-[124px] flex-col items-center gap-2 rounded-3xl px-2 py-3 transition-all duration-200",
                  focused ? "scale-105" : "opacity-75",
                )}
                style={focused ? { background: "var(--room-bubble)" } : undefined}
              >
                <AgentAvatar
                  character={member.character}
                  color={member.color}
                  state={state}
                  size={94}
                  animated
                  motion={workingMember?.id === member.id ? "working" : "none"}
                  motionKey={workingMember?.id === member.id ? 1 : 0}
                />
                <span
                  className={cn("text-[13px] font-medium", focused ? "text-[var(--room-fg)]" : "text-[var(--room-fg-muted)]")}
                >
                  {member.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-[var(--room-fg)]">{group.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-[var(--room-fg-muted)]">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
          <SpeechControlChips rate={speech.rate} volume={speech.volume} />
        </div>
      </div>

      <div className="min-h-[3.5rem] max-w-[620px] text-center text-[15px] leading-relaxed text-[var(--room-fg)]">
        {captions &&
          (phase === "listening" || phase === "muted" ? (
            heard ? (
              <span className={heardFinal ? "" : "text-[var(--room-fg-muted)]"}>{heard}</span>
            ) : (
              <span className="text-[var(--room-fg-muted)]">
                {phase === "muted"
                  ? "You're muted — the room keeps talking"
                  : pushToTalk
                    ? "Release Control + Option to send…"
                    : "Say a name, say “everyone,” or just talk to the room…"}
              </span>
            )
          ) : phase === "speaking" ? (
            speech.caption ? <VoiceCaption caption={speech.caption} word={speech.captionWord} /> : null
          ) : (
            <span className="text-[var(--room-fg-muted)]">{workingMember ? "You’ll hear each response in turn." : ""}</span>
          ))}
      </div>

      {note && (
        <div className="flex max-w-[520px] flex-col items-center gap-2 text-center text-[12.5px] text-[var(--room-fg)]">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-[var(--room-fg-muted)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--room-wash)]"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && (
        <div className="max-w-[460px] text-center text-[12.5px]" style={{ color: "var(--room-muted-ink)" }}>
          {speech.error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          title={muted ? "Unmute — the call keeps running" : "Mute — the call keeps running"}
          className={cn(
            "flex size-11 items-center justify-center rounded-full transition-colors",
            muted ? "bg-[var(--room-wash)]" : "text-[var(--room-fg)] hover:bg-[var(--room-wash)]",
          )}
          style={muted ? { color: "var(--room-muted-ink)" } : undefined}
        >
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button
          onClick={() => setCaptions((on) => !on)}
          aria-pressed={captions}
          aria-label={captions ? "Hide live captions" : "Show live captions"}
          title={captions ? "Hide live captions" : "Show live captions"}
          className={cn(
            "flex size-11 items-center justify-center rounded-full transition-colors",
            captions
              ? "bg-[var(--room-wash)] text-[var(--room-fg)]"
              : "text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]",
          )}
        >
          {captions ? <Captions size={18} /> : <CaptionsOff size={18} />}
        </button>
        {speaker.isSpeaking() && (
          <button
            onClick={interruptSpeech}
            className="rounded-full px-4 py-2 text-[13.5px] text-[var(--room-fg)] transition-colors hover:bg-[var(--room-wash)]"
            style={{ boxShadow: "inset 0 0 0 1px var(--room-fg-muted)" }}
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(group.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-[var(--room-fg-muted)]">
        {getDictation().kind === "native"
          ? "Hold Control + Option to talk · Say a member’s name to direct the turn · Space interrupts · say “end the call” or press Esc to hang up"
          : "Say a member’s name to direct the turn · a short pause sends it · say “end the call” or press Esc to hang up"}
      </div>
    </div>
  );
}
