import { Bell } from "lucide-react";
import { cn } from "@/lib/cn";

/** Gaia-style notification card — Vellum-inspired proactivity */
export function NotificationCard({
  title,
  message,
  kind = "info",
  onDismiss,
}: {
  title: string;
  message: string;
  kind?: "info" | "warning" | "action";
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3.5 shadow-lg shadow-black/10 transition",
        kind === "warning"
          ? "border-amber-300/30 bg-amber-50/80 text-ink"
          : kind === "action"
            ? "border-rose-300/30 bg-rose-50/80 text-ink"
            : "border-hairline/50 bg-card text-ink",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <Bell size={16} className={kind === "warning" ? "text-amber-500" : kind === "action" ? "text-rose-500" : "text-ink-secondary"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{title}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{message}</div>
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-secondary hover:bg-raised hover:text-ink">Dismiss</button>
        )}
      </div>
    </div>
  );
}
