import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The app icon now IS the default musterbot star mascot (src/components/
// StarTeammate.tsx), in the "orange" agent color — not an abstract
// connected-teammates mark. Same star5 profile math the component itself
// uses (verified identical formula), same gradient direction (top-left to
// bottom-right) and the same top/mid/bottom colors StarTeammate.tsx
// computes at runtime (mix(orange, white, .55) / orange / mix(orange,
// black, .42) for #E78531 — src/lib/mascot.ts's AGENT_COLORS.orange), and
// the same two capsule "eyes" cut as holes through the body, open/idle,
// at the component's own EYE_GAP/EYE_HW/EYE_HH proportions.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, "build");
const SIZE = 1024;
const SS = 4;
const STEPS = 128;

const STAR_STOPS = [
  { at: 0, color: [0xf4, 0xc8, 0xa2] },
  { at: 0.5, color: [0xe7, 0x85, 0x31] },
  { at: 1, color: [0x86, 0x4d, 0x1c] },
];
const CENTER = [512, 512];
const STAR_MAX_RADIUS = 400;
const starProfile = (t) => 0.62 + 0.38 * Math.pow(Math.abs(Math.cos(2.5 * t + Math.PI / 4)), 0.6);

function starPolygon(steps = STEPS) {
  const raw = Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    const r = starProfile(a);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const maxR = Math.max(...raw.map((p) => Math.hypot(p.x, p.y)));
  return raw.map((p) => [CENTER[0] + (p.x / maxR) * STAR_MAX_RADIUS, CENTER[1] + (p.y / maxR) * STAR_MAX_RADIUS]);
}

// StarTeammate.tsx's own coordinate system normalizes the star to radius
// 44 and places eyes at (+/-7.5, 0) with half-width 2.6, half-height 4.2 —
// scale those same ratios onto this icon's STAR_MAX_RADIUS.
const EYE_SCALE = STAR_MAX_RADIUS / 44;
const EYE_GAP = 7.5 * EYE_SCALE;
const EYE_HW = 2.6 * EYE_SCALE;
const EYE_HH = 4.2 * EYE_SCALE;

function capsulePolygon(cx, cy, hw, hh, steps = 32) {
  // Vertical capsule: two semicircle caps joined by straight sides.
  const pts = [];
  for (let i = 0; i <= steps / 2; i++) {
    const a = Math.PI + (i / (steps / 2)) * Math.PI;
    pts.push([cx + Math.cos(a) * hw, cy - (hh - hw) + Math.sin(a) * hw]);
  }
  for (let i = 0; i <= steps / 2; i++) {
    const a = (i / (steps / 2)) * Math.PI;
    pts.push([cx + Math.cos(a) * hw, cy + (hh - hw) + Math.sin(a) * hw]);
  }
  return pts;
}

function eyePolygons() {
  return [
    capsulePolygon(CENTER[0] - EYE_GAP, CENTER[1], EYE_HW, EYE_HH),
    capsulePolygon(CENTER[0] + EYE_GAP, CENTER[1], EYE_HW, EYE_HH),
  ];
}

function rasterise(polygons, width) {
  const mask = new Uint8Array(width * width);
  for (const poly of polygons) {
    const ys = poly.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(width - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y++) {
      const sy = y + 0.5;
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        if (y0 === y1 || sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
        xs.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5));
        const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = from; x <= to; x++) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

const sample = (stops, t) => {
  const c = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (c <= stops[i + 1].at) {
      const a = stops[i], b = stops[i + 1];
      const l = (c - a.at) / (b.at - a.at || 1);
      return a.color.map((v, k) => v + (b.color[k] - v) * l);
    }
  }
  return stops[stops.length - 1].color;
};

const big = SIZE * SS;
const toBig = ([x, y]) => [(x / 1024) * big, (y / 1024) * big];
const starMask = rasterise([starPolygon(STEPS).map(toBig)], big);
const eyeMask = rasterise(eyePolygons().map((poly) => poly.map(toBig)), big);
const [scx, scy] = toBig(CENTER);
const sr = (STAR_MAX_RADIUS / 1024) * big;
const gFrom = [scx - sr, scy - sr];
const gTo = [scx + sr, scy + sr];
const gV = [gTo[0] - gFrom[0], gTo[1] - gFrom[1]];
const gLSq = gV[0] ** 2 + gV[1] ** 2;

const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx, py = y * SS + sy, idx = py * big + px;
        let c;
        if (starMask[idx] && !eyeMask[idx]) {
          const t = ((px - gFrom[0]) * gV[0] + (py - gFrom[1]) * gV[1]) / (gLSq || 1);
          c = sample(STAR_STOPS, t);
        } else {
          c = [0x0a, 0x0a, 0x0a];
        }
        acc = acc.map((v, i) => v + c[i]);
      }
    }
    const at = (y * SIZE + x) * 3, n = SS * SS;
    rgb[at] = Math.round(acc[0] / n);
    rgb[at + 1] = Math.round(acc[1] / n);
    rgb[at + 2] = Math.round(acc[2] / n);
  }
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(join(BUILD_DIR, "icon-1024.png"), encodePng(rgb, SIZE));
console.log("wrote build/icon-1024.png");

const ICONSET_DIR = join(BUILD_DIR, "icon.iconset");
mkdirSync(ICONSET_DIR, { recursive: true });
for (const s of [16, 32, 64, 128, 256, 512]) {
  execSync(`sips -z ${s} ${s} ${join(BUILD_DIR, "icon-1024.png")} --out ${join(ICONSET_DIR, `icon_${s}x${s}.png`)} 2>/dev/null`);
  execSync(`sips -z ${s * 2} ${s * 2} ${join(BUILD_DIR, "icon-1024.png")} --out ${join(ICONSET_DIR, `icon_${s}x${s}@2x.png`)} 2>/dev/null`);
}
execSync(`iconutil -c icns "${ICONSET_DIR}" -o "${join(BUILD_DIR, "icon.icns")}"`);
console.log("wrote build/icon.icns");
