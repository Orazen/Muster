// Zero-dependency QR encoder for the `muster up` terminal banner.
//
// The CLI's only contract is Node 22+ (it is copy-installed by curl users
// and run by npm i -g), so a QR here cannot pull a package. This implements
// the QR spec subset Muster needs: byte mode, EC levels L and M, versions
// 1-10 (214-byte payload ceiling at M — a claim URL is ~45 chars), full
// mask selection by penalty score. Reed-Solomon over GF(256), standard
// zigzag placement, BCH format/version info.
//
// export qrMatrix(payload) → { size, modules, version, mask }
// export renderTerminal(payload) → half-block string ready for console.log

const EC_LEVEL_BITS = { L: 0b01, M: 0b00 };
// [ecCodewordsPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const BLOCK_TABLE = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
};
// Total codewords per version — asserted against the block table at load so
// a typo in the table fails loudly here instead of producing broken QRs.
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
// Alignment pattern center coordinates per version (v1 has none).
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 52],
];

for (let v = 1; v <= 10; v++) {
  for (const level of ["L", "M"]) {
    const [ec, g1b, g1d, g2b, g2d] = BLOCK_TABLE[level][v - 1];
    if (g1b * g1d + g2b * g2d + ec * (g1b + g2b) !== TOTAL_CODEWORDS[v - 1]) {
      throw new Error(`qr.mjs block table corrupt at v${v}-${level}`);
    }
  }
}

// ── GF(256), primitive polynomial 0x11d ────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** EC codewords for one data block: generator polynomial (highest-degree
 * coefficient first, monic — the order the remainder loop below expects),
 * then the remainder of data(x)·x^ecLen mod gen(x). */
function rsEncode(data, ecLen) {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  // gen[j] is the coefficient of x^(ecLen-j)
  const rem = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor) for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

// ── bit stream ─────────────────────────────────────────────────────────────
function buildDataBits(payload, version, level) {
  const bytes = Buffer.from(payload, "utf8");
  const [_, g1b, g1d, g2b, g2d] = BLOCK_TABLE[level][version - 1];
  const capacityBytes = g1b * g1d + g2b * g2d;
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  // terminator (up to 4 zero bits), pad to a byte boundary, pad codewords
  const capBits = capacityBytes * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let p = 0;
  while (bits.length < capBits) push(pads[p++ % 2], 8);
  return { bits, capacityBytes };
}

// ── matrix scaffolding ─────────────────────────────────────────────────────
function makeMatrix(version) {
  const size = 21 + 4 * (version - 1);
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const setFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const ring =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[r][c] = ring || core ? 1 : 0;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);
  // alignment patterns draw BEFORE timing (reference order): centers on the
  // timing row/col are sliced through by timing, not skipped outright
  const centers = ALIGNMENT[version - 1];
  const alignDrawn = [];
  for (const r0 of centers) {
    for (const c0 of centers) {
      if (m[r0][c0] !== null) continue; // overlaps a finder — not drawn
      alignDrawn.push([r0, c0]);
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r0 + dr][c0 + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  // reserve format info areas (written after masking)
  for (let i = 0; i < 9; i++) {
    m[i][8] = m[i][8] ?? 0;
    m[8][i] = m[8][i] ?? 0;
  }
  for (let i = 0; i < 8; i++) {
    m[size - 1 - i][8] = m[size - 1 - i][8] ?? 0;
    m[8][size - 1 - i] = m[8][size - 1 - i] ?? 0;
  }
  // dark module
  m[size - 8][8] = 1;
  // version info area (v7+)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[size - 11 + j][i] = 0;
        m[i][size - 11 + j] = 0;
      }
    }
  }
  return { size, m, alignDrawn };
}

function placeData(m, bits) {
  const size = m.length;
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [right, right - 1]) {
        if (m[row][c] !== null) continue;
        m[row][c] = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** Cells that are function patterns or reserved info — written after
 * masking, never masked themselves. `alignDrawn` lists the alignment
 * centers whose pattern was actually drawn; undrawn centers (finder
 * overlaps) leave their zone as ordinary data cells. */
function isReserved(version, size, r, c, alignDrawn) {
  const inFinderBox = (r0, c0) => r >= r0 - 1 && r <= r0 + 7 && c >= c0 - 1 && c <= c0 + 7;
  if (inFinderBox(0, 0) || inFinderBox(0, size - 7) || inFinderBox(size - 7, 0)) return true;
  if (r === 6 || c === 6) return true;
  if (r === 8 || c === 8) {
    // format strips: rows/cols 0-8 and size-8..size-1, minus the dark module
    if (r === 8 && (c <= 8 || c >= size - 8)) return true;
    if (c === 8 && (r <= 8 || r >= size - 8)) return true;
  }
  if (r === size - 8 && c === 8) return true;
  // version info blocks: top-right rows 0-5 × cols size-11..size-9,
  // bottom-left rows size-11..size-9 × cols 0-5
  if (version >= 7 && ((r <= 5 && c >= size - 11 && c <= size - 9) ||
                       (c <= 5 && r >= size - 11 && r <= size - 9))) return true;
  for (const [ar, ac] of alignDrawn) {
    if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
  }
  return false;
}

const penalty = (m) => {
  const size = m.length;
  let score = 0;
  // N1: runs of 5+ same color, rows and columns
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = axis === 0 ? m[i][j] : m[j][i];
        const prev = axis === 0 ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += 3 + (run - 5);
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
    }
  }
  // N2: 2x2 same-color blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) score += 3;
    }
  }
  // N3: finder-like 1011101 with four light modules on either side
  const pat = [1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let ok = true;
        for (let k = 0; k < 7 && ok; k++) ok = get(i, j + k) === pat[k];
        if (!ok) continue;
        const before = [j - 4, j - 3, j - 2, j - 1].every((x) => x >= 0 && get(i, x) === 0);
        const after = [j + 7, j + 8, j + 9, j + 10].every((x) => x < size && get(i, x) === 0);
        if (before || after) score += 40;
      }
    }
  };
  scan((i, j) => m[i][j]);
  scan((i, j) => m[j][i]);
  // N4: dark proportion away from 50%, 5% steps
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
};

export function qrMatrix(payload, level = "M", forcedMask) {
  const bytes = Buffer.from(payload, "utf8");
  if (!BLOCK_TABLE[level]) throw new Error(`unsupported EC level ${level}`);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [_, g1b, g1d, g2b, g2d] = BLOCK_TABLE[level][v - 1];
    const cap = g1b * g1d + g2b * g2d - (v <= 9 ? 2 : 3); // mode + count header
    if (bytes.length <= cap) { version = v; break; }
  }
  if (!version) throw new Error(`payload too long for QR (${bytes.length} bytes; max is 214 at level M)`);
  const { bits } = buildDataBits(payload, version, level);
  const dataBytes = [];
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    dataBytes.push(byte);
  }
  const [ecLen, g1b, g1d, g2b, g2d] = BLOCK_TABLE[level][version - 1];
  const blocks = [];
  let offset = 0;
  for (const [dLen, dCount] of [[g1d, g1b], [g2d, g2b]]) {
    for (let b = 0; b < dCount; b++) {
      const block = dataBytes.slice(offset, offset + dLen);
      offset += dLen;
      blocks.push({ data: block, ec: rsEncode(block, ecLen) });
    }
  }
  // interleave: data codewords round-robin, then EC codewords round-robin
  const final = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) final.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) final.push(b.ec[i]);
  }
  const finalBits = [];
  for (const byte of final) for (let j = 7; j >= 0; j--) finalBits.push((byte >> j) & 1);

  let best = null;
  let bestScore = Infinity;
  let bestMask = -1;
  const masks = forcedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const mask of masks) {
    const { size, m, alignDrawn } = makeMatrix(version);
    placeData(m, finalBits);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (m[r][c] === null || isReserved(version, size, r, c, alignDrawn)) continue;
        if (maskBit(mask, r, c)) m[r][c] ^= 1;
      }
    }
    // format info, two copies (bit i = LSB-first, per spec)
    const data = (EC_LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => (fmt >> i) & 1;
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
    // version info (v7+): same LFSR shape as format info — remainder starts
    // as the unshifted data, G18 = 0x1f25 has degree 12, trigger pre-shift bit 11
    if (version >= 7) {
      let vrem = version;
      for (let i = 0; i < 12; i++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
      const vi = (version << 12) | vrem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        m[b][a] = (vi >> i) & 1;
        m[a][b] = (vi >> i) & 1;
      }
    }
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = { size, m };
      bestMask = mask;
    }
  }
  return { size: best.size, modules: best.m, version, mask: bestMask, penalty: bestScore };
}

/** Render as terminal half-blocks (one char per module ≈ square cells) with
 * a 4-module quiet zone, fg/bg colored so it reads on light or dark
 * terminal themes. */
export function renderTerminal(payload) {
  const { size, modules } = qrMatrix(payload);
  const quiet = 4;
  const total = size + quiet * 2;
  const at = (r, c) =>
    r < quiet || c < quiet || r >= size + quiet || c >= size + quiet ? 0 : modules[r - quiet][c - quiet];
  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const top = at(r, c);
      const bottom = r + 1 < total ? at(r + 1, c) : 0;
      if (top && bottom) line += "\x1b[40m \x1b[0m";
      else if (top && !bottom) line += "\x1b[30;47m▀\x1b[0m";
      else if (!top && bottom) line += "\x1b[30;47m▄\x1b[0m";
      else line += "\x1b[47m \x1b[0m";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
