import { Link } from "react-router-dom";
import { Star, Cpu, Monitor, Shield, Plug, Users, Key } from "lucide-react";
import { useAuth } from "@/lib/auth";

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
  { os: "macOS", meta: "Apple silicon · signed & notarized · one-click .dmg", href: "https://github.com/tharunramagiri/Muster/releases/latest/download/Muster.dmg", label: "Download .dmg" },
  { os: "Windows", meta: "64-bit · one-click installer, no admin rights", href: "https://github.com/tharunramagiri/Muster/releases/latest/download/Muster-setup.exe", label: "Download .exe" },
  { os: "Ubuntu", meta: "24.04 x64 · build .deb / AppImage from source", href: "https://github.com/tharunramagiri/Muster#quick-start", label: "Build from source" },
  { os: "Self-host (web)", meta: "Run the web UI + harness in Docker", href: "https://github.com/tharunramagiri/Muster/blob/main/docs/self-host.md", label: "Docker guide" },
];

export function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-xl bg-[#0a0a0a]/70">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-[#f5f5f5]">
            <Star size={24} className="fill-[#f0460e] text-[#f0460e]" />
            Muster
          </Link>
          <div className="flex items-center gap-6 max-sm:hidden">
            <a href="#features" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Features</a>
            <a href="#engines" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Engines</a>
            <a href="#download" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">Download</a>
            <a href="https://github.com/tharunramagiri/Muster" target="_blank" rel="noopener" className="text-[13px] font-medium text-[#a1a1a6] transition-colors hover:text-[#f5f5f5]">GitHub</a>
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
              <a href="https://github.com/tharunramagiri/Muster/releases/latest" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
                Download for macOS
              </a>
              <a href="https://github.com/tharunramagiri/Muster" target="_blank" rel="noopener" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-7 py-3.5 text-[15px] font-semibold text-[#f5f5f5] transition-all hover:-translate-y-0.5 hover:border-white/20">
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
            <a href="https://github.com/tharunramagiri/Muster" target="_blank" rel="noopener" className="hover:text-[#f5f5f5]">GitHub</a>
            <a href="https://github.com/tharunramagiri/Muster/blob/main/LICENSE" target="_blank" rel="noopener" className="hover:text-[#f5f5f5]">MIT License</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
