/** A static brand mark. Interactive surfaces opt into MusterBloom instead. */
import { MusterBloom } from "./MusterBloom";

export function MusterbotMark({
  size = 250,
  wordmark = false,
}: {
  size?: number;
  /** Renders the letter-spaced MUSTER wordmark under the mark. */
  wordmark?: boolean;
}) {
  return <MusterBloom size={size} wordmark={wordmark} interactive={false} animated={false} />;
}
