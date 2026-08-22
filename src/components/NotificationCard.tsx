import { Bell } from "lucide-react";
import { cn } from "@/lib/cn";
import { gaiaTheme } from "@/lib/gaia-theme";

/** Gaia-style notification card — Vellum-inspired proactivity. Rendered by
 * NotificationStack for live harness frames; kind picks the semantic accent
 * (see gaiaTheme.notifications). */
export function NotificationCard({
  title,
  message,
  kind = "info",
  onDismiss,
  onOpen,
}: {
  title: string;
  message: string;
  kind?: "info" | "warning" | "action";
  onDismiss?: () => void;
  onOpen?: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-auto w-[340px] rounded-2xl border px-4 py-3.5 transition",
        gaiaTheme.card.shadow,
        kind === "warning"
          ? gaiaTheme.notifications.warning
          : kind === "action"
            ? gaiaTheme.notifications.action
            : gaiaTheme.notifications.info,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <Bell size={16} className={kind === "warning" ? "text-amber-500" : kind === "action" ? "text-rose-500" : "text-ink-secondary"} />
        </div>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-secondary">{message}</div>
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="shrink-0 rounded-md px-1.5 py-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
