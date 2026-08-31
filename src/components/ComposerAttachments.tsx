// Chips for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste collapses into a card of its
// first lines instead of flooding the composer; a file dropped anywhere
// on the window attaches by path; an image becomes a stored attachment —
// straight from disk when Electron can name it, uploaded when it cannot.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, File as FileIcon, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  attachmentsFromDroppedFiles,
  attachmentUrl,
  formatSize,
  imageAttachment,
  pasteSummary,
  type Attachment,
  type ImageAttachment,
} from "@/lib/composer-attachments";
import { MAX_IMAGE_BYTES, uploadImageAttachment } from "@/lib/image-upload";

/** Electron 32 removed File.path — only the preload can name a file. */
function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

const isImageFile = (file: File): boolean => file.type.startsWith("image/");

type ImageResolve = { attachment?: ImageAttachment; reason?: string };

/** An image drop resolves without an upload when its disk path is known;
 * pathless images (browser drags) go up to the server instead. */
async function resolveImageFile(file: File): Promise<ImageResolve> {
  const path = pathForFile(file);
  if (path) return { attachment: imageAttachment(file.name, path, file.size) };
  if (file.size > MAX_IMAGE_BYTES) {
    return { reason: `${file.name} is over the ${formatSize(MAX_IMAGE_BYTES)} image limit` };
  }
  try {
    return { attachment: await uploadImageAttachment(file) };
  } catch (e) {
    return { reason: `${file.name}: ${e instanceof Error ? e.message : "upload failed"}` };
  }
}

export function ComposerAttachments({
  items,
  onAdd,
  onRemove,
  allowImages = false,
  engineLabel,
  externalNotice,
  onDismissExternalNotice,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[]) => void;
  onRemove: (id: string) => void;
  /** The bot's engine reads images by path — gates every way an image could
   * become a chip. Default false: an unknown engine must not silently accept
   * an attachment it would ignore. */
  allowImages?: boolean;
  /** Display name used in the refusal notice when allowImages is false. */
  engineLabel?: string | null;
  /** Paste refusals surface here — pastes happen in the composer's textarea,
   * which lives above this component. */
  externalNotice?: string | null;
  onDismissExternalNotice?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay
  // tracks depth rather than the last event it happened to see
  const depth = useRef(0);

  useEffect(() => {
    let active = true;
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // without preventDefault the window navigates to the dropped file and
    // the app is simply gone
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      // Images resolve their own way (path or upload); everything else keeps
      // the exact classification it always had.
      const others = files.filter((f) => !isImageFile(f));
      const { attachments, rejectedNames } = await attachmentsFromDroppedFiles(others, pathForFile);
      let notices = rejectedNames;
      if (files.some(isImageFile)) {
        if (!allowImages) {
          notices = [
            ...notices,
            `${engineLabel ?? "This engine"} can't read images yet — attach a file path instead.`,
          ];
        } else {
          const resolved = await Promise.all(files.filter(isImageFile).map(resolveImageFile));
          const imageChips = resolved.flatMap((r) => (r.attachment ? [r.attachment] : []));
          notices = [...notices, ...resolved.flatMap((r) => (r.reason ? [r.reason] : []))];
          if (!active) return;
          if (imageChips.length) onAdd(imageChips);
        }
      }
      if (!active) return;
      if (attachments.length) onAdd(attachments);
      setNotice(notices.length ? notices.join(" ") : null);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      active = false;
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAdd, allowImages, engineLabel]);

  return (
    <>
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-10">
          <div className="rounded-2xl border-2 border-dashed border-accent/70 bg-panel/90 px-8 py-6 text-[14px] font-medium text-ink shadow-2xl">
            Drop to attach — the bot gets the file path
          </div>
        </div>
      )}

      {externalNotice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{externalNotice}</span>
          <button
            onClick={onDismissExternalNotice}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {items.map((a) =>
            a.kind === "paste" ? (
              <Chip
                key={a.id}
                label="PASTED"
                title={a.text.slice(0, 4000)}
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
                </div>
                <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(a)}</div>
              </Chip>
            ) : a.kind === "image" ? (
              <Chip key={a.id} label="IMAGE" title={a.path} onRemove={() => onRemove(a.id)}>
                <AttachedChipPreview path={a.path} name={a.name} size={a.size} />
              </Chip>
            ) : (
              <Chip key={a.id} label="FILE" title={a.path} onRemove={() => onRemove(a.id)}>
                <div className="flex h-[76px] items-center gap-2">
                  <FileIcon size={16} className="shrink-0 text-ink-secondary" />
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{a.name}</div>
                    <div className="text-[10.5px] text-ink-secondary/70">{formatSize(a.size)}</div>
                  </div>
                </div>
              </Chip>
            ),
          )}
        </div>
      )}
    </>
  );
}

function Chip({
  children,
  label,
  title,
  onRemove,
}: {
  children: React.ReactNode;
  label: "PASTED" | "FILE" | "IMAGE";
  title: string;
  onRemove: () => void;
}) {
  const Icon = label === "PASTED" ? ClipboardPaste : label === "IMAGE" ? ImageIcon : FileIcon;
  return (
    <div
      title={title}
      className={cn(
        "group relative w-[172px] rounded-xl border border-hairline/40 bg-raised px-2.5 py-2",
        "transition-colors hover:border-hairline",
      )}
    >
      {children}
      <div className="mt-1 flex items-center gap-1">
        <Icon size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          {label}
        </span>
      </div>
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard */}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label === "PASTED" ? "pasted text" : label === "IMAGE" ? "image" : "file"}`}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/** Thumbnail for an image chip. A disk-path image has no URL until sent and
 * re-served — show the icon card for those rather than a broken img. */
function AttachedChipPreview({ path, name, size }: { path: string; name: string; size: number }) {
  const url = attachmentUrl(path);
  return (
    <div className="flex h-[76px] items-center gap-2">
      {url ? (
        <img
          src={url}
          alt={name}
          className="h-full w-full rounded-lg border border-hairline/30 object-cover"
        />
      ) : (
        <>
          <ImageIcon size={16} className="shrink-0 text-ink-secondary" />
          <div className="min-w-0">
            <div className="truncate text-[12px] text-ink">{name}</div>
            <div className="text-[10.5px] text-ink-secondary/70">{formatSize(size)}</div>
          </div>
        </>
      )}
    </div>
  );
}
