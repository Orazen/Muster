import { useState } from "react";
import { authInputCls } from "./AuthShell";

export function AuthPasswordField({ id, label = "Password", value, onChange, autoComplete, minLength, hint }: {
  id: string; label?: string; value: string; onChange(value: string): void;
  autoComplete: "current-password" | "new-password"; minLength?: number; hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  return <div>
    <label className="auth-label" htmlFor={id}>{label}</label>
    <div className="auth-password">
      <input id={id} name={id} type={visible ? "text" : "password"} required
        value={value} onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete} minLength={minLength} className={authInputCls}
        aria-describedby={hint ? `${id}-hint` : undefined} />
      <button type="button" className="auth-password-toggle" aria-controls={id}
        aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`} aria-pressed={visible}
        onClick={() => setVisible(!visible)}>{visible ? "Hide" : "Show"}</button>
    </div>
    {hint && <p id={`${id}-hint`} className="auth-hint">{hint}</p>}
  </div>;
}
