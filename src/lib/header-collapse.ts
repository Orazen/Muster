/**
 * Header collapse (U3): the conversation header reclaims its vertical
 * chrome while you read down the transcript, and comes back the moment
 * you scroll up or reach the top.
 *
 * Directional with a dead-zone: only a real downward nudge past the
 * threshold collapses, only a real upward nudge expands, and momentum
 * jitter mid-list holds whatever state it had. The top rule wins over
 * everything — near the top there is nothing to reclaim, so the full
 * header (task/model/tools/interrupt) is always shown.
 *
 * Pure so the scroll handler stays a wire, not a brain: this function is
 * the whole behavior and is tested as such.
 */

export interface HeaderCollapseInput {
  collapsed: boolean;
  previousScrollTop: number;
  scrollTop: number;
}

/** px from the top below which the header is always expanded. */
export const HEADER_COLLAPSE_AT = 64;
/** px of deliberate scroll needed to change direction (dead-zone). */
const DIRECTION_DEAD_ZONE = 4;

export function nextHeaderCollapse({ collapsed, previousScrollTop, scrollTop }: HeaderCollapseInput): boolean {
  if (scrollTop <= HEADER_COLLAPSE_AT) return false;
  const delta = scrollTop - previousScrollTop;
  if (delta > DIRECTION_DEAD_ZONE) return true;
  if (delta < -DIRECTION_DEAD_ZONE) return false;
  return collapsed;
}
