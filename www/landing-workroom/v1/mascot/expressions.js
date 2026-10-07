// An original, analytic oval-face actor. Every expression uses the same pair of
// smooth closed Bézier contours. Poses interpolate geometry, never two pictures.
// Time is supplied by the scene: there are no timers, DOM objects, or listeners.
const TAU = Math.PI * 2;
const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = n => { const t = clamp(n); return t * t * (3 - 2 * t); };
const sin = (t, speed = 1, offset = 0) => Math.sin(t * speed + offset);

export const FACE_STATES = Object.freeze([
  'sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working',
  'excited', 'surprised', 'suspicious', 'angry', 'drowsy', 'happy', 'curious',
  'confused', 'bored', 'proud', 'shy', 'sad', 'laughing', 'scared', 'playful',
  'celebrate', 'orbit', 'radar', 'progress', 'thinking-dots', 'spawning',
  'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving',
  'uploading', 'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down',
]);

const aliases = {
  hello: 'waking', speaking: 'dictating', idea: 'excited', love: 'happy',
  success: 'celebrate', approval: 'curious', concerned: 'sad', sorry: 'sad',
  frustrated: 'angry', sleepy: 'drowsy', sleep: 'sleeping', wink: 'playful',
};
const canonical = state => FACE_STATES.includes(state) ? state : aliases[state] || 'idle';

const BASE = Object.freeze({
  lx: 228, ly: 240, lw: 65, lh: 118, lt: -.055, lb: 0,
  rx: 412, ry: 240, rw: 65, rh: 118, rt: .055, rb: 0,
  mx: 320, my: 331, mw: 55, md: 15, mo: 0, mt: 0, opacity: 1,
});

// Width/height, eye bend/rotation, and one small mouth are enough to give each
// state a readable silhouette without pupils, eyebrows, text, or pixel grids.
const POSES = Object.freeze({
  sleeping: { ly: 265, ry: 265, lw: 71, rw: 71, lh: 10, rh: 10, lb: 12, rb: 12, lt: 0, rt: 0, mw: 24, md: 1, my: 326 },
  waking: { lh: 126, rh: 133, lt: -.03, rt: .08, mw: 52, md: 19 },
  idle: {},
  listening: { lw: 62, rw: 62, lh: 133, rh: 133, ly: 235, ry: 235, mw: 32, md: 7 },
  thinking: { lx: 239, rx: 423, ly: 227, ry: 240, lh: 103, rh: 69, rt: -.12, mw: 34, md: 0, mx: 311, mt: -.1 },
  searching: { lw: 57, rw: 57, lh: 106, rh: 106, lt: 0, rt: 0, mw: 27, md: 6 },
  working: { lh: 63, rh: 63, lw: 70, rw: 70, lt: .075, rt: -.075, mw: 42, md: 0, my: 324 },
  excited: { lh: 137, rh: 137, lw: 73, rw: 73, ly: 229, ry: 229, mw: 80, md: 23, mo: 10, my: 320 },
  surprised: { lh: 146, rh: 146, lw: 86, rw: 86, ly: 222, ry: 222, lt: 0, rt: 0, mw: 27, md: 0, mo: 61, my: 336 },
  suspicious: { lh: 31, rh: 54, lw: 76, rw: 71, ly: 251, ry: 242, lt: .12, rt: -.16, mw: 43, md: -2, mx: 330, mt: -.13 },
  angry: { lh: 59, rh: 59, lw: 79, rw: 79, lt: .31, rt: -.31, ly: 249, ry: 249, mw: 56, md: -15, my: 342 },
  drowsy: { lh: 32, rh: 26, lw: 73, rw: 73, ly: 263, ry: 266, lt: .03, rt: -.03, lb: 3, rb: 3, mw: 27, md: 2, my: 333 },
  happy: { lh: 13, rh: 13, lw: 77, rw: 77, ly: 252, ry: 252, lb: -24, rb: -24, lt: -.035, rt: .035, mw: 82, md: 24, my: 319 },
  curious: { lh: 91, rh: 140, lw: 59, rw: 73, ly: 248, ry: 221, lt: -.06, rt: .09, mw: 38, md: 8, mx: 325, mt: -.12 },
  confused: { lh: 105, rh: 67, lw: 65, rw: 70, ly: 228, ry: 250, lt: -.17, rt: .12, mw: 48, md: -4, mt: .22, mx: 315 },
  bored: { lh: 28, rh: 28, lw: 74, rw: 74, ly: 257, ry: 257, lt: 0, rt: 0, mw: 52, md: 0, my: 335 },
  proud: { lh: 44, rh: 44, lw: 76, rw: 76, ly: 235, ry: 235, lb: -9, rb: -9, lt: -.08, rt: .08, mw: 72, md: 20, my: 315, mt: -.1 },
  shy: { lx: 240, rx: 400, lh: 76, rh: 76, lw: 51, rw: 51, ly: 262, ry: 262, lt: -.07, rt: .07, mw: 30, md: 11, my: 338 },
  sad: { lh: 57, rh: 57, lw: 64, rw: 64, ly: 264, ry: 264, lt: -.2, rt: .2, lb: 7, rb: 7, mw: 48, md: -17, my: 353 },
  laughing: { lh: 11, rh: 11, lw: 78, rw: 78, ly: 245, ry: 245, lb: -24, rb: -24, mw: 90, md: 16, mo: 64, my: 315 },
  scared: { lh: 141, rh: 147, lw: 64, rw: 64, ly: 231, ry: 227, lt: -.11, rt: .11, mw: 24, md: 0, mo: 41, my: 337 },
  playful: { lh: 12, rh: 123, lw: 73, rw: 65, ly: 249, ry: 236, lb: -17, lt: -.1, rt: .1, mw: 71, md: 23, mt: .13, my: 320 },
  celebrate: { lh: 20, rh: 20, lw: 83, rw: 83, ly: 239, ry: 239, lb: -28, rb: -28, mw: 86, md: 25, mo: 17, my: 309 },
  orbit: { lw: 51, rw: 51, lh: 96, rh: 96, lx: 239, rx: 401, mw: 35, md: 10 },
  radar: { lw: 53, rw: 53, lh: 90, rh: 90, lx: 238, rx: 402, ly: 224, ry: 224, mw: 30, md: 4, my: 304 },
  progress: { lh: 91, rh: 91, lw: 61, rw: 61, ly: 224, ry: 224, mw: 39, md: 8, my: 312 },
  'thinking-dots': { lw: 46, rw: 46, lh: 76, rh: 76, lx: 241, rx: 399, ly: 220, ry: 220, mw: 25, md: 5, my: 298 },
  spawning: { lh: 126, rh: 126, lw: 69, rw: 69, mw: 57, md: 19 },
  humming: { lh: 12, rh: 12, lw: 69, rw: 69, ly: 252, ry: 252, lb: -11, rb: -11, mw: 26, md: 0, mo: 18, my: 330 },
  loading: { lh: 57, rh: 57, lw: 68, rw: 68, ly: 238, ry: 238, mw: 31, md: 6, my: 308 },
  dictating: { lh: 113, rh: 121, lw: 61, rw: 61, ly: 236, ry: 232, mw: 42, md: 4, my: 330 },
  writing: { lh: 68, rh: 81, lw: 60, rw: 60, ly: 257, ry: 249, lt: .1, rt: -.04, mw: 32, md: 3, my: 320 },
  sending: { lh: 97, rh: 97, lw: 56, rw: 56, ly: 218, ry: 218, mw: 43, md: 16, my: 303 },
  receiving: { lh: 108, rh: 108, lw: 60, rw: 60, ly: 254, ry: 254, mw: 48, md: 17, mo: 6, my: 333 },
  uploading: { lh: 115, rh: 115, lw: 55, rw: 55, ly: 217, ry: 217, mw: 33, md: 7, my: 303 },
  notifying: { lh: 124, rh: 124, lw: 70, rw: 70, ly: 235, ry: 235, mw: 45, md: 14 },
  alerting: { lh: 133, rh: 133, lw: 71, rw: 71, ly: 221, ry: 221, lt: .065, rt: -.065, mw: 31, md: -2, my: 308 },
  dragging: { lh: 100, rh: 117, lw: 62, rw: 62, lt: -.14, rt: -.06, mw: 27, md: 0, mo: 17, mt: -.1 },
  bouncing: { lh: 108, rh: 108, lw: 69, rw: 69, mw: 69, md: 23 },
  'powering-down': { lh: 118, rh: 118, lw: 65, rw: 65, mw: 45, md: 11 },
});

function blink(time) {
  const phase = ((time % 13.4) + 13.4) % 13.4;
  for (const start of [4.17, 9.34, 9.73]) {
    const t = phase - start;
    if (t >= 0 && t < .245) return t < .075
      ? 1 - smooth(t / .075) * .96
      : .04 + smooth((t - .075) / .17) * .96;
  }
  return 1;
}

function microGaze(time) {
  const points = [[0, 0], [2.2, -.9], [1.1, -.4], [-1.7, .8], [0, 0]];
  const phase = ((time * .42) % 4 + 4) % 4;
  const index = Math.floor(phase);
  const blend = smooth((phase - index) / .09);
  return [mix(points[index][0], points[index + 1][0], blend), mix(points[index][1], points[index + 1][1], blend)];
}

function poseFor(state, { time, stateTime, pointer, intensity, speechLevel, blinkOverride }) {
  const p = { ...BASE, ...POSES[state] };
  const t = time;
  const energy = clamp(intensity);
  const look = microGaze(t);
  const quiet = ['sleeping', 'powering-down', 'humming'].includes(state) ? .12 : 1;
  let gx = (clamp(pointer.x || 0, -1, 1) * 14 + look[0] * energy) * quiet;
  let gy = (-clamp(pointer.y || 0, -1, 1) * 8 + look[1] * energy) * quiet;

  switch (state) {
    case 'sleeping':
      p.my += sin(t, 1.05) * 2 * energy;
      p.mo = (1 + sin(t, 1.05)) * 2 * energy;
      break;
    case 'waking': {
      const open = smooth(stateTime / 1.35);
      p.lh = mix(10, p.lh, open);
      p.rh = mix(10, p.rh, smooth((stateTime - .12) / 1.25));
      p.ly = mix(265, p.ly, open); p.ry = mix(265, p.ry, open);
      p.lb = p.rb = mix(12, 0, open);
      p.md *= open;
      break;
    }
    case 'listening':
      p.lh += sin(t, 2.4) * 3 * energy;
      p.rh -= sin(t, 2.4) * 3 * energy;
      break;
    case 'thinking':
      gx += sin(t, .8) * 4 * energy;
      p.mt += sin(t, .7) * .03 * energy;
      break;
    case 'searching':
      gx = sin(t, 1.65) * 25 * energy;
      gy = sin(t, .83, .4) * 4 * energy;
      break;
    case 'working':
      gx += sin(t, 3.8) * 4 * energy;
      p.lh += sin(t, 2.4) * 4 * energy; p.rh = p.lh;
      break;
    case 'excited':
      p.ly -= Math.abs(sin(t, 5.2)) * 5 * energy; p.ry = p.ly;
      p.mo += Math.abs(sin(t, 4.1)) * 10 * energy;
      break;
    case 'suspicious': gx += 13; p.rh += sin(t, 1.3) * 3 * energy; break;
    case 'angry': p.mw += sin(t, 2.7) * 3 * energy; break;
    case 'drowsy': {
      const yawn = Math.pow(Math.max(0, sin(t, .84)), 5);
      p.mo = yawn * 39 * energy;
      p.lh = Math.max(12, p.lh + sin(t, .9) * 13 * energy);
      p.rh = Math.max(10, p.rh + sin(t, .9) * 11 * energy);
      break;
    }
    case 'curious': p.rt += sin(t, 1.5) * .025 * energy; break;
    case 'confused': p.mt += sin(t, 1.9) * .05 * energy; break;
    case 'bored': gx += sin(t, .5) * 9 * energy; break;
    case 'shy': gx *= .35; gy += 5; break;
    case 'sad': gy += 5; break;
    case 'laughing':
      p.ly -= Math.abs(sin(t, 7.1)) * 6 * energy; p.ry = p.ly;
      p.mo += sin(t, 7.1) * 13 * energy;
      break;
    case 'scared': gx += sin(t, 17) * 1.5 * energy; p.mo += sin(t, 6.4) * 3 * energy; break;
    case 'playful': p.mt += sin(t, 2.7) * .07 * energy; break;
    case 'celebrate':
      p.ly -= Math.abs(sin(t, 5.7)) * 8 * energy; p.ry = p.ly;
      p.md += Math.abs(sin(t, 5.7)) * 3 * energy;
      break;
    case 'orbit': gx += Math.cos(t * 1.4) * 8 * energy; gy += sin(t, 1.4) * 4 * energy; break;
    case 'radar': gx = sin(t, 1.2) * 14 * energy; break;
    case 'thinking-dots': p.lh += sin(t, 1.7) * 4 * energy; p.rh -= sin(t, 1.7) * 4 * energy; break;
    case 'spawning': {
      const enter = smooth(stateTime / 1.2);
      const spring = 1 + sin(Math.max(0, stateTime - .65), 7.5) * Math.exp(-Math.max(0, stateTime - .65) * 2.7) * .11;
      p.lw = mix(7, p.lw, enter) * spring; p.rw = p.lw;
      p.lh = mix(7, p.lh, enter) * spring; p.rh = p.lh;
      p.lx = mix(292, p.lx, enter); p.rx = mix(348, p.rx, enter);
      p.mw *= enter; p.md *= enter; p.opacity = mix(.16, 1, enter);
      break;
    }
    case 'humming': p.mo += (1 + sin(t, 5.2)) * 5 * energy; p.mx += sin(t, 2.6) * 3 * energy; break;
    case 'loading': p.lh += sin(t, 2.4) * 7 * energy; p.rh = p.lh; break;
    case 'dictating': {
      const syllable = .2 + .8 * Math.abs(sin(t, 10.7) * .63 + sin(t, 17.2) * .37);
      p.mo = 10 + clamp(speechLevel) * syllable * 54 * energy;
      p.mw += clamp(speechLevel) * syllable * 12 * energy;
      break;
    }
    case 'writing': gx += sin(t, 3.9) * 10 * energy; gy += 7; break;
    case 'sending': gy -= Math.max(0, sin(t, 2.1)) * 5 * energy; break;
    case 'receiving': gy += Math.max(0, sin(t, 2.1)) * 4 * energy; break;
    case 'uploading': gy -= 5; break;
    case 'notifying': p.lh += Math.max(0, sin(t, 4.5)) * 7 * energy; p.rh = p.lh; break;
    case 'alerting': p.mo = Math.max(0, sin(t, 3.7)) * 15 * energy; break;
    case 'dragging':
      gx *= 1.8; gy *= 1.5;
      p.lt += clamp(pointer.x || 0, -1, 1) * .13;
      p.rt += clamp(pointer.x || 0, -1, 1) * .13;
      break;
    case 'bouncing': {
      const bounce = sin(t, 4.9) * energy;
      p.lh += bounce * 23; p.rh = p.lh;
      p.lw -= bounce * 8; p.rw = p.lw;
      p.ly -= bounce * 7; p.ry = p.ly;
      p.md += bounce * 4;
      break;
    }
    case 'powering-down': {
      const down = smooth(stateTime / 2.1);
      p.lh = p.rh = mix(118, 8, down);
      p.lw = p.rw = mix(65, 69, down);
      p.ly = p.ry = mix(240, 267, down);
      p.lb = p.rb = 8 * down;
      p.md *= 1 - down; p.mw = mix(45, 22, down);
      p.opacity = mix(1, .3, down);
      break;
    }
  }

  const openness = blink(t) * clamp(blinkOverride);
  if (!['sleeping', 'humming', 'powering-down', 'waking', 'spawning'].includes(state)) {
    if (p.lh > 24) p.lh = Math.max(8, p.lh * openness);
    if (p.rh > 24) p.rh = Math.max(8, p.rh * openness);
  }
  p.lx += gx; p.rx += gx; p.ly += gy; p.ry += gy;
  p.mx += gx * .2; p.my += gy * .18;
  return p;
}

/** Resolve the numeric pose, useful for deterministic bounds/morph checks. */
export function resolveFace({
  state = 'idle', previousState = 'idle', time = 0, stateTime = 0,
  pointer = { x: 0, y: 0 }, intensity = 1, speechLevel = .55, transition = 1, blinkOverride = 1,
} = {}) {
  const options = { time, stateTime, pointer, intensity, speechLevel, blinkOverride };
  const current = poseFor(canonical(state), options);
  const blend = clamp(transition);
  if (blend >= 1 || canonical(state) === canonical(previousState)) return current;
  // Previous entry animations have already settled. Only their ongoing gesture
  // and gaze continue while moving to the next expression.
  const previous = poseFor(canonical(previousState), { ...options, stateTime: Math.max(3, stateTime) });
  for (const key of Object.keys(BASE)) current[key] = mix(previous[key], current[key], blend);
  return current;
}

function eye(ctx, x, y, width, height, tilt, bend) {
  const rx = width / 2;
  const ry = height / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.beginPath();
  ctx.moveTo(-rx, 0);
  ctx.bezierCurveTo(-rx, -ry * .6, -rx * .55, -ry + bend, 0, -ry + bend);
  ctx.bezierCurveTo(rx * .55, -ry + bend, rx, -ry * .6, rx, 0);
  ctx.bezierCurveTo(rx, ry * .6, rx * .55, ry + bend, 0, ry + bend);
  ctx.bezierCurveTo(-rx * .55, ry + bend, -rx, ry * .6, -rx, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function mouth(ctx, p) {
  const r = Math.max(.5, p.mw / 2);
  const thickness = 8.5;
  ctx.save();
  ctx.translate(p.mx, p.my);
  ctx.rotate(p.mt);
  ctx.beginPath();
  ctx.moveTo(-r, -thickness / 2);
  ctx.quadraticCurveTo(0, p.md * 2 - thickness / 2 - p.mo, r, -thickness / 2);
  ctx.quadraticCurveTo(r + thickness / 2, 0, r, thickness / 2);
  ctx.quadraticCurveTo(0, p.md * 2 + thickness / 2 + p.mo, -r, thickness / 2);
  ctx.quadraticCurveTo(-r - thickness / 2, 0, -r, -thickness / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function line(ctx, points, width = 5) {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.stroke();
}

function dot(ctx, x, y, radius = 4) {
  ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
}

function ring(ctx, x, y, radius, start = 0, end = TAU, width = 4) {
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.arc(x, y, radius, start, end); ctx.stroke();
}

function sparkle(ctx, x, y, size) {
  // Four softly pointed rays, kept small enough to leave the oval eyes dominant.
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.quadraticCurveTo(x + size * .16, y - size * .16, x + size, y);
  ctx.quadraticCurveTo(x + size * .16, y + size * .16, x, y + size);
  ctx.quadraticCurveTo(x - size * .16, y + size * .16, x - size, y);
  ctx.quadraticCurveTo(x - size * .16, y - size * .16, x, y - size);
  ctx.fill();
}

function arrow(ctx, x, y, direction = -1, scale = 1) {
  line(ctx, [[x, y - direction * 12 * scale], [x, y + direction * 12 * scale]], 4);
  line(ctx, [[x - 8 * scale, y + direction * 4 * scale], [x, y + direction * 12 * scale], [x + 8 * scale, y + direction * 4 * scale]], 4);
}

function accents(ctx, state, time, stateTime, intensity, opacity) {
  if (opacity <= .001) return;
  ctx.save();
  ctx.globalAlpha *= opacity;
  const alpha = ctx.globalAlpha;
  const t = time;
  const energy = clamp(intensity);
  switch (state) {
    case 'sleeping': {
      const drift = (t * .15) % 1;
      ctx.globalAlpha *= Math.sin(drift * Math.PI) * .6;
      const x = 457 + drift * 15, y = 198 - drift * 29;
      line(ctx, [[x, y], [x + 17, y], [x, y + 18], [x + 17, y + 18]], 4);
      break;
    }
    case 'listening':
    case 'notifying': {
      const pulse = .5 + Math.max(0, sin(t, state === 'listening' ? 3 : 4.5)) * .5 * energy;
      ctx.globalAlpha *= pulse * .55;
      for (const side of [-1, 1]) {
        const start = side < 0 ? Math.PI * .79 : -.21 * Math.PI;
        ring(ctx, 320 + side * 174, 240, 20, start, start + .42 * Math.PI, 4);
        if (state === 'notifying') ring(ctx, 320 + side * 174, 240, 34, start, start + .42 * Math.PI, 3);
      }
      break;
    }
    case 'working': {
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = alpha * (.25 + Math.max(0, sin(t, 4, -i)) * .65);
        line(ctx, [[294 + i * 23, 357], [306 + i * 23, 357]], 4);
      }
      break;
    }
    case 'shy':
      ctx.globalAlpha *= .35;
      for (const x of [179, 456]) {
        line(ctx, [[x, 301], [x - 3, 310]], 3);
        line(ctx, [[x + 8, 302], [x + 5, 311]], 3);
      }
      break;
    case 'celebrate':
    case 'excited':
      ctx.globalAlpha *= .55 + Math.max(0, sin(t, 3.4)) * .4 * energy;
      sparkle(ctx, 164, 184, 10 + sin(t, 3) * 2 * energy);
      sparkle(ctx, 479, 287, 9 + sin(t, 3, 1) * 2 * energy);
      break;
    case 'orbit': {
      ctx.globalAlpha *= .18;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(320, 249, 184, 110, -.25, 0, TAU); ctx.stroke();
      ctx.globalAlpha = alpha * .82;
      for (let i = 0; i < 3; i++) {
        const angle = t * 1.4 + i * TAU / 3;
        const x = Math.cos(angle) * 184, y = Math.sin(angle) * 110;
        dot(ctx, 320 + x * Math.cos(-.25) - y * Math.sin(-.25), 249 + x * Math.sin(-.25) + y * Math.cos(-.25), i === 0 ? 5 : 3);
      }
      break;
    }
    case 'radar': {
      ctx.globalAlpha *= .23;
      ring(ctx, 320, 357, 28, 0, TAU, 2);
      ring(ctx, 320, 357, 15, 0, TAU, 2);
      ctx.globalAlpha = alpha * .8;
      const angle = t * 2;
      line(ctx, [[320, 357], [320 + Math.cos(angle) * 27, 357 + Math.sin(angle) * 27]], 3);
      dot(ctx, 330, 343, 3);
      break;
    }
    case 'progress':
    case 'uploading': {
      ctx.globalAlpha *= .18;
      line(ctx, [[270, 366], [370, 366]], 6);
      ctx.globalAlpha = alpha * .9;
      const progress = .12 + ((stateTime * .16) % 1) * .88;
      line(ctx, [[270, 366], [270 + 100 * progress, 366]], 6);
      if (state === 'uploading') arrow(ctx, 320, 341, -1, .7);
      break;
    }
    case 'thinking':
    case 'thinking-dots': {
      const y = state === 'thinking' ? 372 : 351;
      for (let i = 0; i < 3; i++) {
        const pulse = Math.max(0, sin(t, 3.6, -i * .8));
        ctx.globalAlpha = alpha * (.27 + pulse * .68);
        dot(ctx, 298 + i * 22, y - pulse * 4 * energy, state === 'thinking' ? 3 : 5 + pulse * 1.5 * energy);
      }
      break;
    }
    case 'spawning': {
      const progress = clamp(stateTime / 1.2);
      ctx.globalAlpha *= (1 - progress) * .28;
      ring(ctx, 320, 244, 75 + progress * 106, 0, TAU, 3);
      break;
    }
    case 'humming': {
      const rise = (t * .2) % 1;
      ctx.globalAlpha *= Math.sin(rise * Math.PI) * .65;
      const x = 467, y = 230 - rise * 40;
      dot(ctx, x - 4, y + 13, 5);
      line(ctx, [[x, y + 12], [x, y - 9], [x + 12, y - 13]], 3);
      break;
    }
    case 'loading':
      ctx.globalAlpha *= .22;
      ring(ctx, 320, 358, 17, 0, TAU, 4);
      ctx.globalAlpha = alpha * .9;
      ring(ctx, 320, 358, 17, t * 3.3, t * 3.3 + Math.PI * 1.2, 4);
      break;
    case 'writing': {
      ctx.globalAlpha *= .35;
      const progress = (t * .35) % 1;
      line(ctx, [[283, 362], [357, 362]], 3);
      ctx.globalAlpha = alpha * .8;
      line(ctx, [[283 + progress * 69, 350], [287 + progress * 69, 342]], 4);
      break;
    }
    case 'sending':
    case 'receiving': {
      const phase = (t * .65) % 1;
      ctx.globalAlpha *= .3 + Math.sin(phase * Math.PI) * .65;
      arrow(ctx, 320, 367 + (state === 'sending' ? -1 : 1) * (phase - .5) * 12, state === 'sending' ? -1 : 1, .8);
      break;
    }
    case 'alerting':
      ctx.globalAlpha *= .45 + Math.max(0, sin(t, 3.7)) * .5 * energy;
      line(ctx, [[320, 341], [320, 359]], 5);
      dot(ctx, 320, 371, 3);
      break;
  }
  ctx.restore();
}

/** Paint a complete 640 × 512 visor texture with solid antialiased oval eyes. */
export function drawCompanionFace(ctx, {
  state = 'idle', time = 0, stateTime = 0, pointer = { x: 0, y: 0 },
  eyeColor = '#ffffff', intensity = 1, speechLevel = .55,
  transition = 1, previousState = 'idle', blinkOverride = 1,
} = {}) {
  const pose = resolveFace({ state, previousState, time, stateTime, pointer, intensity, speechLevel, transition, blinkOverride });
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 640, 512);
  ctx.fillStyle = eyeColor;
  ctx.strokeStyle = eyeColor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = pose.opacity;
  eye(ctx, pose.lx, pose.ly, pose.lw, pose.lh, pose.lt, pose.lb);
  eye(ctx, pose.rx, pose.ry, pose.rw, pose.rh, pose.rt, pose.rb);
  mouth(ctx, pose);
  // Secondary marks may fade in; the face itself always morphs its geometry.
  accents(ctx, canonical(state), time, stateTime, intensity, clamp(transition));
  ctx.restore();
}
