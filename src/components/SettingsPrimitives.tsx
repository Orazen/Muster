// The settings-row anatomy (SettingRow) adapts OpenMausBot's settings rows:
// © OpenMausBot contributors, licensed under the Apache License 2.0.
// Surface and action primitives compose GAIA UI; domain props remain Muster's.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card as GaiaCard } from "./ui/card";
import { Button } from "./ui/button";

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <GaiaCard className="workspace-settings-card rounded-xl border-0 bg-card p-4 shadow-none">
      {title && <div className="workspace-settings-card-title text-[15px] font-medium text-ink">{title}</div>}
      {subtitle && <div className={title ? "mt-0.5 text-[13px] leading-relaxed text-ink-secondary" : "text-[13px] leading-relaxed text-ink-secondary"}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </GaiaCard>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void copy()}
        aria-label="Copy command"
        className="h-auto w-auto shrink-0 rounded border-0 p-1 text-ink-secondary hover:bg-raised hover:text-ink [&_svg]:size-[13px]"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </Button>
    </div>
  );
}

/**
 * A settings row: label + description on the left, control slot on the right,
 * shaped like the surrounding cards (rounded-xl bg-card).
 * Anatomy adapted from OpenMausBot's settings rows (Apache-2.0, see file head).
 */
export function SettingRow({
  label,
  description,
  children,
  disabled,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <GaiaCard
      className={cn(
        "workspace-setting-row flex items-center justify-between gap-4 rounded-xl border-0 bg-card px-4 py-3.5 shadow-none",
        disabled && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">{label}</div>
        {description && (
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </GaiaCard>
  );
}

/**
 * A toggle switch for settings rows — same anatomy Muster already uses for
 * per-bot switches in SettingsPanel (accent when on, raised when off).
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-accent" : "bg-raised",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-5 rounded-full bg-white transition-all",
          checked ? "left-[21px]" : "left-[3px]",
        )}
      />
    </button>
  );
}
