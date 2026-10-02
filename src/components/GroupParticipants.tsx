import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { AgentBotAvatar } from "./AgentBotAvatar";

type Participant = Pick<Bot, "id" | "name" | "character" | "color">;

/** Identity only: being busy elsewhere does not make a bot this room's speaker. */
export function GroupParticipants({
  members,
  busyBotId,
  variant = "strip",
}: {
  members: readonly Participant[];
  busyBotId?: string | null;
  variant?: "strip" | "welcome";
}) {
  const welcome = variant === "welcome";
  if (!members.length) return null;

  return (
    <div
      role={welcome ? undefined : "region"}
      aria-label={welcome ? undefined : "Room participant strip"}
      tabIndex={welcome ? undefined : 0}
      className={cn(
        "min-w-0 max-w-full",
        !welcome && "overflow-x-auto rounded-xl pb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
      )}
    >
    <ul
      aria-label={welcome ? "Agents in this room" : "Room participants"}
      className={cn("flex gap-2", welcome ? "w-full flex-wrap justify-center gap-3" : "w-max")}
    >
      {members.map((member) => {
        const working = member.id === busyBotId;
        return (
          <li
            key={member.id}
            className={cn(
              "flex min-w-0 max-w-full items-center border text-left",
              welcome
                ? "w-[120px] flex-col gap-2 rounded-2xl px-3 py-4 text-center sm:w-[136px]"
                : "shrink-0 gap-2 rounded-xl py-1.5 pl-2 pr-3",
              working ? "border-accent/35 bg-accent/10" : "border-hairline/40 bg-raised/30",
            )}
          >
            <AgentBotAvatar
              character={member.character ?? "flower"}
              seed={member.id}
              color={member.color}
              state={working ? "working" : "idle"}
              animated={working}
              size={welcome ? 56 : 26}
              className={cn(
                "items-center justify-center [&_canvas]:m-0! [&_canvas]:max-h-full [&_canvas]:max-w-full",
                welcome ? "size-14" : "size-[26px]",
              )}
            />
            <div className="min-w-0 max-w-full">
              <span
                title={member.name}
                className={cn(
                  "block font-medium text-ink",
                  welcome ? "break-words text-[13px] leading-snug [overflow-wrap:anywhere]" : "max-w-[140px] truncate text-[12px]",
                )}
              >
                {member.name}
              </span>
              {working && (
                <span className="mt-0.5 flex items-center gap-1 text-[10px] font-medium leading-tight text-accent">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
                  Working here
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
    </div>
  );
}
