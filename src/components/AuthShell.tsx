import type { ReactNode } from "react";
import { ArrowUpRight, Check, CalendarDays, Sparkles } from "lucide-react";
import { MusterbotMark } from "./MusterbotMark";
import { MusterBloom } from "./MusterBloom";
import "./auth.css";

/** Auth owns its scroll area because the surrounding desktop app does not. */
export function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <a className="auth-skip" href="#auth-form">Skip to form</a>
      <header className="auth-header">
        <a href="/" aria-label="Muster home" className="auth-brand">
          <MusterbotMark size={38} /><span>Muster</span>
        </a>
        <a className="auth-help" href="/docs">Need a hand? <ArrowUpRight size={15} aria-hidden="true" /></a>
      </header>
      <main className="auth-layout">
        <aside className="auth-story" aria-label="About Muster">
          <span className="auth-eyebrow"><span className="auth-status-dot" /> A little help for everyday life</span>
          <h2>Big plans.<br /><em>A little company.</em></h2>
          <p className="auth-story-intro">Meet your personal AI team. Make a plan, find an answer, and keep the final say.</p>
          <div className="auth-illustration">
            <div className="auth-orbit auth-orbit-outer" aria-hidden="true" />
            <div className="auth-mascot"><MusterBloom size={170} /></div>
          </div>
          <div className="auth-day-card">
            <div className="auth-day-heading"><CalendarDays size={17} aria-hidden="true" /><span>A day with Muster</span><span className="auth-sample-label">Example</span></div>
            <div className="auth-day-item"><Check size={15} aria-hidden="true" /><span>Turn a busy morning into a plan</span></div>
            <div className="auth-day-item"><Sparkles size={15} aria-hidden="true" /><span>Leave room for what matters</span></div>
          </div>
          <div className="auth-story-footer"><span>Your goals.</span><span>Your final say.</span></div>
        </aside>
        <section id="auth-form" className="auth-form-panel" aria-labelledby="auth-title">
          <div className="auth-form-content">
            <span className="auth-eyebrow">Welcome to Muster</span>
            <h1 id="auth-title">{title}</h1><p className="auth-subtitle">{subtitle}</p>
            <div className="auth-fields">{children}</div>
            {footer && <div className="auth-footer">{footer}</div>}
          </div>
        </section>
      </main>
      <footer className="auth-bottom"><span>A team on your side.</span><a href="/download.html">Get the desktop app <ArrowUpRight size={13} aria-hidden="true" /></a></footer>
    </div>
  );
}

export const authInputCls = "auth-input";
export const authButtonCls = "auth-submit";
export const authCardBox = "auth-notice";
