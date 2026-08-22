import { Link } from "react-router-dom";
import { Cpu, Monitor, Shield, Plug, Users, Key } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { useAuth } from "@/lib/auth";

export function StarLogo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 -20 260 260" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="star-logo-grad" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff7a45" />
          <stop offset="55%" stopColor="#f0460e" />
          <stop offset="100%" stopColor="#c93a0b" />
        </linearGradient>
        <clipPath id="star-logo-clip" transform="translate(-56.5564 -37.6751) scale(0.593899)">
          <path d="M0 0 C1.12815992 0.94880479 2.25705591 1.89673511 3.38671875 2.84375 C5.57657936 4.68528228 7.75793952 6.53624249 9.93359375 8.39453125 C13.5602214 11.48647103 17.25022962 14.49819427 20.9453125 17.5078125 C25.41301487 21.15281776 29.86103386 24.8215994 34.31054688 28.48876953 C38.00933931 31.5370903 41.70951059 34.58367973 45.4140625 37.625 C52.50037463 43.44570076 59.55669812 49.29508834 66.54003906 55.23901367 C70.43289872 58.54377434 74.40406577 61.73568847 78.40625 64.90625 C82.05401433 67.85083084 85.6145398 70.89451533 89.18359375 73.93359375 C92.41424312 76.67774533 95.67698054 79.36747809 99 82 C103.47931906 85.54855146 107.83340036 89.22936876 112.18359375 92.93359375 C115.41424312 95.67774533 118.67698054 98.36747809 122 101 C125.9014198 104.09073517 129.71091352 107.27378506 133.5 110.5 C137.99002543 114.32092614 142.53350963 118.0537239 147.15234375 121.71875 C156.74255328 129.40144186 166.1812645 137.27326897 175.53833008 145.23754883 C179.4317456 148.54281661 183.40347641 151.73522157 187.40625 154.90625 C191.05401433 157.85083084 194.6145398 160.89451533 198.18359375 163.93359375 C201.41424312 166.67774533 204.67698054 169.36747809 208 172 C236.43637507 194.63776677 236.43637507 194.63776677 238.27050781 209.13867188 C239.19944445 221.27193361 237.57124038 231.13444436 230 241 C223.66050278 247.82715086 215.75482398 254.47140646 206.04764748 255.13307858 C205.3615811 255.13693349 204.67551472 255.1407884 203.96865845 255.14476013 C203.17563324 255.15165863 202.38260803 255.15855713 201.56555176 255.16566467 C200.27360901 255.16958473 200.27360901 255.16958473 198.95556641 255.17358398 C198.04112762 255.180271 197.12668884 255.18695801 196.18453979 255.19384766 C194.19843498 255.20789156 192.21231409 255.21978771 190.22618484 255.22979546 C187.07149762 255.24625057 183.91692738 255.26949556 180.76229858 255.29469299 C171.79227585 255.36530712 162.82220292 255.42526708 153.85205078 255.47680664 C148.36195434 255.5088283 142.87198905 255.55017011 137.38199997 255.59700203 C135.30028042 255.61289593 133.21853066 255.62527474 131.13676834 255.63390923 C104.46972494 255.74602279 80.75351522 259.19455182 60.52978516 278.41845703 C55.75259196 283.35727885 51.81217213 289.04473423 47.77441406 294.5859375 C44.62107661 298.87600364 41.36381878 303.08685058 38.125 307.3125 C32.82026548 314.26649347 27.55386673 321.24815866 22.3125 328.25 C21.07690581 329.89589556 19.84122979 331.5417297 18.60546875 333.1875 C16.22002164 336.36552908 13.84996009 339.55428087 11.48828125 342.75 C3.0450311 354.10095576 -5.25712203 365.22607871 -20 368 C-33.42903027 368.85957067 -44.2929604 367.90032788 -55 358.9140625 C-63.51513963 350.76480778 -67.79688328 340.99527428 -68.37686157 329.29350281 C-68.43541887 328.1487851 -68.49397617 327.00406738 -68.55430794 325.82466125 C-68.61453573 324.57243271 -68.67476353 323.32020416 -68.73681641 322.0300293 C-68.80423726 320.68369989 -68.87198477 319.33738681 -68.94003105 317.99108887 C-69.12569162 314.29881586 -69.30666938 310.60632592 -69.48688698 306.91378379 C-69.68142908 302.94481208 -69.88036562 298.97606035 -70.07873535 295.00727844 C-70.55465828 285.46711948 -71.02377004 275.92663022 -71.49235249 266.3861084 C-71.71278092 261.90166682 -71.93398876 257.41726373 -72.1552124 252.93286133 C-72.22122149 251.59460763 -72.22122149 251.59460763 -72.28856409 250.2293185 C-72.37783973 248.41936974 -72.46711776 246.6094211 -72.55639815 244.79947257 C-72.7821203 240.22326204 -73.00777832 235.64704836 -73.23336792 231.0708313 C-73.2783997 230.15734865 -73.32343148 229.24386601 -73.36982787 228.30270207 C-73.64581049 222.70253299 -73.92113412 217.10233189 -74.19602597 211.50210917 C-75.35713101 187.85146938 -76.54638525 164.20245932 -77.76320994 140.55462319 C-78.3174362 129.77404232 -78.86176258 118.9929594 -79.40472984 108.2118063 C-79.83986282 99.58021501 -80.28322749 90.94912395 -80.73695588 82.31848997 C-81.04621068 76.42094211 -81.34513355 70.52292566 -81.63612723 64.62444884 C-81.8031421 61.24551841 -81.97612174 57.86718776 -82.15861511 54.48903847 C-84.29931862 14.73242483 -84.29931862 14.73242483 -72.03125 -1.625 C-50.89854752 -24.96559677 -21.34867451 -18.24899383 0 0 Z" transform="translate(210,80)" />
        </clipPath>
      </defs>
      <g>
        <g transform="translate(0.00 3.76) translate(114.2705 228.541) scale(1.1054 0.8946) translate(-114.2705 -228.541)">
          <g style={{ opacity: 1 }}>
            <g transform="translate(-56.5564 -37.6751) scale(0.593899)">
              <path d="M0 0 C1.12815992 0.94880479 2.25705591 1.89673511 3.38671875 2.84375 C5.57657936 4.68528228 7.75793952 6.53624249 9.93359375 8.39453125 C13.5602214 11.48647103 17.25022962 14.49819427 20.9453125 17.5078125 C25.41301487 21.15281776 29.86103386 24.8215994 34.31054688 28.48876953 C38.00933931 31.5370903 41.70951059 34.58367973 45.4140625 37.625 C52.50037463 43.44570076 59.55669812 49.29508834 66.54003906 55.23901367 C70.43289872 58.54377434 74.40406577 61.73568847 78.40625 64.90625 C82.05401433 67.85083084 85.6145398 70.89451533 89.18359375 73.93359375 C92.41424312 76.67774533 95.67698054 79.36747809 99 82 C103.47931906 85.54855146 107.83340036 89.22936876 112.18359375 92.93359375 C115.41424312 95.67774533 118.67698054 98.36747809 122 101 C125.9014198 104.09073517 129.71091352 107.27378506 133.5 110.5 C137.99002543 114.32092614 142.53350963 118.0537239 147.15234375 121.71875 C156.74255328 129.40144186 166.1812645 137.27326897 175.53833008 145.23754883 C179.4317456 148.54281661 183.40347641 151.73522157 187.40625 154.90625 C191.05401433 157.85083084 194.6145398 160.89451533 198.18359375 163.93359375 C201.41424312 166.67774533 204.67698054 169.36747809 208 172 C236.43637507 194.63776677 236.43637507 194.63776677 238.27050781 209.13867188 C239.19944445 221.27193361 237.57124038 231.13444436 230 241 C223.66050278 247.82715086 215.75482398 254.47140646 206.04764748 255.13307858 C205.3615811 255.13693349 204.67551472 255.1407884 203.96865845 255.14476013 C203.17563324 255.15165863 202.38260803 255.15855713 201.56555176 255.16566467 C200.27360901 255.16958473 200.27360901 255.16958473 198.95556641 255.17358398 C198.04112762 255.180271 197.12668884 255.18695801 196.18453979 255.19384766 C194.19843498 255.20789156 192.21231409 255.21978771 190.22618484 255.22979546 C187.07149762 255.24625057 183.91692738 255.26949556 180.76229858 255.29469299 C171.79227585 255.36530712 162.82220292 255.42526708 153.85205078 255.47680664 C148.36195434 255.5088283 142.87198905 255.55017011 137.38199997 255.59700203 C135.30028042 255.61289593 133.21853066 255.62527474 131.13676834 255.63390923 C104.46972494 255.74602279 80.75351522 259.19455182 60.52978516 278.41845703 C55.75259196 283.35727885 51.81217213 289.04473423 47.77441406 294.5859375 C44.62107661 298.87600364 41.36381878 303.08685058 38.125 307.3125 C32.82026548 314.26649347 27.55386673 321.24815866 22.3125 328.25 C21.07690581 329.89589556 19.84122979 331.5417297 18.60546875 333.1875 C16.22002164 336.36552908 13.84996009 339.55428087 11.48828125 342.75 C3.0450311 354.10095576 -5.25712203 365.22607871 -20 368 C-33.42903027 368.85957067 -44.2929604 367.90032788 -55 358.9140625 C-63.51513963 350.76480778 -67.79688328 340.99527428 -68.37686157 329.29350281 C-68.43541887 328.1487851 -68.49397617 327.00406738 -68.55430794 325.82466125 C-68.61453573 324.57243271 -68.67476353 323.32020416 -68.73681641 322.0300293 C-68.80423726 320.68369989 -68.87198477 319.33738681 -68.94003105 317.99108887 C-69.12569162 314.29881586 -69.30666938 310.60632592 -69.48688698 306.91378379 C-69.68142908 302.94481208 -69.88036562 298.97606035 -70.07873535 295.00727844 C-70.55465828 285.46711948 -71.02377004 275.92663022 -71.49235249 266.3861084 C-71.71278092 261.90166682 -71.93398876 257.41726373 -72.1552124 252.93286133 C-72.22122149 251.59460763 -72.22122149 251.59460763 -72.28856409 250.2293185 C-72.37783973 248.41936974 -72.46711776 246.6094211 -72.55639815 244.79947257 C-72.7821203 240.22326204 -73.00777832 235.64704836 -73.23336792 231.0708313 C-73.2783997 230.15734865 -73.32343148 229.24386601 -73.36982787 228.30270207 C-73.64581049 222.70253299 -73.92113412 217.10233189 -74.19602597 211.50210917 C-75.35713101 187.85146938 -76.54638525 164.20245932 -77.76320994 140.55462319 C-78.3174362 129.77404232 -78.86176258 118.9929594 -79.40472984 108.2118063 C-79.83986282 99.58021501 -80.28322749 90.94912395 -80.73695588 82.31848997 C-81.04621068 76.42094211 -81.34513355 70.52292566 -81.63612723 64.62444884 C-81.8031421 61.24551841 -81.97612174 57.86718776 -82.15861511 54.48903847 C-84.29931862 14.73242483 -84.29931862 14.73242483 -72.03125 -1.625 C-50.89854752 -24.96559677 -21.34867451 -18.24899383 0 0 Z" fill="url(#star-logo-grad)" transform="translate(210,80)" />
            </g>
            <g clipPath="url(#star-logo-clip)">
              <g transform="translate(93 101) scale(0.74) translate(-120 -122.5)">
                <path fill="#ffffff" d="M93.49 73.19L98.04 74.00L102.28 75.84L105.97 78.61L108.90 82.19L110.87 86.36L111.80 90.88L111.57 95.50L110.51 100.00L109.26 104.46L108.02 108.92L106.80 113.38L105.59 117.85L104.39 122.32L103.21 126.80L102.04 131.28L100.89 135.76L99.78 140.26L98.69 144.76L97.54 149.24L95.63 153.44L92.45 156.78L88.40 158.98L83.90 160.04L79.28 160.04L74.76 159.08L70.51 157.27L66.70 154.65L63.54 151.29L61.27 147.27L60.19 142.78L60.59 138.19L61.66 133.68L62.78 129.19L63.91 124.70L65.07 120.22L66.24 115.74L67.42 111.26L68.62 106.79L69.83 102.33L71.06 97.86L72.30 93.40L73.52 88.94L74.98 84.54L77.32 80.57L80.55 77.26L84.48 74.83L88.88 73.46Z" transform="translate(86.16 116.79) scale(1.0000 1.0000) translate(-86.16 -116.79)" style={{ opacity: 1 }} />
                <path fill="#ffffff" d="M162.91 84.66L167.24 85.65L171.02 87.97L173.96 91.31L175.88 95.32L176.77 99.68L176.71 104.13L176.17 108.55L175.51 112.96L174.76 117.36L173.90 121.73L172.95 126.09L171.89 130.42L170.72 134.72L169.44 138.99L168.04 143.23L166.54 147.42L164.92 151.58L163.12 155.66L160.82 159.46L157.86 162.79L154.38 165.57L150.49 167.75L146.31 169.27L141.92 170.02L137.48 169.80L133.30 168.30L130.12 165.25L128.83 161.02L129.47 156.64L131.11 152.49L132.81 148.37L134.38 144.20L135.83 139.98L137.16 135.73L138.38 131.44L139.49 127.12L140.49 122.78L141.39 118.41L142.19 114.02L142.89 109.62L143.50 105.21L144.23 100.81L145.58 96.57L147.80 92.71L150.77 89.40L154.38 86.79L158.49 85.11Z" transform="translate(153.84 128.21) scale(1.0000 1.0000) translate(-153.84 -128.21)" style={{ opacity: 1 }} />
                <path fill="none" stroke="#ffffff" strokeWidth="7.5" strokeLinecap="round" d="M85.97 173.98 Q108.29 191.94 135.27 182.30" transform="translate(110.62 178.14) scale(1.0000 1) translate(-110.62 -178.14)" style={{ opacity: 1 }} />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

const ENGINES = ["Claude", "Codex", "Grok", "Gemini", "Kimi", "Qwen", "Hermes", "Droid", "Antigravity", "OpenCode Go"];

const FEATURES = [
  { icon: Cpu, title: "Pick a brain per bot", desc: "A model picker with a provider rail, side by side — switch a bot's model mid-conversation." },
  { icon: Monitor, title: "Every bot gets a computer", desc: "Give each bot a real cloud Linux desktop it drives live, or point it at your own Mac." },
  { icon: Shield, title: "Bots ask before they act", desc: "Shell, file edits, and questions surface as inline cards — Allow / Deny / answer in chat." },
  { icon: Plug, title: "Connected apps", desc: "Gmail, Slack, GitHub, Notion, Linear and 500+ more via Composio — OAuth once." },
  { icon: Users, title: "Bots work together", desc: "Groups, group calls, delegation, and a team library to import a whole roster." },
  { icon: Key, title: "Keys once, local always", desc: "Credentials persist locally and the fleet hot-reloads. Secrets stay write-only." },
];

const DOWNLOADS = [
  { os: "macOS", meta: "Apple silicon · unsigned build · one-click .dmg", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster.dmg", label: "Download .dmg" },
  { os: "macOS (Intel)", meta: "x64 · unsigned build · one-click .dmg", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster-intel.dmg", label: "Download .dmg" },
  { os: "Windows", meta: "64-bit · one-click installer, no admin rights", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster-setup.exe", label: "Download .exe" },
  { os: "Ubuntu", meta: "24.04 x64 · .deb or AppImage", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster.deb", label: "Download .deb" },
  { os: "Self-host (web)", meta: "Run the web UI + harness in Docker", href: "https://github.com/Orazen/Muster/blob/main/docs/self-host.md", label: "Docker guide" },
];

/* ── Motion primitives ──────────────────────────────────────────────
 * Vellum-style grammar: restrained fade+rise reveals, one spring moment
 * for the mascot crowd. Everything collapses to static under
 * prefers-reduced-motion. */

const riseVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0 },
};

/** Scroll-triggered fade+rise. `delay` staggers siblings. */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={riseVariants}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.55, delay, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Gentle perpetual float for mascots. Disabled under reduced motion. */
function Float({ children, duration = 6, delay = 0 }: { children: React.ReactNode; duration?: number; delay?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;
  return (
    <motion.div animate={{ y: [0, -7, 0] }} transition={{ duration, delay, repeat: Infinity, ease: "easeInOut" }}>
      {children}
    </motion.div>
  );
}

/** Five-point star body with capsule eyes — same silhouette family as the
 * in-app StarTeammate mascot, standalone so the marketing page stays free of
 * app imports. */
function CrowdStar({ color, size }: { color: string; size: number }) {
  const gradId = `crowd-${color.slice(1)}`;
  return (
    <svg width={size} height={size} viewBox="-48 -48 96 96" aria-hidden="true" className="block">
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0" stopColor={color} stopOpacity="0.72" />
          <stop offset="1" stopColor={color} />
        </linearGradient>
      </defs>
      <path d={CROWD_STAR_PATH} fill={`url(#${gradId})`} />
      <rect x="-10.1" y="-6.2" width="5.2" height="8.4" rx="2.6" fill="#111" />
      <rect x="4.9" y="-6.2" width="5.2" height="8.4" rx="2.6" fill="#111" />
    </svg>
  );
}

// Same rounded-star math the app's StarTeammate uses (starRadius curve,
// Catmull-Rom through 128 samples), precomputed to a static path string.
function computeCrowdStarPath(): string {
  const STEPS = 128;
  const TAU = Math.PI * 2;
  const radius = (theta: number) => 0.62 + 0.38 * Math.abs(Math.cos(2.5 * theta + Math.PI / 4)) ** 0.6;
  const raw = Array.from({ length: STEPS }, (_, i) => {
    const a = (i / STEPS) * TAU;
    return { x: Math.cos(a) * radius(a), y: Math.sin(a) * radius(a) };
  });
  const maxR = Math.max(...raw.map((p) => Math.hypot(p.x, p.y)));
  const pts = raw.map((p) => ({ x: (p.x / maxR) * 44, y: (p.y / maxR) * 44 }));
  const tension = 1 / 6;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < STEPS; i++) {
    const p0 = pts[(i - 1 + STEPS) % STEPS];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % STEPS];
    const p3 = pts[(i + 2) % STEPS];
    d += ` C ${(p1.x + (p2.x - p0.x) * tension).toFixed(2)} ${(p1.y + (p2.y - p0.y) * tension).toFixed(2)}, ${(p2.x - (p3.x - p1.x) * tension).toFixed(2)} ${(p2.y - (p3.y - p1.y) * tension).toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return `${d} Z`;
}
const CROWD_STAR_PATH = computeCrowdStarPath();

/** The vellum.ai moment, in our own skin: a scroll-revealed crowd of star
 * teammates in engine colors, springing in with stagger, then idle-floating.
 * Static under reduced motion. */
const CROWD: { color: string; size: number; left: number; top: number; rot: number; dur: number }[] = [
  { color: "#f0460e", size: 88, left: 3, top: 24, rot: -8, dur: 5.4 },
  { color: "#377FE6", size: 62, left: 16, top: 58, rot: 7, dur: 6.2 },
  { color: "#E78531", size: 96, left: 28, top: 12, rot: -5, dur: 5.8 },
  { color: "#D84F8B", size: 56, left: 42, top: 54, rot: 9, dur: 6.6 },
  { color: "#8057C8", size: 76, left: 52, top: 18, rot: -7, dur: 5.2 },
  { color: "#0EA5C6", size: 64, left: 64, top: 56, rot: 6, dur: 6.8 },
  { color: "#D8A729", size: 84, left: 74, top: 14, rot: -6, dur: 5.6 },
  { color: "#D94B52", size: 60, left: 86, top: 52, rot: 8, dur: 6.4 },
  { color: "#01A492", size: 70, left: 92, top: 26, rot: -4, dur: 6.0 },
];

function StarCrowdSection() {
  const reduced = useReducedMotion();
  return (
    <section className="relative overflow-hidden px-6 py-24 max-sm:py-14" aria-label="Your team of agents">
      <div className="mx-auto max-w-6xl text-center">
        <Reveal>
          <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Your team</div>
          <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Muster your team.</h2>
          <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-[#a1a1a6]">
            Every agent gets a face, a name, and a mind of its own. Assemble the roster once — it shows up for work every day after.
          </p>
        </Reveal>
        <div className="relative mx-auto mt-4 h-[190px] max-w-3xl max-sm:h-[140px]">
          {CROWD.map((s, i) => {
            const star = <CrowdStar {...s} />;
            return (
              <div key={s.color} className="absolute" style={{ left: `${s.left}%`, top: `${s.top}%` }}>
                {reduced ? (
                  <div style={{ transform: `rotate(${s.rot}deg)` }}>{star}</div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, scale: 0, rotate: s.rot * 3 }}
                    whileInView={{ opacity: 1, scale: 1, rotate: s.rot }}
                    viewport={{ once: true, margin: "-40px" }}
                    transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.08 * i }}
                  >
                    <Float duration={s.dur} delay={0.35 * i}>
                      {star}
                    </Float>
                  </motion.div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Hero visual: a miniature, static mock of the Muster app — roster sidebar,
 * a chat with an approval card — built in DOM so it can never 404 like the
 * old /hero.png did. */
function HeroMock() {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101012] text-left shadow-[0_30px_80px_rgba(0,0,0,.5)]">
      <div className="flex h-[380px] max-sm:h-[300px]">
        {/* sidebar */}
        <div className="hidden w-44 shrink-0 flex-col gap-1 border-r border-white/[0.06] p-3 sm:flex">
          <div className="mb-2 flex items-center gap-2 px-2 text-[12px] font-semibold text-[#f5f5f5]">
            <StarLogo size={14} /> Muster
          </div>
          {[
            { c: "#E78531", n: "Scout", active: true },
            { c: "#377FE6", n: "Writer" },
            { c: "#ff7a45", n: "Ops" },
            { c: "#8057C8", n: "Reviewer" },
          ].map(({ c, n, active }) => (
            <div key={n} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${active ? "bg-white/[0.06] text-[#f5f5f5]" : "text-[#a1a1a6]"}`}>
              <span className="size-4 shrink-0 rounded-full" style={{ background: `linear-gradient(135deg, ${c}bb, ${c})` }} />
              <span className="truncate">{n}</span>
              {active && <span className="ml-auto size-1.5 rounded-full bg-[#f08a24]" />}
            </div>
          ))}
          <div className="mt-auto rounded-lg border border-white/[0.06] px-2 py-1.5 text-[11px] text-[#a1a1a6]">
            + New Bot
          </div>
        </div>
        {/* chat */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col justify-end gap-3 p-5">
            <div className="self-end rounded-2xl rounded-br-md bg-[#f0460e] px-4 py-2.5 text-[13px] text-white max-w-[75%]">
              Scout — check the deploy logs and tell me what broke.
            </div>
            <div className="flex items-start gap-2.5 self-start">
              <CrowdStar color="#E78531" size={26} />
              <div className="rounded-2xl rounded-bl-md bg-white/[0.05] px-4 py-2.5 text-[13px] leading-relaxed text-[#e5e5e5] max-w-[80%]">
                Found it — the build failed on a missing env var. Two tests also need a re-run; everything else is green.
              </div>
            </div>
            {/* approval card */}
            <div className="self-start rounded-xl border border-[rgba(240,70,14,.35)] bg-[rgba(240,70,14,.06)] p-3.5 max-w-[85%]">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#ff7a45]">Wants to run</div>
              <code className="block text-[12px] text-[#d4d4d8]">vercel logs muster --error</code>
              <div className="mt-2.5 flex gap-2">
                <span className="rounded-lg bg-[#f0460e] px-3 py-1 text-[12px] font-semibold text-white">Allow</span>
                <span className="rounded-lg border border-white/[0.1] px-3 py-1 text-[12px] text-[#a1a1a6]">Deny</span>
              </div>
            </div>
          </div>
          <div className="border-t border-white/[0.06] p-3.5">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5 text-[12.5px] text-[#6b6b70]">
              Message your team…
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { user } = useAuth();
  const reduced = useReducedMotion();

  // Staggered hero entrance: badge → headline → subcopy → CTAs → screenshot.
  const heroItem = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 26 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: [0.22, 0.61, 0.36, 1] as const },
        };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-xl bg-[#0a0a0a]/70">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[#f5f5f5]">
            <Float duration={7}>
              <StarLogo size={28} />
            </Float>
            Muster
          </Link>
          <div className="flex items-center gap-6 max-sm:hidden">
            <a href="#features" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Features</a>
            <a href="#engines" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Engines</a>
            <a href="#download" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Download</a>
            <a href="https://github.com/Orazen/Muster" target="_blank" rel="noopener" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">GitHub</a>
            {user ? (
              <Link to="/app" className="rounded-[10px] bg-[#f0460e] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,.06),0_8px_24px_rgba(240,70,14,.28)] transition-all hover:-translate-y-px hover:shadow-[0_0_0_1px_rgba(255,255,255,.1),0_12px_28px_rgba(240,70,14,.38)]">Open Muster</Link>
            ) : (
              <Link to="/sign-in" className="rounded-[10px] bg-[#f0460e] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_0_0_1px_rgba(255,255,255,.06),0_8px_24px_rgba(240,70,14,.28)] transition-all hover:-translate-y-px hover:shadow-[0_0_0_1px_rgba(255,255,255,.1),0_12px_28px_rgba(240,70,14,.38)]">Sign In</Link>
            )}
          </div>
        </nav>
      </header>

      <main>
        {/* ── Hero ── */}
        <section className="relative px-6 pb-20 pt-24 text-center max-sm:pt-16 max-sm:pb-12">
          <div className="mx-auto max-w-4xl">
            <motion.div {...heroItem(0)}>
              <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[rgba(240,70,14,.28)] bg-[rgba(240,70,14,.07)] px-3.5 py-1.5 text-[13px] font-medium text-[#ff7a45]">
                Google sign-in · local-first · bring your own AI
              </div>
            </motion.div>
            <motion.h1 {...heroItem(0.08)} className="text-[clamp(42px,7vw,76px)] font-bold leading-[1.02] tracking-[-0.035em] text-[#f5f5f5]">
              Muster{" "}
              <span className="bg-gradient-to-br from-[#ff7a45] via-[#f0460e] to-[#c93a0b] bg-clip-text text-transparent">
                your agents.
              </span>
            </motion.h1>
            <motion.p {...heroItem(0.16)} className="mx-auto mt-6 max-w-xl text-[19px] leading-relaxed text-[#a1a1a6]">
              One chat app for a whole roster of AI agents — each with its own memory, model, and a real computer to work on.
            </motion.p>
            <motion.div {...heroItem(0.24)} className="mt-10 flex flex-wrap items-center justify-center gap-3.5">
              <Link to={user ? "/app" : "/sign-up"} className="inline-flex items-center gap-2 rounded-xl bg-[#f0460e] px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_10px_30px_rgba(240,70,14,.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(240,70,14,.42)]">
                {user ? "Open Muster →" : "Get Started →"}
              </Link>
              <a href="https://github.com/Orazen/Muster/releases/latest" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
                Download for macOS
              </a>
              <a href="https://github.com/Orazen/Muster" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
                View on GitHub
              </a>
            </motion.div>
            <motion.div {...heroItem(0.36)} className="mx-auto mt-14 max-w-[900px]">
              <HeroMock />
            </motion.div>
          </div>
        </section>

        {/* ── Mascot crowd (the vellum.ai moment) ── */}
        <StarCrowdSection />

        {/* ── Why (problem-first, agent-reach style) ── */}
        <section id="why" className="px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-3xl text-center">
            <Reveal>
              <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Why Muster</div>
              <h2 className="text-[clamp(26px,4vw,38px)] font-bold leading-tight tracking-[-0.02em] text-[#f5f5f5]">
                AI agents can write code. Ask one to check your inbox, and it's blind.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-[#a1a1a6]">
                Chat apps rent you a model. Muster gives each agent a name, a memory that persists between tasks, and a real Linux desktop it drives — so "check my mail and draft the reply" is a job, not a wish.
              </p>
            </Reveal>
            <div className="mt-10 grid gap-4 text-left sm:grid-cols-3">
              {[
                { t: "One chat tab per task", d: "Twelve browser tabs of half-finished prompts. No memory between them, no handoffs." },
                { t: "Agents with no hands", d: "Models that can reason but can't click, type, or run anything — so nothing actually gets done." },
                { t: "Lock-in by subscription", d: "Renting someone else's key and their sandbox, with your data on their servers." },
              ].map((p) => (
                <Reveal key={p.t}>
                  <div className="h-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
                    <div className="text-[14px] font-semibold text-[#f5f5f5]">{p.t}</div>
                    <div className="mt-2 text-[13px] leading-relaxed text-[#a1a1a6]">{p.d}</div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Features</div>
              <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Agents that behave like a team</h2>
              <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-[#a1a1a6]">
                One assistant in one box is the wrong shape for agents. Muster treats AI the way a real team works — a roster of agents you chat with like contacts, each with its own personality, memory, model, computer, and connected apps.
              </p>
            </Reveal>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, desc }, i) => (
                <Reveal key={title} delay={0.07 * (i % 3)} className="h-full">
                  <div className="group h-full rounded-2xl border border-white/[0.06] bg-[#141414] p-6 transition-all hover:-translate-y-0.5 hover:border-[rgba(240,70,14,.28)]">
                    <div className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] text-[#ff7a45] transition-colors group-hover:bg-[rgba(240,70,14,.1)]">
                      <Icon size={20} />
                    </div>
                    <h3 className="mb-2 text-[15px] font-semibold tracking-tight text-[#f5f5f5]">{title}</h3>
                    <p className="text-[14px] leading-relaxed text-[#a1a1a6]">{desc}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Engines ── */}
        <section id="engines" className="px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Engines</div>
              <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Bring your own model</h2>
              <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-[#a1a1a6]">
                Muster doesn't ship a model of its own — your bots run on the AI CLIs already installed and logged in on your machine, using your existing subscriptions. Point any engine at a custom binary in Settings → Engines.
              </p>
            </Reveal>
            <div className="mt-8 flex flex-wrap gap-2.5">
              {ENGINES.map((e, i) => (
                <Reveal key={e} delay={0.04 * i}>
                  <span className="inline-block rounded-full border border-white/[0.08] bg-[#1d1d1f] px-4 py-2 text-[13px] font-medium text-[#a1a1a6]">{e}</span>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Download ── */}
        <section id="download" className="border-y border-white/[0.06] bg-[#141414] px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Download</div>
              <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Get Muster</h2>
            </Reveal>
            <div className="mt-9 grid max-w-xl gap-3.5">
              {DOWNLOADS.map(({ os, meta, href, label }, i) => (
                <Reveal key={os} delay={0.05 * i}>
                  <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-[#0a0a0a] px-5 py-4 transition-colors hover:border-[rgba(240,70,14,.28)]">
                    <div>
                      <div className="font-semibold text-[#f5f5f5]">{os}</div>
                      <div className="mt-0.5 text-[13px] text-[#a1a1a6]">{meta}</div>
                    </div>
                    <a href={href} target="_blank" rel="noopener" className="text-[14px] font-semibold text-[#ff7a45]">{label}</a>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── Platforms (agent-reach style support grid) ── */}
        <section className="px-6 pb-4 pt-20 max-sm:pt-12">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-center text-[clamp(24px,3.5vw,32px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">
                Runs everywhere you do
              </h2>
            </Reveal>
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                { name: "macOS", note: "Universal · signed & notarized" },
                { name: "Windows", note: "x64 installer + auto-update" },
                { name: "Web", note: "Self-host in one Docker command" },
                { name: "iOS", note: "Native companion · App Store kit ready" },
                { name: "Android", note: "Companion · sideload or Play" },
              ].map((p) => (
                <Reveal key={p.name}>
                  <div className="h-full rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-4 text-center">
                    <div className="text-[14px] font-semibold text-[#f5f5f5]">{p.name}</div>
                    <div className="mt-1 text-[11.5px] leading-snug text-[#a1a1a6]">{p.note}</div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="px-6 py-24 text-center max-sm:py-16">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Ready to muster your team?</h2>
              <p className="mt-3 text-[#a1a1a6]">Open source. Runs on the agents you already pay for.</p>
              <Link to={user ? "/app" : "/sign-up"} className="mt-9 inline-flex items-center gap-2 rounded-xl bg-[#f0460e] px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_10px_30px_rgba(240,70,14,.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(240,70,14,.42)]">
                Open Muster →
              </Link>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 text-[13px] text-[#a1a1a6]">
          <span>© 2026 Muster — built and maintained by <a href="https://orazen.online" target="_blank" rel="noopener" className="hover:text-[#f5f5f5]">Orazen</a>.</span>
          <span className="flex gap-4">
            <a href="https://github.com/Orazen/Muster" target="_blank" rel="noopener" className="hover:text-[#f5f5f5]">GitHub</a>
            <a href="https://github.com/Orazen/Muster/blob/main/LICENSE" target="_blank" rel="noopener" className="hover:text-[#f5f5f5]">BSL 1.1</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
