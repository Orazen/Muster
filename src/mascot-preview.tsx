import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentBotAvatar,
  BOT_AVATAR_TYPES,
  type BotAvatarFace,
  type BotAvatarState,
  type BotAvatarType,
} from "@/components/AgentBotAvatar";
import { AGENT_COLOR_NAMES, AGENT_COLORS, type AgentColor } from "@/lib/mascot";
import "./styles.css";
import "./mascot-preview.css";

/** The three draw states `bot-avatars` ships; the app maps its 39 onto these. */
const GALLERY_STATES: { state: BotAvatarState; label: string }[] = [
  { state: "default", label: "idle" },
  { state: "working", label: "working" },
  { state: "sleeping", label: "sleeping" },
];

const FACES: { face: BotAvatarFace; label: string }[] = [
  { face: "eyes", label: "eyes (blink)" },
  { face: "mouth", label: "mouth" },
];

function Gallery() {
  const [color, setColor] = useState<AgentColor>("orange");
  const [face, setFace] = useState<BotAvatarFace>("eyes");
  const [paused, setPaused] = useState(false);
  const [type, setType] = useState<BotAvatarType>("flower");

  return (
    <main className="preview-shell">
      <header className="preview-header">
        <div>
          <p className="eyebrow">bot-avatars · 18 shapes · 3 states</p>
          <h1>Agent avatar library</h1>
          <p className="intro">
            Every avatar in Muster is drawn by <code>bot-avatars</code> through the shared
            <code> AgentBotAvatar</code> adapter — the same component the app renders. Pick a
            shape, a colour and a face; pause to see the single frame reduced-motion users get.
          </p>
        </div>
      </header>

      <section className="tuner" aria-label="Avatar controls">
        <div className="tuner-controls">
          <div className="tuner-block">
            <h3>Colour</h3>
            <div className="chips">
              {AGENT_COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === color ? "on" : ""}
                  onClick={() => setColor(c)}
                >
                  <span className="swatch" style={{ background: AGENT_COLORS[c] }} />
                  {c}
                </button>
              ))}
            </div>

            <h3>Face</h3>
            <div className="chips">
              {FACES.map(({ face: f, label }) => (
                <button
                  key={f}
                  type="button"
                  className={face === f ? "on" : ""}
                  onClick={() => setFace(f)}
                >
                  {label}
                </button>
              ))}
            </div>

            <h3>Motion</h3>
            <div className="chips">
              <button type="button" className={!paused ? "on" : ""} onClick={() => setPaused(false)}>
                animated
              </button>
              <button type="button" className={paused ? "on" : ""} onClick={() => setPaused(true)}>
                paused
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="expression-library" aria-labelledby="gallery-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Identity system · 54 combinations</p>
            <h2 id="gallery-heading">Shapes and states</h2>
          </div>
          <p>Move your pointer over any avatar — it tracks by default.</p>
        </div>

        <div className="matrix-wrap">
          <div className="matrix">
            <div className="corner-label">Shape ↓ / state →</div>
            {GALLERY_STATES.map(({ state, label }) => (
              <div className="column-label" key={state}>
                <strong>{label}</strong>
                <span>bot-avatars “{state}”</span>
              </div>
            ))}

            {BOT_AVATAR_TYPES.map((t) => (
              <div className="matrix-row" key={t}>
                <div className="row-label">
                  <strong>{t}</strong>
                  <code>{t}</code>
                  <button
                    type="button"
                    className={type === t ? "on" : ""}
                    onClick={() => setType(t)}
                  >
                    focus
                  </button>
                </div>
                {GALLERY_STATES.map(({ state }) => (
                  <div className="mascot-cell" key={`${t}-${state}`}>
                    <AgentBotAvatar
                      type={t}
                      state={state}
                      face={face}
                      fill={AGENT_COLORS[color]}
                      size={86}
                      seed={`gallery-${t}`}
                      animated={!paused}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="motion-grid" aria-label="Focused shape">
        <article className="motion-card">
          <div className="motion-stage">
            <AgentBotAvatar
              type={type}
              face={face}
              fill={AGENT_COLORS[color]}
              size={240}
              seed={`focus-${type}`}
              animated={!paused}
              label={`${type} avatar`}
            />
          </div>
          <footer className="motion-meta">
            <div>
              <span className="motion-number">{String(BOT_AVATAR_TYPES.indexOf(type) + 1).padStart(2, "0")}</span>
              <h2>{type}</h2>
              <p>Focused shape · {color} · {face} face · {paused ? "paused" : "animated"}</p>
            </div>
          </footer>
        </article>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
