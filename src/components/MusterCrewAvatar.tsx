import { memo, useEffect, useId, useRef, type CSSProperties } from "react";
import { CREW, normalizeCrewState, type CrewCharacter } from "@/lib/mascot/crew";
// @ts-expect-error The approved browser-safe actor is authored as JavaScript; Vite bundles this local import.
import { drawCompanionFace } from "../../www/landing-workroom/v1/mascot/expressions.js";
// @ts-expect-error The approved deterministic choreography has no TypeScript declaration.
import { sampleMotion, transferPosition } from "../../www/landing-workroom/v1/mascot/companion.js";
import "./muster-crew-avatar.css";

export interface MusterCrewAvatarProps {
  character: CrewCharacter;
  state?: string;
  color?: string;
  size?: number;
  label?: string;
  decorative?: boolean;
  animated?: boolean;
  interactive?: boolean;
  /** Restarts an explicit one-shot crew reaction without remounting the avatar. */
  replayKey?: number;
  className?: string;
  style?: CSSProperties;
}

/** A bundled SVG costume and a small 2D face canvas. No WebGL, network or saved state. */
function MusterCrewAvatarComponent({ character, state = "idle", color, size = 96, label,
  decorative = !label, animated = true, interactive = false, replayKey = 0, className, style }: MusterCrewAvatarProps) {
  const host = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const leftArm = useRef<SVGGElement>(null);
  const rightArm = useRef<SVGGElement>(null);
  const morph = useRef<SVGSVGElement>(null);
  const previousState = useRef(normalizeCrewState(state));
  const id = useId().replaceAll(":", "");
  const active = normalizeCrewState(state);
  const hasCue = ["thinking-dots", "orbit", "radar", "progress", "loading", "sending", "receiving", "uploading", "alerting", "notifying", "dictating", "powering-down"].includes(active);
  const bodyColor = color ?? CREW[character].color;
  const pixels = Number.isFinite(size) ? Math.max(12, Math.min(512, size)) : 96;
  const reducedMotion = globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // SAFETY: the sole extra style key is the component's own CSS color variable.
  const hostStyle = { ...style, width: pixels, height: pixels, "--crew-body": bodyColor } as CSSProperties;

  useEffect(() => {
    const element = host.current, actor = body.current, face = canvas.current;
    if (!element || !actor || !face) return;
    let context: CanvasRenderingContext2D | null;
    try { context = face.getContext("2d"); } catch { return; }
    if (!context) return;
    const ctx = context;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const prior = previousState.current;
    previousState.current = active;
    let frame = 0, last = 0, elapsed = 0, age = 0, disposed = false, failed = false;
    let inView = false;
    const pointer = { x: 0, y: 0 };
    const resolution = Math.min(512, Math.max(128, Math.ceil(pixels * Math.min(window.devicePixelRatio || 1, 2))));
    face.width = resolution;
    face.height = Math.round(resolution * .8);
    const running = () => animated && !media.matches && inView && !document.hidden && !disposed && !failed;

    function paint() {
      const moving = animated && !media.matches;
      const time = moving ? elapsed : 0;
      const stateTime = moving ? age : 3;
      ctx.setTransform(face!.width / 640, 0, 0, face!.height / 512, 0, 0);
      drawCompanionFace(ctx, { state: active, previousState: prior, time, stateTime,
        pointer, intensity: moving ? .6 : 0, transition: moving ? Math.min(1, age / .32) : 1 });
      const pose = sampleMotion({ weights: { [active]: 1 }, active, time, stateTime, intensity: moving ? .6 : 0, speechLevel: .55 });
      actor!.style.transform = `translate(${pose.x * 12}%, ${-(pose.y - .17) * 18}%) rotate(${pose.tilt * 40 + pose.spin * 180 / Math.PI}deg) skewX(${pose.yaw * 10}deg) scale(${pose.scale}, ${pose.scale * pose.scaleY})`;
      leftArm.current?.setAttribute("transform", `translate(${pose.leftX * 10} 0) rotate(${pose.left * 70} 78 179)`);
      rightArm.current?.setAttribute("transform", `translate(${pose.rightX * 10} 0) rotate(${pose.right * 70} 202 179)`);
      if (morph.current) {
        morph.current.style.opacity = hasCue ? "1" : "0";
        morph.current.style.transform = `rotate(${moving && active === "orbit" ? time * 36 : 0}deg)`;
        if (active === "thinking-dots") morph.current.querySelectorAll("[data-dot]").forEach((dot, index) => {
          dot.setAttribute("cy", String(145 + (moving ? Math.sin(time * 4 - index * .7) * 5 : 0)));
          dot.setAttribute("opacity", String(moving ? .65 + Math.sin(time * 4 - index * .7) * .3 : 1));
        });
        morph.current.querySelector("[data-progress]")?.setAttribute("stroke-dashoffset", String(moving ? -time * 28 : 0));
        const point = transferPosition(active, time, moving ? .6 : 0);
        morph.current.querySelector("[data-transfer]")?.setAttribute("transform", `translate(${point.x * 25} ${-(point.y - .17) * 30})`);
        morph.current.querySelector("[data-ripple]")?.setAttribute("r", String(moving ? 45 + (time % 1.4) * 13 : 54));
        morph.current.querySelector("[data-ripple]")?.setAttribute("opacity", String(moving ? 1 - (time % 1.4) / 1.4 : .7));
        morph.current.querySelectorAll("[data-wave]").forEach((bar, index) => {
          const height = moving ? 8 + (1 + Math.sin(time * 5 - index * .8)) * 11 : [10, 23, 34, 23, 10][index];
          bar.setAttribute("y1", String(205 - height));
          bar.setAttribute("y2", String(205 + height));
        });
      }
      element!.dataset.faceReady = "true";
    }
    function draw() {
      try { paint(); } catch {
        failed = true;
        delete element!.dataset.faceReady;
        actor!.style.transform = "";
      }
    }
    function tick(now: number) {
      frame = 0;
      if (!running()) { last = 0; return; }
      const delta = last ? Math.min((now - last) / 1000, .05) : 0;
      last = now; elapsed += delta; age += delta;
      draw();
      if (running()) frame = requestAnimationFrame(tick);
    }
    function synchronize() {
      cancelAnimationFrame(frame); frame = 0; last = 0;
      if (!observer) measureVisibility();
      element!.dataset.botPaused = String(!running());
      if (!document.hidden && inView) draw();
      if (running()) frame = requestAnimationFrame(tick);
    }
    function gaze(event: PointerEvent) {
      if (!interactive || !running()) return;
      const box = element!.getBoundingClientRect();
      pointer.x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1));
      pointer.y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1));
    }
    function resetGaze() { pointer.x = 0; pointer.y = 0; }
    function measureVisibility() {
      const box = element!.getBoundingClientRect();
      inView = box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
        && box.top < window.innerHeight && box.left < window.innerWidth;
    }
    const observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      synchronize();
    }) : null;
    observer?.observe(element);
    if (!observer) {
      // Capture scroll from nested app panels as well as the document viewport.
      window.addEventListener("scroll", synchronize, { passive: true, capture: true });
      window.addEventListener("resize", synchronize, { passive: true });
    }
    media.addEventListener("change", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    element.addEventListener("pointermove", gaze);
    element.addEventListener("pointerleave", resetGaze);
    // One static frame exists even before the intersection observer's first callback.
    draw(); synchronize();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (!observer) {
        window.removeEventListener("scroll", synchronize, true);
        window.removeEventListener("resize", synchronize);
      }
      media.removeEventListener("change", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
      element.removeEventListener("pointermove", gaze);
      element.removeEventListener("pointerleave", resetGaze);
      delete element.dataset.faceReady;
    };
  }, [active, animated, interactive, pixels, replayKey, hasCue]);

  return <span ref={host} className={`muster-crew-avatar ${className ?? ""}`} style={hostStyle}
    data-crew-character={character} data-bot-avatar={character} data-state={active} data-bot-color={bodyColor}
    data-bot-paused={!animated || reducedMotion || undefined} role={decorative ? undefined : "img"}
    aria-label={decorative ? undefined : label ?? CREW[character].label} aria-hidden={decorative || undefined}>
    <svg className="muster-crew-avatar__shadow" viewBox="0 0 280 280" aria-hidden="true"><ellipse cx="140" cy="262" rx="63" ry="9" fill="#252e26" opacity=".12" /></svg>
    <span ref={body} className="muster-crew-avatar__body">
      <svg viewBox="0 0 280 280" aria-hidden="true" className="muster-crew-avatar__sculpt">
        <defs>
          <linearGradient id={`${id}-clay`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fffef7" stopOpacity=".68" /><stop offset=".26" stopColor="var(--crew-body)" /><stop offset=".7" stopColor="var(--crew-body)" /><stop offset="1" stopColor="#252e26" stopOpacity=".64" /></linearGradient>
          <linearGradient id={`${id}-cloth`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#fff9e8" /><stop offset="1" stopColor="#c6b99c" /></linearGradient>
          <linearGradient id={`${id}-navy`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#354c71" /><stop offset="1" stopColor="#17253e" /></linearGradient>
        </defs>
        <path d="M140 29C91 29 67 61 64 107L64 166C62 204 75 240 101 254C127 270 166 252 188 231C211 209 218 186 217 148L214 104C212 56 184 29 140 29Z" fill={bodyColor} />
        <path d="M140 29C91 29 67 61 64 107L64 166C62 204 75 240 101 254C127 270 166 252 188 231C211 209 218 186 217 148L214 104C212 56 184 29 140 29Z" fill={`url(#${id}-clay)`} />
        <path d="M83 177Q140 157 208 174L205 215Q144 244 76 219Z" fill={character === "developer" ? `url(#${id}-navy)` : character === "designer" ? `url(#${id}-cloth)` : "none"} />
        {character === "designer" && <g data-costume="beret-apron">
          <path d="M81 168L93 159L101 181M194 162L189 181" fill="none" stroke="#fff3d9" strokeWidth="10" />
          <path d="M157 193L187 192L187 217Q172 226 155 215Z" fill="#eee0c4" stroke="#b6a88f" strokeWidth="1.7" />
          <path d="M171 200L180 173" stroke="#efb94a" strokeWidth="6" /><path d="M180 173L182 166" stroke="#e58580" strokeWidth="6" /><path d="M169 202L171 196" stroke="#41392f" strokeWidth="3" />
          <circle cx="103" cy="207" r="4" fill="#cc8166" /><circle cx="122" cy="220" r="3" fill="#8d5c88" />
        </g>}
        {character === "researcher" && <g data-costume="field-vest">
          <path d="M77 157Q86 153 95 161L126 179L124 225Q94 233 71 214Z" fill={`url(#${id}-cloth)`} stroke="#b9aa8b" strokeWidth="1.5" />
          <path d="M183 160Q200 153 209 169L210 215L161 227L160 181Z" fill={`url(#${id}-cloth)`} stroke="#b9aa8b" strokeWidth="1.5" />
          <path d="M174 185L198 182L200 208L175 212Z" fill="#cbbd9f" /><circle cx="187" cy="190" r="2" fill="#8b8069" />
        </g>}
        {character === "developer" && <g data-costume="hoodie-laptop">
          <path d="M70 157Q79 145 88 155Q143 182 198 155Q215 149 217 166Q182 190 137 190Q95 190 70 174Z" fill="#263955" stroke="#465c7a" strokeWidth="2" />
          <path d="M103 177L105 209M183 178L179 202" stroke="#e7dac1" strokeWidth="3.5" strokeLinecap="round" /><circle cx="105" cy="211" r="3.5" fill="#eee6d4" />
        </g>}
        {character === "coordinator" && <g data-costume="utility-jacket">
          <path d="M75 158L118 173L115 224Q91 232 69 215Z" fill={`url(#${id}-cloth)`} /><path d="M168 173L206 156L216 213Q196 229 172 226Z" fill={`url(#${id}-cloth)`} />
          <path d="M78 153L117 164L130 185L99 175ZM164 183L177 162L207 149L196 177Z" fill="#ed938b" />
          <path d="M181 191L206 187L209 213L184 219Z" fill="#f4e9d2" stroke="#c1b398" strokeWidth="1.5" /><circle cx="195" cy="199" r="2" fill="#b5a58a" />
        </g>}
        <g ref={leftArm}><path d="M77 161C59 150 43 168 45 189C47 208 62 214 76 207L91 194Z" fill={bodyColor} /><path d="M77 161C59 150 43 168 45 189C47 208 62 214 76 207L91 194Z" fill={`url(#${id}-clay)`} /></g>
        <g ref={rightArm}><path d="M204 159C220 148 235 160 236 181C235 201 223 213 209 205L198 190Z" fill={bodyColor} /><path d="M204 159C220 148 235 160 236 181C235 201 223 213 209 205L198 190Z" fill={`url(#${id}-clay)`} /></g>
        <rect x="77" y="61" width="130" height="104" rx="47" fill="#111313" stroke="#30392f" strokeOpacity=".45" strokeWidth="3" />
        <g className="muster-crew-avatar__fallback" fill="#fffef7"><ellipse cx="123" cy="110" rx="7" ry="15" /><ellipse cx="161" cy="109" rx="7" ry="15" /><path d="M136 131Q142 138 148 130" fill="none" stroke="#fffef7" strokeWidth="3" strokeLinecap="round" /></g>
      </svg>
      <canvas ref={canvas} className="muster-crew-avatar__face" aria-hidden="true" />
      <svg viewBox="0 0 280 280" aria-hidden="true" className="muster-crew-avatar__costume">
        {character === "designer" && <g>
          <path d="M61 62Q42 51 71 29Q115 2 163 17Q177 34 156 43L75 66Z" fill="#65415f" stroke="#53344d" strokeWidth="3" /><path d="M76 38Q114 16 151 23" fill="none" stroke="#906886" strokeWidth="6" opacity=".55" /><path d="M92 22L87 10" stroke="#65415f" strokeWidth="8" strokeLinecap="round" />
          {[[-28, "#eb815c"], [-13, "#eab75b"], [2, "#f294a3"]].map(([angle, shade]) => <g key={angle} transform={`rotate(${angle} 58 186)`}><rect x="44" y="137" width="23" height="57" rx="3" fill="#fff7e4" stroke="#d5cbb6" /><rect x="47" y="140" width="17" height="14" rx="2" fill={String(shade)} /><rect x="47" y="157" width="17" height="14" rx="2" fill={String(shade)} opacity=".65" /><circle cx="55" cy="185" r="2" fill="#baad95" /></g>)}
          <ellipse cx="59" cy="194" rx="18" ry="22" fill={bodyColor} />
        </g>}
        {character === "researcher" && <g>
          <g fill="none" stroke="#b6b7a5" strokeWidth="3"><ellipse cx="112" cy="112" rx="28" ry="32" /><ellipse cx="176" cy="110" rx="28" ry="32" /><path d="M140 108Q146 104 148 108M84 108L65 111M204 105L215 101" /></g>
          <g transform="rotate(13 103 193)"><rect x="81" y="161" width="43" height="63" rx="4" fill="#705535" stroke="#bca27d" strokeWidth="2" /><path d="M118 166L118 219" stroke="#eee0c5" strokeWidth="4" />{[168,180,192,204,216].map(y => <path key={y} d={`M80 ${y}h8`} stroke="#322f27" strokeWidth="3" />)}</g>
          <path d="M217 165L207 196" stroke="#605e4e" strokeWidth="7" strokeLinecap="round" /><ellipse cx="222" cy="151" rx="19" ry="24" fill="#cce5cf" fillOpacity=".26" stroke="#b9baa5" strokeWidth="4" /><path d="M216 136Q229 134 232 148" fill="none" stroke="#f4ffed" strokeWidth="4" strokeLinecap="round" />
        </g>}
        {character === "developer" && <g>
          <path d="M123 211L143 173L226 166Q231 166 229 174L212 218L115 226L95 220Z" fill="#414342" stroke="#838680" strokeWidth="2" /><path d="M163 189L154 198L162 202M190 187L199 194L189 201M180 186L170 204" fill="none" stroke="#99e6e8" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><path d="M112 220L207 217" stroke="#9d9f91" strokeWidth="2" />
        </g>}
        {character === "coordinator" && <g>
          <ellipse cx="214" cy="107" rx="9" ry="20" fill="#4b454d" /><ellipse cx="216" cy="104" rx="3" ry="6" fill="#f09a94" /><path d="M213 123Q211 138 199 142" fill="none" stroke="#4b454d" strokeWidth="4" strokeLinecap="round" />
          <g transform="rotate(6 121 205)"><rect x="91" y="168" width="59" height="72" rx="5" fill="#42443e" /><rect x="96" y="174" width="49" height="60" rx="3" fill="#eee5cf" /><rect x="109" y="165" width="22" height="7" rx="2" fill="#8c8b7d" />{["#e48165", "#e7b957", "#7eb792"].map((fill, i) => <g key={fill}><circle cx="107" cy={188 + i * 16} r="5" fill={fill} /><path d={`M119 ${188 + i * 16}h16`} stroke="#cec5b2" strokeWidth="4" strokeLinecap="round" /></g>)}</g>
        </g>}
      </svg>
    </span>
    <svg ref={morph} className="muster-crew-avatar__morph" data-cue={hasCue ? active : undefined} viewBox="0 0 280 280" aria-hidden="true">
      {active === "thinking-dots" && [100,140,180].map(x => <circle data-dot key={x} cx={x} cy="145" r="14" fill={bodyColor} stroke="#252e26" strokeWidth="2" />)}
      {["orbit", "radar", "progress", "loading"].includes(active) && <g fill="none" stroke={bodyColor} strokeWidth="5">
        <ellipse data-progress cx="140" cy="153" rx="107" ry="48" strokeDasharray={active === "radar" ? "5 12" : "170 45"} />
        {active === "radar" ? <path d="M140 153L218 121M140 153L184 195" strokeLinecap="round" /> : <circle cx="236" cy="133" r="8" fill={bodyColor} />}
      </g>}
      {["sending", "receiving"].includes(active) && <g data-transfer>
        <rect x="77" y="99" width="126" height="92" rx="23" fill="#252e26" stroke={bodyColor} strokeWidth="8" />
        <path d="M94 121L140 153L186 121M94 174L119 148M186 174L161 148" fill="none" stroke="#fffef7" strokeWidth="7" strokeLinejoin="round" />
        <path d={active === "sending" ? "M165 216H229M209 195L231 216L209 237" : "M115 216H51M71 195L49 216L71 237"} fill="none" stroke="#252e26" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
      </g>}
      {active === "uploading" && <g data-transfer>
        <circle cx="198" cy="147" r="46" fill="#252e26" stroke={bodyColor} strokeWidth="7" />
        <path d="M198 170V122M181 140L198 121L215 140" fill="none" stroke="#fffef7" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <path data-progress d="M166 191H230" fill="none" stroke={bodyColor} strokeWidth="9" strokeDasharray="42 22" strokeLinecap="round" />
      </g>}
      {active === "alerting" && <g><path d="M188 139Q195 128 202 139L239 205Q245 217 230 217H160Q145 217 152 205Z" fill="#252e26" stroke={bodyColor} strokeWidth="7" /><path d="M195 157V185" stroke="#fffef7" strokeWidth="9" strokeLinecap="round" /><circle cx="195" cy="202" r="5" fill="#fffef7" /></g>}
      {active === "notifying" && <g><circle data-ripple cx="207" cy="161" r="54" fill="none" stroke={bodyColor} strokeWidth="5" /><circle cx="207" cy="161" r="38" fill="#252e26" stroke={bodyColor} strokeWidth="6" /><path d="M193 167V155Q193 138 207 138Q221 138 221 155V167L226 174H188Z" fill="#fffef7" /><circle cx="207" cy="182" r="4" fill="#fffef7" /></g>}
      {active === "dictating" && <g><rect x="79" y="163" width="122" height="84" rx="30" fill="#252e26" stroke={bodyColor} strokeWidth="6" />{[108,124,140,156,172].map((x, i) => <line data-wave key={x} x1={x} x2={x} y1={205 - [10,23,34,23,10][i]} y2={205 + [10,23,34,23,10][i]} stroke="#fffef7" strokeWidth="8" strokeLinecap="round" />)}</g>}
      {active === "powering-down" && <g fill="none" strokeLinecap="round"><circle cx="140" cy="166" r="43" fill="#252e26" stroke={bodyColor} strokeWidth="7" /><path d="M122 146A28 28 0 1 0 158 146M140 133V162" stroke="#fffef7" strokeWidth="8" /></g>}
    </svg>
  </span>;
}

export const MusterCrewAvatar = memo(MusterCrewAvatarComponent);
