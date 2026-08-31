// What.
// Renders one transcript bubble's text: markdown when the message came from a
// bot, pre-wrapped plain text when it came from the user — with any
// <attached-image path="…"/> tags pulled out and shown as thumbnails.
//
// Why.
// Attached images travel inside the prompt text (every CLI engine opens files
// by path), so the transcript is where they must be re-constituted. Parsing
// happens in one shared component rather than per view, and only exact
// well-formed tags become images: anything else renders as the literal text
// it is, including a bot echoing the tag back half-formed.
import { attachmentUrl, splitAttachedImages } from "@/lib/composer-attachments";
import { ChatMarkdown } from "./ChatMarkdown";

export function MessageBody({ text, markdown = false }: { text: string; markdown?: boolean }) {
  const segments = splitAttachedImages(text);
  const hasImages = segments.some((s) => s.type === "image");
  if (!hasImages) {
    // The overwhelmingly common shape: exactly what each view rendered before.
    return markdown ? <ChatMarkdown text={text} /> : <>{text}</>;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          markdown ? (
            <ChatMarkdown key={i} text={seg.text} />
          ) : (
            <span key={i} className="whitespace-pre-wrap">
              {seg.text}
            </span>
          )
        ) : (
          <AttachedImage key={i} path={seg.path} />
        ),
      )}
    </>
  );
}

function AttachedImage({ path }: { path: string }) {
  const url = attachmentUrl(path);
  if (!url) {
    // Not a stored upload (a bot inventing a path, or hand-typed): show it as
    // text instead of silently dropping content the user may need to see.
    return (
      <div className="my-1 rounded-lg border border-hairline/30 bg-inset/40 px-3 py-2 font-mono text-[12px] break-all text-ink-secondary">
        🖼 {path}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt="attached image"
      loading="lazy"
      className="my-1 max-h-72 max-w-full rounded-lg border border-hairline/30"
    />
  );
}
