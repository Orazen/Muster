import { ArrowUpRight, MessageCircle, Plus, Radio, Users } from "lucide-react";
import type { Bot } from "@/state/store";
import { AgentAvatar } from "@/components/Avatar";
import { MusterBloom } from "@/components/MusterBloom";
import { buildWorkspaceSummary, operationalAvatarState } from "./workspace-state";

interface WorkspaceHomeProps {
  bots: Bot[];
  connected: boolean;
  hydrated: boolean;
  onOpenBot: (botId: string) => void;
  onOpenChat: (botId: string) => void;
  onAsk: () => void;
  onRooms: () => void;
  onApp: () => void;
}

/** A view of received work state. Decisions stay in their existing chat flow. */
export function WorkspaceHome({ bots, connected, hydrated, onOpenBot, onOpenChat, onAsk, onRooms, onApp }: WorkspaceHomeProps) {
  const summary = buildWorkspaceSummary(bots, connected);
  const lanes = [
    { key: "decisions", title: "Needs your decision", hint: "A small answer. A next step.", empty: "No decisions waiting in the received workspace.", items: summary.decisions },
    { key: "working", title: "In progress", hint: "Work you can follow.", empty: "No teammates are currently reporting active work.", items: summary.working },
    { key: "replies", title: "Ready to read", hint: "The latest from your team.", empty: "New replies to your tasks will appear here.", items: summary.replies },
  ];
  const visibleBots = bots.filter((bot) => !bot.hidden);
  const mood = connected && hydrated ? summary.decisions.length ? "thinking" : summary.working.length ? "working" : "idle" : "idle";

  return (
    <section className="os-workspace" aria-label="Workspace overview">
      <div className="os-workspace-inner">
        <div className="os-workspace-heading">
          <div>
            <p className="os-eyebrow">YOUR WORKSPACE</p>
            <h1>Your team.<br /><span>Your next move.</span></h1>
            <p className="os-workspace-intro">Make a decision, follow the work, or start something useful.</p>
            <div className="os-workspace-actions">
              <button type="button" className="os-primary-action" onClick={visibleBots.length ? onAsk : onApp} disabled={!hydrated || !connected}>
                <Plus size={16} /> {visibleBots.length ? "Give your team a task" : "Set up your first teammate"}
              </button>
              <button type="button" className="os-secondary-action" onClick={onRooms}>
                <Users size={16} /> Open rooms
              </button>
            </div>
          </div>
          <div className="os-workspace-mascot">
            <span className="os-mascot-orbit" aria-hidden="true" />
            <MusterBloom size={144} mood={mood} animated={connected && hydrated} />
            <span className="os-mascot-caption">A little company for big ideas.</span>
          </div>
        </div>

        <div className="os-workspace-connection" role="status">
          <Radio size={13} aria-hidden="true" />
          {!hydrated ? "Loading your workspace…" : connected ? "Connected to your workspace" : "Reconnecting. Showing the last received workspace."}
        </div>

        {!hydrated ? (
          <div className="os-workspace-loading">Your teammates and their latest work will appear here.</div>
        ) : (
          <>
            <div className="os-work-lanes">
              {lanes.map((lane) => (
                <section key={lane.key} className="os-work-lane" data-lane={lane.key} data-empty={lane.items.length === 0} aria-label={lane.title}>
                  <div className="os-lane-heading"><h2>{lane.title}</h2><span>{lane.items.length}</span></div>
                  <p className="os-lane-hint">{lane.hint}</p>
                  {lane.items.length ? <div className="os-work-items">
                    {lane.items.map(({ bot, title, detail }) => (
                      <button type="button" key={bot.id} className="os-work-item" onClick={() => onOpenChat(bot.id)} aria-label={`${title}: ${bot.name}`}>
                        <div className="os-work-item-top">
                          <AgentAvatar color={bot.color} character={bot.character} state={operationalAvatarState(bot, connected)} size={32} label={bot.name} />
                          <strong>{bot.name}</strong><ArrowUpRight size={14} aria-hidden="true" />
                        </div>
                        <span className="os-work-item-title">{title}</span>
                        <span className="os-work-item-detail">{detail}</span>
                        <span className="os-work-item-link"><MessageCircle size={12} /> Open conversation</span>
                      </button>
                    ))}
                  </div> : <p className="os-lane-empty">{connected ? lane.empty : "Live status will return when the connection recovers."}</p>}
                </section>
              ))}
            </div>

            <section className="os-team" aria-label="Your team">
              <div className="os-team-heading"><h2>Your team</h2><span>{visibleBots.length} {visibleBots.length === 1 ? "teammate" : "teammates"}</span></div>
              {visibleBots.length ? <div className="os-team-list">
                {visibleBots.map((bot) => {
                  const item = [...summary.decisions, ...summary.working, ...summary.replies, ...summary.available, ...summary.disconnected].find((entry) => entry.bot.id === bot.id);
                  return <button type="button" className="os-team-member" key={bot.id} onClick={() => onOpenBot(bot.id)} aria-label={`Open ${bot.name} workspace`}>
                    <AgentAvatar color={bot.color} character={bot.character} state={operationalAvatarState(bot, connected)} size={38} label={bot.name} />
                    <span className="os-team-member-copy">
                      <strong>{bot.name}</strong><small>{item?.title ?? "Status unavailable"}</small>
                      {item && summary.disconnected.includes(item) && <small>{item.detail}</small>}
                    </span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>;
                })}
              </div> : <p className="os-lane-empty">Start with one teammate and one useful task. Your work will gather here.</p>}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
