/** The musterbot mark, alive: this is now a thin alias over MusterBloom
 * (interactive eyes, expressions, click pop) so every existing call site
 * inherits the behavior without changes. `interactive` stays off here —
 * chrome spots (empty states, auth shells, OS) opt in explicitly via
 * MusterBloom where pointer play makes sense. */
import { MusterBloom } from "./MusterBloom";

export function MusterbotMark({
  size = 250,
  wordmark = false,
}: {
  size?: number;
  /** Renders the letter-spaced MUSTER wordmark under the mark. */
  wordmark?: boolean;
}) {
  return <MusterBloom size={size} wordmark={wordmark} interactive={false} />;
}
