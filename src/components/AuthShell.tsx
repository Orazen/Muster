import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { MusterbotMark } from "./MusterbotMark";
import { MusterBloom } from "./MusterBloom";
import "./auth.css";
import "./AuthShell.css";

/** Auth owns its scroll area because the surrounding desktop app does not. */
export function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle: string; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="auth-shell auth-shell--welcome">
      <a className="auth-skip" href="#auth-form">Skip to form</a>
      <header className="auth-header">
        <a href="/" aria-label="Muster home" className="auth-brand">
          <MusterbotMark size={38} /><span>Muster</span>
        </a>
        <a className="auth-help" href="/docs">Need a hand? <ArrowUpRight size={15} aria-hidden="true" /></a>
      </header>
      <main className="auth-layout">
        <div className="auth-welcome-mascot">
          <span className="auth-welcome-orbit" aria-hidden="true" />
          <MusterBloom size={128} />
          <span className="auth-welcome-note" aria-hidden="true">A little company.</span>
        </div>
        <section id="auth-form" className="auth-form-panel" aria-labelledby="auth-title" tabIndex={-1}>
          <div className="auth-form-content">
            <span className="auth-eyebrow">Your personal AI team</span>
            <h1 id="auth-title">{title}</h1><p className="auth-subtitle">{subtitle}</p>
            <div className="auth-fields">{children}</div>
            {footer && <div className="auth-footer">{footer}</div>}
          </div>
        </section>
      </main>
      <footer className="auth-bottom"><span>Your goals. Your final say.</span><a href="/download.html">Get the desktop app <ArrowUpRight size={13} aria-hidden="true" /></a></footer>
    </div>
  );
}

export const authInputCls = "auth-input";
export const authButtonCls = "auth-submit";
export const authCardBox = "auth-notice";
