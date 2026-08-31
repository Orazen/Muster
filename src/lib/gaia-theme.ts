/** Gaia Design System — theme tokens integrated into Muster */
export const gaiaTheme = {
  // Typography scale (Gaia uses tighter tracking, slightly larger headings)
  headings: "tracking-[-0.01em] font-[system-ui,sans-serif]",
  body: "font-[system-ui,sans-serif] antialiased",

  // Card elevation (Gaia prefers subtle borders + light shadows over heavy backgrounds)
  card: {
    bg: "bg-card/90",
    border: "border-hairline/40",
    shadow: "shadow-[0_1px_3px_rgba(0,0,0,0.08)]",
    radius: "rounded-2xl", // 16px — Gaia's signature
  },

  // Memory / notification accent colors (Vellum-style semantic colors)
  memory: {
    episodic: "text-amber-400",
    semantic: "text-sky-400",
    procedural: "text-emerald-400",
    emotional: "text-rose-400",
    prospective: "text-violet-400",
    behavioral: "text-teal-400",
    narrative: "text-amber-300",
    shared: "text-indigo-400",
  },

  // Proactivity notification states (Vellum-inspired)
  notifications: {
    info: "border-hairline/50 bg-card",
    warning: "border-amber-300/30 bg-amber-50/80",
    action: "border-rose-300/30 bg-rose-50/80",
  },

  // Component spacing (Gaia uses more generous internal padding)
  spacing: {
    cardPadding: "p-4",
    sectionGap: "gap-3",
    buttonPadding: "px-3.5 py-2",
  },
};
