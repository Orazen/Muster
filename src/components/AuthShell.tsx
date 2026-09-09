import type { ReactNode } from "react";
import { ArrowUpRight, Check, Layers3, MessageSquare } from "lucide-react";
import { MusterbotMark } from "./MusterbotMark";
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
          <span className="auth-eyebrow">A place for your AI team</span>
          <h2>Good work.<br />Great <em>company.</em></h2>
          <p className="auth-story-intro">Bring your agents together. Give them a task, follow their work, and keep the decisions that matter.</p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="auth-orbit auth-orbit-outer" /><div className="auth-orbit auth-orbit-inner" />
            <div className="auth-mascot"><MusterbotMark size={160} /></div>
            <span className="auth-note auth-note-plan"><Layers3 size={17} /> A shared plan</span>
            <span className="auth-note auth-note-chat"><MessageSquare size={17} /> Room to collaborate</span>
            <span className="auth-note auth-note-review"><Check size={17} /> Your final say</span>
          </div>
          <div className="auth-story-footer"><span>Persistent agents.</span><span>Human decisions.</span></div>
        </aside>
        <section id="auth-form" className="auth-form-panel" aria-labelledby="auth-title">
          <div className="auth-form-content">
            <span className="auth-eyebrow">Your workspace</span>
            <h1 id="auth-title">{title}</h1><p className="auth-subtitle">{subtitle}</p>
            <div className="auth-fields">{children}</div>
            {footer && <div className="auth-footer">{footer}</div>}
          </div>
        </section>
      </main>
      <footer className="auth-bottom"><span>Muster your agents.</span><a href="/download.html">Get the desktop app <ArrowUpRight size={13} aria-hidden="true" /></a></footer>
    </div>
  );
}

export const authInputCls = "auth-input";
export const authButtonCls = "auth-submit";
export const authCardBox = "auth-notice";
