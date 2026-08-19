// Generates the iOS app icon, matching the star logo in public/app-icon.svg.
//
//   node scripts/make-app-icon.mjs
//
// Same artwork as the SVG, two differences that iOS requires:
//   - **Full bleed.** iOS masks the corners itself; no rounded clip.
//   - **No alpha.** The App Store rejects an icon with an alpha channel.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "ios", "App", "Assets.xcassets", "AppIcon.appiconset");
const SIZE = 1024;
const SS = 4;
const STEPS = 128;

// ── colours ──────────────────────────────────────────────────────────
const STAR_STOPS = [
  { at: 0, color: [0xff, 0x9a, 0x73] },
  { at: 0.45, color: [0xf0, 0x46, 0x0e] },
  { at: 1, color: [0x8f, 0x2a, 0x08] },
];
const TILE_STOPS = [
  { at: 0, color: [0x0a, 0x0a, 0x0a] },
  { at: 1, color: [0x0a, 0x0a, 0x0a] },
];
const RALLY_ACCENT_STOPS = [
  { at: 0, color: [0xff, 0x7a, 0x45] },
  { at: 0.5, color: [0xf0, 0x46, 0x0e] },
  { at: 1, color: [0xc9, 0x3a, 0x0b] },
];
const MARKER_COLOR = [0xf5, 0xf5, 0xf5];

// ── geometry ──────────────────────────────────────────────────────────
const CENTER = [512, 512];
const STAR_MAX_RADIUS = 330;

const starProfile = (theta) =>
  0.62 + 0.38 * Math.pow(Math.abs(Math.cos(2.5 * theta + Math.PI / 4)), 0.6);

function starPolygon(steps = STEPS) {
  const raw = Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    const r = starProfile(a);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const maxR = Math.max(...raw.map((p) => Math.hypot(p.x, p.y)));
  return raw.map((p) => [
    CENTER[0] + (p.x / maxR) * STAR_MAX_RADIUS,
    CENTER[1] + (p.y / maxR) * STAR_MAX_RADIUS,
  ]);
}

const RALLY_RADIUS = 40;
const INNER_MARKER_RADIUS = 46;
const INNER_MARKERS = [
  [512, 380],
  [644, 512],
  [512, 644],
  [380, 512],
];
const INNER_SPOKES = [
  [[512, 426], [512, 472]],
  [[598, 512], [552, 512]],
  [[512, 598], [512, 552]],
  [[426, 512], [472, 512]],
];
const SPOKE_WIDTH = 8;

// ── shape helpers ─────────────────────────────────────────────────────
function circlePolygon([cx, cy], r, steps = 64) {
  const points = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return points;
}

function strokeSegment([x0, y0], [x1, y1], width) {
  const half = width / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const body = [
    [x0 + nx, y0 + ny],
    [x1 + nx, y1 + ny],
    [x1 - nx, y1 - ny],
    [x0 - nx, y0 - ny],
  ];
  return [body, circlePolygon([x0, y0], half, 24), circlePolygon([x1, y1], half, 24)];
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
        if (y0 === y1) continue;
        if (sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
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
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped <= stops[i + 1].at) {
      const a = stops[i];
      const b = stops[i + 1];
      const local = (clamped - a.at) / (b.at - a.at || 1);
      return a.color.map((c, k) => c + (b.color[k] - c) * local);
    }
  }
  return stops[stops.length - 1].color;
};

// ── draw ───────────────────────────────────────────────────────────────
const big = SIZE * SS;
const toBig = ([x, y]) => [(x / 1024) * big, (y / 1024) * big];

const starMask = rasterise([starPolygon(STEPS).map(toBig)], big);
const rallyMask = rasterise([circlePolygon(CENTER, RALLY_RADIUS).map(toBig)], big);
const markerMask = rasterise(
  INNER_MARKERS.map((m) => circlePolygon(m, INNER_MARKER_RADIUS).map(toBig)),
  big,
);
const spokeMask = rasterise(
  INNER_SPOKES.flatMap(([a, b]) => strokeSegment(a, b, SPOKE_WIDTH).map((poly) => poly.map(toBig))),
  big,
);

const [scx, scy] = toBig(CENTER);
const sr = (STAR_MAX_RADIUS / 1024) * big;
const gradFrom = [scx - sr, scy - sr];
const gradTo = [scx + sr, scy + sr];
const gradVec = [gradTo[0] - gradFrom[0], gradTo[1] - gradFrom[1]];
const gradLenSq = gradVec[0] ** 2 + gradVec[1] ** 2;

const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx;
        const py = y * SS + sy;
        const index = py * big + px;
        let colour;
        if (spokeMask[index]) {
          colour = MARKER_COLOR;
        } else if (markerMask[index]) {
          colour = MARKER_COLOR;
        } else if (rallyMask[index]) {
          const t =
            ((px - gradFrom[0]) * gradVec[0] + (py - gradFrom[1]) * gradVec[1]) / (gradLenSq || 1);
          colour = sample(RALLY_ACCENT_STOPS, t);
        } else if (starMask[index]) {
          const t =
            ((px - gradFrom[0]) * gradVec[0] + (py - gradFrom[1]) * gradVec[1]) / (gradLenSq || 1);
          colour = sample(STAR_STOPS, t);
        } else {
          colour = sample(TILE_STOPS, 0);
        }
        acc = acc.map((c, i) => c + colour[i]);
      }
    }
    const at = (y * SIZE + x) * 3;
    const samples = SS * SS;
    rgb[at] = Math.round(acc[0] / samples);
    rgb[at + 1] = Math.round(acc[1] / samples);
    rgb[at + 2] = Math.round(acc[2] / samples);
  }
}

// ── PNG ────────────────────────────────────────────────────────────────
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
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
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

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "icon-1024.png"), encodePng(rgb, SIZE));
writeFileSync(
  join(OUT_DIR, "Contents.json"),
  JSON.stringify(
    {
      images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${SIZE}\u00d7${SIZE} icon to ios/App/Assets.xcassets/AppIcon.appiconset/`);
