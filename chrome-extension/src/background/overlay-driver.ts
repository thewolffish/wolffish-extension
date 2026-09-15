/**
 * The on-page shadow cursor, driven from the service worker.
 *
 * A tab is "in use" from the moment a command targets it — however it was
 * resolved: the Wolffish workspace fallback, an explicit tabId, or a window
 * opened by browser_window_open (whose tab deliberately sits OUTSIDE the tab
 * group). Keying on command traffic rather than group membership is the whole
 * point: the user must see the cursor on whatever page Wolffish is actually
 * touching, and on nothing else.
 *
 * Read-only commands raise the pill alone ("Wolffish is reading this tab");
 * input commands add the cursor, the target outline and the click ripple.
 *
 * Everything here is best-effort. A page that refuses injection (a PDF viewer,
 * a restricted origin, a tab mid-navigation) must never fail the command that
 * happened to be running — the overlay is a courtesy to the user, not part of
 * the contract with the model.
 */
import {
  OVERLAY_IDLE_ALARM_MINUTES,
  OVERLAY_IDLE_MS,
  STORAGE_KEY_INUSE,
  STORAGE_KEY_OVERLAY_ENABLED,
  ensureContentScriptInjected,
  log,
} from '@extension/shared';
import type { OverlayPayload } from '@extension/shared';
import { getActivityLabel } from './workspace.js';

const api = globalThis.chrome;

const IDLE_ALARM = 'wolffish-overlay-idle';

type InUseKind = 'read' | 'input';

/** Internal kind → the pill's own vocabulary, which is written for the user. */
const pillMode = (kind: InUseKind): 'working' | 'reading' => (kind === 'input' ? 'working' : 'reading');
type InUseEntry = { at: number; kind: InUseKind };
type InUseMap = Record<string, InUseEntry>;

/** Mirrored to storage.session so a restarted worker still knows which tabs to clear. */
const inUse = new Map<number, InUseEntry>();
/** Last cursor per tab, replayed after a navigation so it never vanishes mid-task. */
const lastCursor = new Map<number, { x: number; y: number; kind?: string; label?: string }>();

let enabled = true;

const stateArea = (): chrome.storage.StorageArea => api.storage.session ?? api.storage.local;

const persist = (): void => {
  const bag: InUseMap = {};
  for (const [tabId, entry] of inUse) bag[String(tabId)] = entry;
  stateArea()
    .set({ [STORAGE_KEY_INUSE]: bag })
    .catch(() => {});
};

const readEnabled = async (): Promise<boolean> => {
  try {
    const bag = await api.storage.local.get([STORAGE_KEY_OVERLAY_ENABLED]);
    return bag[STORAGE_KEY_OVERLAY_ENABLED] !== false;
  } catch {
    return true;
  }
};

/** The switch lives in storage so the side panel can flip it without the app. */
const initOverlayDriver = async (): Promise<void> => {
  enabled = await readEnabled();
  try {
    const bag = await stateArea().get([STORAGE_KEY_INUSE]);
    const stored = (bag?.[STORAGE_KEY_INUSE] as InUseMap | undefined) ?? {};
    for (const [tabId, entry] of Object.entries(stored)) inUse.set(Number(tabId), entry);
  } catch {
    // A lost in-use map costs one stale overlay, cleared by the idle sweep.
  }
};

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEY_OVERLAY_ENABLED in changes)) return;
  enabled = changes[STORAGE_KEY_OVERLAY_ENABLED].newValue !== false;
  log(`Overlay ${enabled ? 'enabled' : 'disabled'}`);
  if (!enabled) {
    for (const tabId of inUse.keys()) void post(tabId, { type: 'overlay', op: 'hide' }, true);
  }
});

const setOverlayEnabled = async (value: boolean): Promise<void> => {
  await api.storage.local.set({ [STORAGE_KEY_OVERLAY_ENABLED]: value }).catch(() => {});
  enabled = value;
};

const isOverlayEnabled = (): boolean => enabled;

/**
 * Send one overlay op. `force` bypasses the enabled check so a hide can still
 * clean up a cursor that was drawn before the switch was turned off.
 */
const post = async (tabId: number, payload: OverlayPayload, force = false): Promise<void> => {
  if (!enabled && !force) return;
  try {
    await ensureContentScriptInjected(tabId);
    await api.tabs.sendMessage(tabId, {
      source: 'service-worker',
      target: 'content-script',
      payload,
    });
  } catch {
    // Page cannot host the overlay (restricted origin, viewer, closing tab).
  }
};

const pillText = async (): Promise<string | undefined> => {
  const label = await getActivityLabel();
  const emoji = (label?.emoji ?? '').trim();
  const text = (label?.text ?? '').trim();
  if (!emoji && !text) return undefined;
  return [emoji, text].filter(Boolean).join(' ');
};

/**
 * Called for every command that resolves a tab. Raises the pill the first
 * time, upgrades 'read' to 'input' when the task starts acting, and re-arms
 * the idle sweep.
 */
const markTabInUse = async (tabId: number, kind: InUseKind): Promise<void> => {
  const previous = inUse.get(tabId);
  inUse.set(tabId, { at: Date.now(), kind });
  persist();
  api.alarms.create(IDLE_ALARM, { delayInMinutes: OVERLAY_IDLE_ALARM_MINUTES });
  if (!enabled) return;
  // Repaint when the tab is new to us or the mode changed; otherwise the pill
  // is already up and repainting it on every command is pure message traffic.
  if (previous && previous.kind === kind) return;
  await post(tabId, { type: 'overlay', op: 'pill', mode: pillMode(kind), text: await pillText() });
};

const clearTab = async (tabId: number): Promise<void> => {
  inUse.delete(tabId);
  lastCursor.delete(tabId);
  persist();
  await post(tabId, { type: 'overlay', op: 'hide' }, true);
};

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== IDLE_ALARM) return;
  const now = Date.now();
  for (const [tabId, entry] of [...inUse]) {
    if (now - entry.at > OVERLAY_IDLE_MS) void clearTab(tabId);
  }
  if (inUse.size > 0) api.alarms.create(IDLE_ALARM, { delayInMinutes: OVERLAY_IDLE_ALARM_MINUTES });
});

api.tabs.onRemoved.addListener(tabId => {
  inUse.delete(tabId);
  lastCursor.delete(tabId);
  persist();
});

/**
 * A click that navigates destroys the overlay with the old document. Put it
 * back on the new one, cursor included, so the user's view of "where Wolffish
 * is" survives the page change.
 */
api.webNavigation?.onCompleted?.addListener(async details => {
  if (details.frameId !== 0 || !enabled) return;
  const entry = inUse.get(details.tabId);
  if (!entry || Date.now() - entry.at > OVERLAY_IDLE_MS) return;
  await post(details.tabId, { type: 'overlay', op: 'pill', mode: pillMode(entry.kind), text: await pillText() });
  const cursor = lastCursor.get(details.tabId);
  if (cursor) {
    await post(details.tabId, {
      type: 'overlay',
      op: 'cursor',
      x: cursor.x,
      y: cursor.y,
      kind: (cursor.kind as OverlayPayload['kind']) ?? 'pointer',
      label: cursor.label,
      animate: false,
    });
  }
});

/** The real implementations the CDP layer calls through `overlayHooks`. */
const overlayDriver = {
  beforeCapture: async (tabId: number): Promise<void> => {
    await post(tabId, { type: 'overlay', op: 'capture_hide' });
  },
  afterCapture: async (tabId: number): Promise<void> => {
    await post(tabId, { type: 'overlay', op: 'capture_show' });
  },
  cursor: async (tabId: number, x: number, y: number, kind?: string, label?: string): Promise<void> => {
    lastCursor.set(tabId, { x, y, kind, label });
    await post(tabId, {
      type: 'overlay',
      op: 'cursor',
      x,
      y,
      kind: (kind as OverlayPayload['kind']) ?? 'pointer',
      label,
      animate: true,
    });
  },
  pulse: async (tabId: number): Promise<void> => {
    await post(tabId, { type: 'overlay', op: 'pulse' });
  },
  target: async (tabId: number, rect: { x: number; y: number; width: number; height: number }): Promise<void> => {
    await post(tabId, { type: 'overlay', op: 'target', rect });
  },
};

export type { InUseKind };
export { clearTab, initOverlayDriver, isOverlayEnabled, markTabInUse, overlayDriver, setOverlayEnabled };
