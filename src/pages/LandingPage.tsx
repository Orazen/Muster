import { Link } from "react-router-dom";
import { Cpu, Monitor, Shield, Plug, Users, Key } from "lucide-react";
import { useAuth } from "@/lib/auth";

function StarLogo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 -20 260 260" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="star-logo-grad" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8cd1b3" />
          <stop offset="55%" stopColor="#009957" />
          <stop offset="100%" stopColor="#005932" />
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
  { os: "Windows", meta: "64-bit · one-click installer, no admin rights", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster-setup.exe", label: "Download .exe" },
  { os: "Ubuntu", meta: "24.04 x64 · .deb or AppImage", href: "https://github.com/Orazen/Muster/releases/latest/download/Muster.deb", label: "Download .deb" },
  { os: "Self-host (web)", meta: "Run the web UI + harness in Docker", href: "https://github.com/Orazen/Muster/blob/main/docs/self-host.md", label: "Docker guide" },
];

export function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-xl bg-[#0a0a0a]/70">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[#f5f5f5]">
            <StarLogo size={28} />
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
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[rgba(240,70,14,.28)] bg-[rgba(240,70,14,.07)] px-3.5 py-1.5 text-[13px] font-medium text-[#ff7a45]">
              Open source · local-first · bring your own AI
            </div>
            <h1 className="text-[clamp(42px,7vw,76px)] font-bold leading-[1.02] tracking-[-0.035em] text-[#f5f5f5]">
              Muster{" "}
              <span className="bg-gradient-to-br from-[#ff7a45] via-[#f0460e] to-[#c93a0b] bg-clip-text text-transparent">
                your agents.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-[19px] leading-relaxed text-[#a1a1a6]">
              A local-first roster of AI agents you actually own. Bring your own Claude, Codex, Grok, Gemini, Kimi, Qwen, Hermes, Droid, Antigravity, or OpenCode Go — give each one a body, and run your team from a chat app, not a subscription.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3.5">
              <Link to={user ? "/app" : "/sign-up"} className="inline-flex items-center gap-2 rounded-xl bg-[#f0460e] px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_10px_30px_rgba(240,70,14,.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(240,70,14,.42)]">
                {user ? "Open Muster →" : "Get Started →"}
              </Link>
              <a href="https://github.com/Orazen/Muster/releases/latest" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
                Download for macOS
              </a>
              <a href="https://github.com/Orazen/Muster" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
                View on GitHub
              </a>
            </div>
            <div className="mx-auto mt-14 max-w-[900px] overflow-hidden rounded-2xl border border-white/[0.08] shadow-[0_30px_80px_rgba(0,0,0,.5)]">
              <img src="/hero.png" alt="Muster — a chat app where every chat is a real AI agent" className="block w-full" />
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Features</div>
            <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Agents that behave like a team</h2>
            <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-[#a1a1a6]">
              One assistant in one box is the wrong shape for agents. Muster treats AI the way a real team works — a roster of agents you chat with like contacts, each with its own personality, memory, model, computer, and connected apps.
            </p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="group rounded-2xl border border-white/[0.06] bg-[#141414] p-6 transition-all hover:-translate-y-0.5 hover:border-[rgba(240,70,14,.28)]">
                  <div className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] text-[#ff7a45] transition-colors group-hover:bg-[rgba(240,70,14,.1)]">
                    <Icon size={20} />
                  </div>
                  <h3 className="mb-2 text-[15px] font-semibold tracking-tight text-[#f5f5f5]">{title}</h3>
                  <p className="text-[14px] leading-relaxed text-[#a1a1a6]">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Engines ── */}
        <section id="engines" className="px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Engines</div>
            <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Bring your own model</h2>
            <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-[#a1a1a6]">
              Muster doesn't ship a model of its own — your bots run on the AI CLIs already installed and logged in on your machine, using your existing subscriptions. Point any engine at a custom binary in Settings → Engines.
            </p>
            <div className="mt-8 flex flex-wrap gap-2.5">
              {ENGINES.map((e) => (
                <span key={e} className="rounded-full border border-white/[0.08] bg-[#1d1d1f] px-4 py-2 text-[13px] font-medium text-[#a1a1a6]">{e}</span>
              ))}
            </div>
          </div>
        </section>

        {/* ── Download ── */}
        <section id="download" className="border-y border-white/[0.06] bg-[#141414] px-6 py-20 max-sm:py-12">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#ff7a45]">Download</div>
            <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Get Muster</h2>
            <div className="mt-9 grid max-w-xl gap-3.5">
              {DOWNLOADS.map(({ os, meta, href, label }) => (
                <div key={os} className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-[#0a0a0a] px-5 py-4 transition-colors hover:border-[rgba(240,70,14,.28)]">
                  <div>
                    <div className="font-semibold text-[#f5f5f5]">{os}</div>
                    <div className="mt-0.5 text-[13px] text-[#a1a1a6]">{meta}</div>
                  </div>
                  <a href={href} target="_blank" rel="noopener" className="text-[14px] font-semibold text-[#ff7a45]">{label}</a>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="px-6 py-24 text-center max-sm:py-16">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-[clamp(28px,4vw,40px)] font-bold tracking-[-0.02em] text-[#f5f5f5]">Ready to muster your team?</h2>
            <p className="mt-3 text-[#a1a1a6]">Open source. Runs on the agents you already pay for.</p>
            <Link to={user ? "/app" : "/sign-up"} className="mt-9 inline-flex items-center gap-2 rounded-xl bg-[#f0460e] px-7 py-3.5 text-[15px] font-semibold text-white shadow-[0_10px_30px_rgba(240,70,14,.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(240,70,14,.42)]">
              Open Muster →
            </Link>
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
