import { OVERLAY_CURSOR_MIN_INTERVAL_MS } from '@extension/shared';

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The CDP layer never talks to the content script itself; index.ts installs
 * the real overlay senders here. Defaults are no-ops so the handlers work
 * before (or without) the overlay being wired.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- the no-op defaults keep
   the real signatures so index.ts can drop its implementations straight in. */
const overlayHooks = {
  beforeCapture: async (tabId: number): Promise<void> => {},
  afterCapture: async (tabId: number): Promise<void> => {},
  cursor: async (tabId: number, x: number, y: number, kind?: string, label?: string): Promise<void> => {},
  pulse: async (tabId: number): Promise<void> => {},
  target: async (tabId: number, rect: Rect): Promise<void> => {},
};
/* eslint-enable @typescript-eslint/no-unused-vars */

const lastCursorPost = new Map<number, number>();

/**
 * Throttled cursor post: a bezier glide emits dozens of mouseMoved steps in a
 * few hundred ms, and the page-side overlay animates between points anyway.
 * The final point always posts so the cursor never rests off-target.
 */
const postCursor = (tabId: number, x: number, y: number, final: boolean, kind?: string, label?: string): void => {
  const now = Date.now();
  const last = lastCursorPost.get(tabId) ?? 0;
  if (!final && now - last < OVERLAY_CURSOR_MIN_INTERVAL_MS) return;
  lastCursorPost.set(tabId, now);
  overlayHooks.cursor(tabId, x, y, kind, label).catch(() => {});
};

export type { Rect };
export { overlayHooks, postCursor };
