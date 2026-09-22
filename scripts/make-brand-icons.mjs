// Generates every web + desktop brand icon from the canonical mascot
// geometry in src/components/MusterMascot.tsx — the single source of truth
// Loop 14 unified (MusterBloom / MusterbotMark / StarTeammate all render it).
// Pure JS, no native deps: the Bézier body path is flattened and scanline
// rasterised with 4×4 supersampling per output pixel, same approach as
// scripts/make-app-icon.mjs.
//
// Emits:
//   public/app-icon.svg + www/app-icon.svg   transparent favicon mark
//   build/icon.svg                           rounded dark tile (freedesktop)
//   build/icon-1024.png                      rounded dark tile
//   build/icon.iconset/*.png                 macOS iconset (iconutil makes icns)
//   build/icon.ico                           Windows ICO with embedded PNGs
//   electron/resources/app-icon.png          512 tile (BrowserWindow icon)
//   public/assets/icons/icon-*.png           full-bleed PWA icons (maskable)
//                                             incl. icon-180.png (apple-touch)
//   ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
//                                            iOS App Store icon (full-bleed
//                                            square; iOS applies its own mask)
//   android-companion/assets/{icon,adaptive-icon,splash}.png
//                                            fills the app.json references
//   mobile/assets/{icon,adaptive-icon}.png   Muster+ catalog assets
//
//   node scripts/make-brand-icons.mjs
//   iconutil -c icns build/icon.iconset -o build/icon.icns   (macOS)
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── canonical geometry, extracted so the path can never drift ──────────
const mascotSource = readFileSync(join(ROOT, "src/components/MusterMascot.tsx"), "utf8");
const grab = (name) => mascotSource.match(new RegExp(`export const ${name} = "([^"]+)"`))?.[1];
const BODY_D = grab("MUSTER_BODY");
const ORANGE = grab("MUSTER_ORANGE");
const EYE_COLOR = grab("MUSTER_EYES");
if (!BODY_D || !ORANGE || !EYE_COLOR) {
  throw new Error("MUSTER_BODY / MUSTER_ORANGE / MUSTER_EYES not found in src/components/MusterMascot.tsx");
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ORANGE_RGB = hex(ORANGE);
const EYE_RGB = hex(EYE_COLOR);
const TILE_RGB = [0x0a, 0x0a, 0x0a];

// ── path flattening: M / C / Z only (the authored path is all cubics) ──
function flattenPath(d, stepsPerCurve = 24) {
  const tokens = d.match(/[A-Za-z][^A-Za-z]*/g) ?? [];
  const outline = [];
  let start = null;
  let cur = null;
  for (const token of tokens) {
    const cmd = token[0];
    const nums = (token.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
    if (cmd === "M") {
      cur = [nums[0], nums[1]];
      start = cur;
      outline.push(cur);
    } else if (cmd === "C") {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const p0 = cur;
        const p1 = [nums[i], nums[i + 1]];
        const p2 = [nums[i + 2], nums[i + 3]];
        const p3 = [nums[i + 4], nums[i + 5]];
        for (let s = 1; s <= stepsPerCurve; s++) {
          const t = s / stepsPerCurve;
          const u = 1 - t;
          outline.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
          ]);
        }
        cur = p3;
      }
    } else if (cmd === "Z") {
      if (start && (cur[0] !== start[0] || cur[1] !== start[1])) outline.push(start);
    } else {
      throw new Error(`unsupported path command "${cmd}" — extend flattenPath`);
    }
  }
  return outline;
}

// Eyes are capsules (rect w=21 h=44 rx=10.5 centered on origin) at the same
// translate + rotate(-4°) the component applies. SVG rotate(θ) is clockwise
// with y-down; the math below reproduces that directly.
function capsule(cx, cy, halfW, halfH, steps = 48) {
  const pts = [];
  const r = halfW;
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI + (i / steps) * Math.PI;
    pts.push([cx + Math.cos(a) * r, cy - (halfH - halfW) + Math.sin(a) * r]);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    pts.push([cx + Math.cos(a) * r, cy + (halfH - halfW) + Math.sin(a) * r]);
  }
  return pts;
}

function place(points, tx, ty, degrees) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return points.map(([x, y]) => [x * c - y * s + tx, x * s + y * c + ty]);
}

const BODY = flattenPath(BODY_D);
// [-15, 38].map((x, index) => translate(x, index === 0 ? -2 : -6) rotate(-4)) — MusterMascot.tsx
const EYES = [
  place(capsule(0, 0, 10.5, 22), -15, -2, -4),
  place(capsule(0, 0, 10.5, 22), 38, -6, -4),
];

// ── scanline rasterisation (even-odd fill of one polygon) ──────────────
function rasterise(poly, width) {
  const mask = new Uint8Array(width * width);
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
  return mask;
}

// ── rendering: mascot (optionally on a tile) → RGBA ────────────────────
// scaleTo: body max radius is 100 units of the 112 half-viewBox; on a 1024
// tile, scale 4.05 keeps the body inside the 80% maskable safe-zone circle.
function render({ size, tile, fullBleed = false, mascotScale = 4.05 }) {
  const SS = 4;
  const big = size * SS;
  const toBig = (v) => (v / 1024) * big;
  const tileRadius = tile ? toBig(tile === "round" ? 224 : 0) : 0;
  const tileActive = Boolean(tile) || fullBleed;

  const unit = big / 1024; // mascot units are ±112 around origin, center 512
  const center = big / 2;
  const map = ([x, y]) => [center + x * mascotScale * unit, center + y * mascotScale * unit];

  const bodyMask = rasterise(BODY.map(map), big);
  const eyeMasks = EYES.map((eye) => rasterise(eye.map(map), big));

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx;
          const py = y * SS + sy;
          let colour;
          if (eyeMasks.some((m) => m[py * big + px])) colour = [...EYE_RGB, 255];
          else if (bodyMask[py * big + px]) colour = [...ORANGE_RGB, 255];
          else if (tileActive) {
            let inside = true;
            if (tile) {
              const cx = px < tileRadius ? tileRadius : px > big - tileRadius ? big - tileRadius : px;
              const cy = py < tileRadius ? tileRadius : py > big - tileRadius ? big - tileRadius : py;
              inside = (px - cx) ** 2 + (py - cy) ** 2 <= tileRadius * tileRadius;
            }
            colour = inside ? [...TILE_RGB, 255] : [0, 0, 0, 0];
          } else colour = [0, 0, 0, 0];
          // premultiplied accumulate, unpremultiplied at the end
          const alpha = colour[3] / 255;
          r += colour[0] * alpha;
          g += colour[1] * alpha;
          b += colour[2] * alpha;
          a += colour[3];
        }
      }
      const n = SS * SS;
      const at = (y * size + x) * 4;
      const av = a / n;
      rgba[at] = av ? Math.round(r / n / (av / 255)) : 0;
      rgba[at + 1] = av ? Math.round(g / n / (av / 255)) : 0;
      rgba[at + 2] = av ? Math.round(b / n / (av / 255)) : 0;
      rgba[at + 3] = Math.round(av);
    }
  }
  return rgba;
}

// ── PNG (RGBA) + ICO encoders ──────────────────────────────────────────
// The ICO carries DIB (BITMAPINFOHEADER + 32bpp BGRA) entries rather than
// PNG ones. electron-builder hands each entry's raw bytes straight to
// RT_ICON, and Windows expects DIB there — PNG entries survive the build but
// leave the packaged exe with a blank icon. rcedit, the tool electron-builder
// replaced with resedit, writes DIB for the same reason.
function encodeDib(rgba, size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    // DIB rows run bottom-up; the renderer hands them top-down.
    const src = y * size * 4;
    const dst = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      pixels[d] = rgba[s + 2]; // blue
      pixels[d + 1] = rgba[s + 1]; // green
      pixels[d + 2] = rgba[s]; // red
      pixels[d + 3] = rgba[s + 3]; // alpha
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size, 8); // biHeight — no AND mask is carried, so not doubled
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression: BI_RGB
  header.writeUInt32LE(pixels.length, 20); // biSizeImage
  return Buffer.concat([header, pixels]);
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

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(sizes) {
  const images = sizes.map((s) => ({ s, data: encodeDib(render({ size: s, tile: "round" }), s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach(({ s, data }, i) => {
    const at = i * 16;
    entries[at] = s === 256 ? 0 : s; // 0 means 256
    entries[at + 1] = s === 256 ? 0 : s;
    entries.writeUInt16LE(1, at + 4); // planes
    entries.writeUInt16LE(32, at + 6); // bpp
    // The ICO directory is little-endian throughout. Writing these two 32-bit
    // fields big-endian produced a file whose every entry pointed far past EOF;
    // resedit (electron-builder's icon rewriter) then threw "Offset is outside
    // the bounds of the DataView" and the Windows NSIS leg failed to build.
    entries.writeUInt32LE(data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map((p) => p.data)]);
}

// ── SVG emitters (exact component geometry, static) ────────────────────
const eyeSvg = [
  ['translate(-15 -2) rotate(-4)', -15, -2],
  ['translate(38 -6) rotate(-4)', 38, -6],
]
  .map(([t]) => `<g transform="${t}"><rect x="-10.5" y="-22" width="21" height="44" rx="10.5" fill="${EYE_COLOR}"/></g>`)
  .join("\n  ");
const markSvg = `<path d="${BODY_D}" fill="${ORANGE}"/>\n  ${eyeSvg}`;

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-112 -112 224 224" role="img" aria-labelledby="muster-icon-title muster-icon-desc">
  <title id="muster-icon-title">Muster</title>
  <desc id="muster-icon-desc">The Muster mascot: a flat orange five-lobed mark with two offwhite capsule eyes.</desc>
  ${markSvg}
</svg>
`;

const tileSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-labelledby="muster-icon-title muster-icon-desc">
  <title id="muster-icon-title">Muster</title>
  <desc id="muster-icon-desc">The Muster mascot on a dark rounded tile.</desc>
  <rect width="1024" height="1024" rx="224" fill="#0a0a0a"/>
  <g transform="translate(512 512) scale(4.05)">
    ${markSvg}
  </g>
</svg>
`;

// ── write everything ───────────────────────────────────────────────────
const publicIcons = join(ROOT, "public/assets/icons");
mkdirSync(publicIcons, { recursive: true });
mkdirSync(join(ROOT, "build/icon.iconset"), { recursive: true });

writeFileSync(join(ROOT, "public/app-icon.svg"), faviconSvg);
writeFileSync(join(ROOT, "www/app-icon.svg"), faviconSvg);
writeFileSync(join(ROOT, "build/icon.svg"), tileSvg);

writeFileSync(join(ROOT, "build/icon-1024.png"), encodePng(render({ size: 1024, tile: "round" }), 1024));
for (const s of [16, 32, 128, 256, 512]) {
  writeFileSync(join(ROOT, `build/icon.iconset/icon_${s}x${s}.png`), encodePng(render({ size: s, tile: "round" }), s));
  writeFileSync(join(ROOT, `build/icon.iconset/icon_${s}x${s}@2x.png`), encodePng(render({ size: s * 2, tile: "round" }), s * 2));
}
writeFileSync(join(ROOT, "build/icon.ico"), encodeIco([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(join(ROOT, "electron/resources/app-icon.png"), encodePng(render({ size: 512, tile: "round" }), 512));

for (const s of [72, 96, 128, 144, 152, 180, 192, 384, 512]) {
  writeFileSync(join(publicIcons, `icon-${s}.png`), encodePng(render({ size: s, fullBleed: true }), s));
}

// ── native catalogs (iOS + Android) ────────────────────────────────────
// iOS App Store icon: full-bleed square — iOS applies its own corner mask,
// so the tile must not be pre-rounded here.
writeFileSync(
  join(ROOT, "ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png"),
  encodePng(render({ size: 1024, fullBleed: true }), 1024),
);

// Android adaptive-icon layers are 108dp with the outer 18dp maskable each
// side, so the mark must fit the central 66% safe-zone circle: the body's
// 100-unit radius × 3.2 = 320px stays inside 0.33 × 1024 ≈ 338px.
const ADAPTIVE_SCALE = 3.2;
const companionAssets = join(ROOT, "android-companion/assets");
mkdirSync(companionAssets, { recursive: true });
writeFileSync(join(companionAssets, "icon.png"), encodePng(render({ size: 1024, fullBleed: true }), 1024));
writeFileSync(join(companionAssets, "adaptive-icon.png"), encodePng(render({ size: 1024, mascotScale: ADAPTIVE_SCALE }), 1024));
writeFileSync(join(companionAssets, "splash.png"), encodePng(render({ size: 1024, mascotScale: ADAPTIVE_SCALE }), 1024));

// Muster+ (mobile/) — same exports its app.json now points at.
const plusAssets = join(ROOT, "mobile/assets");
mkdirSync(plusAssets, { recursive: true });
writeFileSync(join(plusAssets, "icon.png"), encodePng(render({ size: 1024, fullBleed: true }), 1024));
writeFileSync(join(plusAssets, "adaptive-icon.png"), encodePng(render({ size: 1024, mascotScale: ADAPTIVE_SCALE }), 1024));

try {
  execFileSync("iconutil", ["-c", "icns", join(ROOT, "build/icon.iconset"), "-o", join(ROOT, "build/icon.icns")]);
  console.log("icon.icns written via iconutil");
} catch {
  console.log("iconutil unavailable — run: iconutil -c icns build/icon.iconset -o build/icon.icns");
}
console.log("brand icons written from src/components/MusterMascot.tsx");
