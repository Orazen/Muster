import { useEffect, useState } from "react";
import { onNotifyFrame, type NotifyFrame } from "@/lib/notify";
import { useStore } from "@/state/store";
import { NotificationCard } from "./NotificationCard";

type BannerKind = "info" | "warning" | "action";

/** Map the harness's notification kinds onto the card's semantic accents:
 * anything blocked on you is an action, failures warn, completions inform. */
const kindFor = (frame: NotifyFrame): BannerKind => {
  if (frame.kind === "routine-failed") return "warning";
  if (frame.kind === "approval" || frame.kind === "question") return "action";
  return "info";
};

interface Banner {
  id: number;
  frame: NotifyFrame;
  kind: BannerKind;
}

const MAX_BANNERS = 3;
const AUTO_DISMISS_MS = 6_000;

/** Live in-app notifications for harness notify frames. The desktop channel
 * covers backgrounded windows with granted permission; this stack covers the
 * rest — focused windows and denied/unavailable browser permission — which
 * previously dropped those frames on the floor. Clicking a card opens the
 * bot that sent it. */
export function NotificationStack() {
  const { dispatch } = useStore();
  const [banners, setBanners] = useState<Banner[]>([]);

  useEffect(() => {
    let nextId = 0;
    return onNotifyFrame((frame, desktopShown) => {
      if (desktopShown) return;
      const id = ++nextId;
      setBanners((prev) => [...prev.slice(-(MAX_BANNERS - 1)), { id, frame, kind: kindFor(frame) }]);
      window.setTimeout(() => {
        setBanners((prev) => prev.filter((banner) => banner.id !== id));
      }, AUTO_DISMISS_MS);
    });
  }, []);

  const openBot = (botId: string) => dispatch({ type: "select", id: botId });

  if (banners.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
    >
      {banners.map((banner) => (
        <NotificationCard
          key={banner.id}
          title={banner.frame.title}
          message={banner.frame.body || banner.frame.botName}
          kind={banner.kind}
          onOpen={() => {
            openBot(banner.frame.botId);
            setBanners((prev) => prev.filter((entry) => entry.id !== banner.id));
          }}
          onDismiss={() => setBanners((prev) => prev.filter((entry) => entry.id !== banner.id))}
        />
      ))}
    </div>
  );
}
