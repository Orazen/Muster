// Local, scripted companion behavior. This module never calls an AI or a microphone.
export const GROUPS = {
  lifecycle: ['sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working'],
  reactions: ['excited', 'surprised', 'suspicious', 'angry', 'drowsy', 'happy', 'curious', 'confused', 'bored', 'proud', 'shy', 'sad', 'laughing', 'scared', 'playful', 'celebrate'],
  morphs: ['orbit', 'radar', 'progress', 'thinking-dots'],
  product: ['spawning', 'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving', 'uploading', 'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down'],
};

export const LABELS = Object.fromEntries(Object.values(GROUPS).flat().map(state => [state, state.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase())]));

export const STATES = {
  sleeping: ['Resting. Still here.', 'Closed eyes, a slow breath, and a quiet floating rest.'],
  waking: ['Good to see you.', 'A gentle stretch, a bright glance, and a welcoming wave.'],
  idle: ['Here, with you.', 'An easy breath and a curious glance. Ready whenever you are.'],
  listening: ['I’m listening.', 'An attentive lean and a patient, steady gaze.'],
  thinking: ['Connecting the dots.', 'Eyes look up as the companion considers the next step.'],
  searching: ['Let me take a look.', 'A deliberate scan from side to side, looking for a useful lead.'],
  working: ['One step at a time.', 'Focused eyes and a small, purposeful working rhythm.'],
  excited: ['There it is!', 'Bright eyes, quick little hops, and flippers full of energy.'],
  surprised: ['Oh!', 'Wide oval eyes, a quick lift, and a soft landing.'],
  suspicious: ['Something feels unusual.', 'A narrowed glance and a questioning sideways lean.'],
  angry: ['That needs attention.', 'A firm frown and a brief, tightly controlled shake.'],
  drowsy: ['Slowing things down.', 'Heavy eyelids, a drooping pose, and a long, gentle breath.'],
  happy: ['That’s lovely.', 'Smiling eyes and an easy, happy sway.'],
  curious: ['Tell me a little more.', 'One raised eye and an inquisitive tilt toward you.'],
  confused: ['Let’s clarify that.', 'An uneven gaze and a puzzled tilt from side to side.'],
  bored: ['Ready for something new.', 'A half-lidded glance, a slow drift, and a little slump.'],
  proud: ['Look how far you’ve come.', 'An upright, confident pose to mark your progress.'],
  shy: ['Aw, thank you.', 'A bashful glance and softly tucked-in flippers.'],
  sad: ['We can take this gently.', 'Soft, downturned eyes and a quiet, lowered posture.'],
  laughing: ['You got me.', 'Smiling eyes, a little giggle, and a flutter of movement.'],
  scared: ['A little startled.', 'Wide eyes and a small recoil before settling again.'],
  playful: ['A little happy dance.', 'A complete spin, a wiggle, and a flutter of flippers.'],
  celebrate: ['We did it.', 'A joyful lift and open flippers when a task is complete.'],
  orbit: ['Keeping things in view.', 'The companion draws inward while a satellite traces its orbit.'],
  radar: ['Looking for a signal.', 'A calm, compact pose at the center of a sweeping radar.'],
  progress: ['A little further along.', 'A steady companion inside an animated progress ring.'],
  'thinking-dots': ['A thought in motion.', 'The body gently gathers into three animated thinking dots.'],
  spawning: ['Hello, little world.', 'A small spark grows into the companion with a soft spring.'],
  humming: ['Finding a rhythm.', 'Relaxed eyes and a rhythmic sway, like a quiet little hum.'],
  loading: ['Getting things ready.', 'A compact, patient pose while the loading ring turns.'],
  dictating: ['Let’s work through it.', 'Expressive oval eyes and gestures that follow the reply.'],
  writing: ['Putting it into words.', 'A focused lean and small, deliberate writing gestures.'],
  sending: ['On its way.', 'A forward gesture follows a bright outgoing message.'],
  receiving: ['Something just arrived.', 'An open, welcoming pose catches an incoming message.'],
  uploading: ['Moving it along.', 'A rising pulse accompanies the sample upload animation.'],
  notifying: ['Your attention, gently.', 'A small wave and a patient notification pulse.'],
  alerting: ['Take a look at this.', 'An alert gaze and a clear, measured attention pulse.'],
  dragging: ['Following your lead.', 'A soft sideways lean gives the companion a little weight.'],
  bouncing: ['A little spring in the step.', 'A lively bounce with a soft squash on each landing.'],
  'powering-down': ['Settling down.', 'A slow bow, a final breath, and a gentle fold into rest.'],
};

const step = (state, duration, text) => ({ state, duration, text });
export const SCENARIOS = {
  plan: [
    step('listening', 1.7, '“Help me plan a calmer day.”'),
    step('thinking', 2.2, 'First, make room for what matters.'),
    step('searching', 1.6, 'Looking for a simple order…'),
    step('excited', 1.6, 'One priority. One focus block. One real break.'),
    step('working', 2.3, 'Putting the sample plan together…'),
    step('notifying', 2, 'You decide what belongs on your day.'),
    step('dictating', 5.2, 'Try your most important task first, a short break next, and smaller tasks after lunch. This is a sample plan; nothing was added to your calendar.'),
    step('celebrate', 2.5, 'Sample plan ready. A little more breathing room.'),
  ],
  explain: [
    step('listening', 1.6, '“Explain a tricky idea simply.”'),
    step('curious', 1.8, 'Let’s find the simplest starting point.'),
    step('thinking-dots', 2.0, 'An analogy might help…'),
    step('excited', 1.5, 'Think of a team passing a useful note.'),
    step('dictating', 5.5, 'An AI agent works in a loop: understand the request, choose a step, check the result, then adjust. Muster can show you when that loop needs your decision.'),
    step('happy', 2.4, 'Small steps make a big idea easier to follow.'),
  ],
  celebrate: [
    step('listening', 1.5, '“I finished something important today.”'),
    step('surprised', 1.1, 'Oh, that’s a moment worth noticing.'),
    step('happy', 1.5, 'You made it happen.'),
    step('celebrate', 2.7, 'A little celebration for a real effort.'),
    step('playful', 2.8, 'Cue the happy dance.'),
    step('dictating', 4, 'Well done. Take a breath and enjoy finishing. You get to choose what comes next.'),
    step('proud', 2.3, 'That progress is yours.'),
  ],
  support: [
    step('listening', 2, '“Today feels a bit overwhelming.”'),
    step('sad', 2.6, 'We can slow the pace.'),
    step('thinking', 1.7, 'What would make the next few minutes simpler?'),
    step('dictating', 5, 'Let’s make the next step smaller. Pick one thing you can do in five minutes, and leave the rest for a moment.'),
    step('happy', 2.7, 'A little encouragement. At your pace.'),
    step('idle', 2, 'Ready when you are.'),
  ],
};

export function replyFor(text) {
  const input = String(text ?? '').toLowerCase().trim();
  if (/\b(sad|stress(?:ed|ful)?|overwhelm(?:ed|ing)?|anxious|hard day|support|lonely)\b/.test(input)) return SCENARIOS.support;
  if (/\b(finished|done|won|win|celebrate|passed)\b/.test(input)) return SCENARIOS.celebrate;
  if (/\b(explain|learn|how|idea)\b/.test(input)) return SCENARIOS.explain;
  if (/\b(plan|schedule|day|task|todo)\b/.test(input)) return SCENARIOS.plan;
  if (/\b(thank|thanks|love|great|awesome|cute)\b/.test(input)) return [step('listening', 1, 'I hear you.'), step('shy', 1.7, 'Aw, thank you.'), step('happy', 2, 'A little appreciation, right back.'), step('dictating', 3.5, 'Glad to help. What would you like to try next?')];
  if (/\b(hi|hello|hey|morning)\b/.test(input)) return [step('waking', 2.5, 'Hello! Good to see you.'), step('happy', 1.6, 'Ready for a little company?'), step('dictating', 3.5, 'Try giving me a sample task, or explore the expressions below.')];
  if (/\b(joke|funny|laugh|dance|play)\b/.test(input)) return [step('curious', 1.5, 'A lighter moment?'), step('playful', 2.8, 'One small happy dance, coming up.'), step('laughing', 2.3, 'That was for you.'), step('happy', 1.5, 'Your turn.')];
  if (/\b(sleep|tired|night|rest)\b/.test(input)) return [step('drowsy', 2.5, 'Time for a quieter pace.'), step('dictating', 3, 'You can take a break. This little companion can wait.'), step('sleeping', 6, 'Resting. Tap to wake.')];
  return [step('listening', 1.5, 'Let me give that a moment.'), step('curious', 1.8, 'What would be useful next?'), step('dictating', 5, 'This is a scripted motion demo. Try “help me plan”, “explain an idea”, “I finished my task”, or “today feels overwhelming”.')];
}

/** One interruptible timeline. Caller advances with animation time, so pause is exact. */
export class CompanionTimeline {
  constructor(onStep, onEnd) { this.onStep = onStep; this.onEnd = onEnd; this.steps = []; this.index = -1; this.time = 0; }
  get running() { return this.index >= 0; }
  start(steps) { this.cancel(); if (!steps.length) return; this.steps = steps; this.index = 0; this.time = 0; this.onStep(steps[0], 0, steps.length); }
  cancel() { this.steps = []; this.index = -1; this.time = 0; }
  tick(delta) {
    if (!this.running || !Number.isFinite(delta) || delta <= 0) return;
    this.time += Math.min(delta, .1);
    if (this.time < this.steps[this.index].duration) return;
    this.time -= this.steps[this.index].duration;
    this.index++;
    if (this.index >= this.steps.length) { this.cancel(); this.onEnd(); return; }
    this.onStep(this.steps[this.index], this.index, this.steps.length);
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const ease = value => { const p = clamp(value, 0, 1); return p * p * (3 - 2 * p); };

/**
 * Local deterministic body choreography for all 40 states.
 * `scale` is uniform scale; multiply its Y component by `scaleY`.
 * `x` is lateral displacement. `opacity` stays 1; the shell needs no material changes.
 * `spin` is a one-shot complete turn, held at 2π until the playful state ends.
 * Semantic morphs finish at every nonzero intensity; energy changes body motion amplitude.
 * Morph graphics belong to the scene; the body makes room for them here.
 */
export function sampleMotion({ weights = {}, time = 0, intensity = .65, active = 'idle', stateTime = 0, speechLevel = 0 } = {}) {
  const raw = Object.fromEntries(Object.keys(STATES).map(key => [key, clamp(finite(weights[key]), 0, 1)]));
  const weightTotal = Math.max(1, Object.values(raw).reduce((sum, value) => sum + value, 0));
  const g = key => raw[key] / weightTotal;
  const t = Math.max(0, finite(time));
  const age = Math.max(0, finite(stateTime));
  const energy = clamp(finite(intensity, .65), 0, 1);
  const speech = clamp(finite(speechLevel), 0, 1);
  const slow = Math.sin(t * 1.35);
  const sleeping = g('sleeping') + g('drowsy') * .6;
  const joy = g('happy');
  const laugh = g('laughing');
  const playful = g('playful');
  const celebrate = g('celebrate');
  const excited = g('excited');
  const bouncing = g('bouncing');
  const scared = g('scared');
  const working = g('working');
  const writing = g('writing');
  const dictating = g('dictating');
  const angry = g('angry');
  const startled = (active === 'surprised' ? Math.sin(clamp(age / .85, 0, 1) * Math.PI) : 0) * g('surprised');
  const hop = energy * (
    Math.pow(Math.max(0, Math.sin(t * 4.4)), 1.8) * .22 * celebrate
    + Math.abs(Math.sin(t * 6)) * .12 * excited
    + Math.pow(Math.abs(Math.sin(t * 3.1)), .85) * .3 * bouncing
  );
  const wakeProgress = active === 'waking' ? ease(age / 1.2) : 1;
  const downProgress = active === 'powering-down' ? ease(age / 1.6) : 1;
  const dotProgress = active === 'thinking-dots' ? ease(age / .6) : 1;
  const spawnProgress = active === 'spawning' ? clamp(age / .9, 0, 1) : 1;
  // A bounded back-ease produces a small settling overshoot without a negative scale.
  const spawnBack = 1 + 2.1 * Math.pow(spawnProgress - 1, 3) + 1.1 * Math.pow(spawnProgress - 1, 2);
  const spawnScale = .05 + .95 * spawnBack;
  const compact = g('orbit') + g('radar') + g('progress') + g('loading');
  const transfers = ['sending', 'receiving', 'uploading'].map(state => ({ state, weight: g(state), point: transferPosition(state, t, energy) }));
  const transferWeight = transfers.reduce((sum, item) => sum + item.weight, 0);
  const transferScale = transfers.reduce((sum, { state, weight, point }) => sum + weight * ((state === 'uploading' ? .78 : .22) * point.visibility - 1), 0);
  const targetScale = 1 - .22 * compact - .99 * g('thinking-dots') * dotProgress
    - .98 * g('powering-down') * downProgress + g('spawning') * (spawnScale - 1) + transferScale;
  const spinDuration = 2 - energy * 1.1;
  const spin = active === 'playful' && energy > 0 ? Math.PI * 2 * ease(age / spinDuration) : 0;

  return {
    x: energy * g('dragging') * Math.sin(t * 1.5) * .12 + transfers.reduce((sum, { weight, point }) => sum + weight * point.x, 0),
    y: (.17 + energy * (slow * .055 * (1 - sleeping * .5) + laugh * Math.abs(Math.sin(t * 7)) * .07
      + startled * .15 + excited * .025 + joy * .025 * Math.sin(t * 2.2)
      - g('sad') * .045 - g('bored') * .025 - g('drowsy') * .03
      + g('uploading') * Math.sin(t * 2.3) * .06 + g('receiving') * Math.abs(Math.sin(t * 2.8)) * .03
      + g('notifying') * Math.abs(Math.sin(t * 3)) * .025 - g('powering-down') * downProgress * .11) + hop) * (1 - transferWeight) + transfers.reduce((sum, { weight, point }) => sum + weight * point.y, 0),
    scale: energy > 0 ? clamp(targetScale, .01, 1.1) : 1,
    scaleY: clamp(1 + energy * (slow * .007 - celebrate * Math.max(0, -Math.sin(t * 4.4)) * .035
      - bouncing * Math.max(0, Math.cos(t * 6.2)) * .085 + bouncing * Math.abs(Math.sin(t * 3.1)) * .025
      + g('proud') * .027 - g('shy') * .025 + laugh * Math.sin(t * 7) * .015
      - scared * .035 - g('waking') * (1 - wakeProgress) * .045
      + g('humming') * Math.sin(t * 4) * .013 - g('powering-down') * downProgress * .05), .9, 1.05),
    lean: energy * (g('listening') * .055 + g('sad') * .08 + sleeping * .095 - g('proud') * .05
      + dictating * speech * .02 + writing * .065 + working * .035 - scared * .055
      + g('bored') * .04 + g('powering-down') * downProgress * .14 - g('waking') * Math.sin(wakeProgress * Math.PI) * .035),
    tilt: energy * (slow * .012 + g('curious') * .13 + g('confused') * Math.sin(t * 1.5) * .12
      + g('thinking') * .07 + g('waking') * Math.sin(t * 2.5) * .03 + joy * Math.sin(t * 1.8) * .035
      - g('shy') * .10 + laugh * Math.sin(t * 5) * .045 + playful * Math.sin(t * 5) * .055
      - g('suspicious') * .07 + g('drowsy') * Math.sin(t * .65) * .045 + g('bored') * Math.sin(t * .45) * .07
      + g('humming') * Math.sin(t * 2.1) * .06 + writing * Math.sin(t * 5) * .018
      + g('dragging') * Math.sin(t * 1.5) * .12 + g('alerting') * Math.sin(t * 6) * .018),
    yaw: energy * (g('searching') * Math.sin(t * 1.6) * .23 + angry * Math.sin(t * 9) * .035
      + g('thinking') * Math.sin(t * .6) * .08 - g('suspicious') * .12 + g('scared') * Math.sin(t * 14) * .015
      + working * Math.sin(t * 2.7) * .045 + g('radar') * Math.sin(t * 1.1) * .13
      + g('orbit') * Math.sin(t * .8) * .065 + g('bored') * Math.sin(t * .4) * .09),
    left: energy * (-.03 - slow * .018 - celebrate * (.25 + Math.sin(t * 3) * .07)
      - excited * (.2 + Math.sin(t * 6) * .055) - joy * .08 + g('shy') * .09
      - dictating * speech * .12 - playful * (.15 + Math.sin(t * 4) * .09)
      + scared * .065 + angry * .05 - g('proud') * .08 + g('sad') * .035
      - g('receiving') * .17 - g('sending') * .07 - g('alerting') * .11
      - g('dragging') * Math.sin(t * 1.5) * .09 - bouncing * Math.abs(Math.sin(t * 3.1)) * .12
      - g('waking') * Math.sin(wakeProgress * Math.PI) * .16),
    right: energy * (.03 + slow * .018 + g('waking') * wakeProgress * (.34 + Math.sin(t * 5) * .10)
      + celebrate * (.25 + Math.sin(t * 3) * .07) + excited * (.2 + Math.sin(t * 6 + .5) * .055)
      + g('thinking') * .15 + dictating * (.05 + speech * .13) - g('shy') * .09
      + playful * (.15 - Math.sin(t * 4) * .09) - scared * .065 - angry * .05
      + g('proud') * .08 - g('sad') * .035 + g('receiving') * .17
      + g('notifying') * (.18 + Math.sin(t * 4) * .055) + g('sending') * .23
      + writing * (.09 + Math.sin(t * 6) * .035) + working * (.065 + Math.sin(t * 3) * .025)
      + g('alerting') * .11 + g('dragging') * Math.sin(t * 1.5) * .09
      + bouncing * Math.abs(Math.sin(t * 3.1)) * .12),
    leftX: energy * (-g('notifying') * .25 - g('sad') * .14 - g('receiving') * .19 - scared * .12),
    rightX: energy * (-g('thinking') * .32 - dictating * .1 - writing * .24 - g('sending') * .27
      - working * .16 - g('notifying') * .15 - scared * .12),
    spin,
    hop,
    glow: clamp(Math.max(g('listening'), dictating * .65, working * .35, g('humming') * .5, g('loading') * .6,
      g('notifying') * .7, g('alerting'), g('uploading') * .7, g('progress') * .65, g('radar') * .75), 0, 1),
    sparkles: clamp(Math.max(celebrate, excited * .65, playful * .6, g('spawning') * .4, g('proud') * .25), 0, 1),
    opacity: 1,
  };
}

/** Transfer x/y match sampleMotion's body position (including y=.17 rest offset). Scene owns particles/trails. */
export function transferPosition(state, time = 0, intensity = .65) {
  if (!['sending', 'receiving', 'uploading'].includes(state)) return { x: 0, y: .17, z: 0, phase: 0, visibility: 0 };
  const energy = clamp(finite(intensity, .65), 0, 1);
  if (energy === 0) return { x: 0, y: .17, z: 0, phase: .5, visibility: 1 };
  const phase = (Math.max(0, finite(time)) % 2.25) / 2.25;
  const travel = ease(phase);
  const arc = Math.sin(phase * Math.PI) * .15;
  const visibility = Math.min(1, phase / .1, (1 - phase) / .12);
  if (state === 'sending') return { x: energy * travel * 1.35, y: .17 + energy * arc, z: 0, phase, visibility };
  if (state === 'receiving') return { x: energy * (travel - 1) * 1.35, y: .17 + energy * arc, z: 0, phase, visibility };
  return { x: 0, y: .17 + energy * travel * 1.08, z: 0, phase, visibility };
}
