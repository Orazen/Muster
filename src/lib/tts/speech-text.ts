// Spoken register — the Vellum insight: agent output is written for eyes,
// and a voice reading it aloud must not recite syntax. This rewrites a
// message BEFORE synthesis: markdown structure dissolves, links keep their
// words and drop their URLs, code stops being read character by character,
// and artifacts get named instead of dumped. Plain prose passes through
// untouched — the rewrite is for what the screen was formatting, not for
// what the bot was saying.

/** Strip markdown syntax down to what should be heard. */
export function speechText(raw: string): string {
  if (!raw) return "";
  let text = raw;

  // Fenced code: never read source aloud — name it, keep the language.
  text = text.replace(/```([\w+-]*)[^\S\n]*\n[\s\S]*?```/g, (_m, lang: string) =>
    lang ? ` [${lang} code shown on screen] ` : " [code shown on screen] ",
  );
  // Unclosed fence (streamed reply cut mid-block): drop the body.
  text = text.replace(/```[\w+-]*[^\S\n]*\n[\s\S]*$/g, " [code shown on screen]");
  // Inline code: the word itself is speakable, the backticks are not.
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Images then links: words survive, URLs never get read aloud.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? ` [image: ${alt}] ` : " [image] "));
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs: replace with a spoken placeholder.
  text = text.replace(/https?:\/\/\S+/g, " [link] ");
  // Tables: rows of pipes are unreadable aloud — collapse to cells joined
  // by commas, dropping separator rows entirely.
  text = text
    .split("\n")
    .filter((line) => !(/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")))
    .map((line) => (line.includes("|") && /^\s*\|/.test(line) ? line.split("|").map((c) => c.trim()).filter(Boolean).join(", ") : line))
    .join("\n");
  // Headings, emphasis, blockquotes, list markers: structure, not speech.
  // [ \t]* only — \s would let ^-anchored matches swallow the newlines that
  // mark paragraph breaks, and the pauses those breaks become are the point.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  // Horizontal rules and stray markdown residue.
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");

  // Emojis carry tone on screen and noise through a speaker.
  // eslint-disable-next-line no-misleading-character-class
  text = text.replace(/\p{Extended_Pictographic}/gu, "");
  // Whitespace: collapse runs, keep single newlines (TTS pauses there).
  text = text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, ". ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
