export const DEFAULT_PORT = 23151;
export const LOG_PREFIX = '[Wolffish]';

/**
 * Reconnect cadence. Chrome clamps MV3 alarms to a 30-second floor for
 * installed/unpacked extensions, so the honest value is half a minute; the
 * 15-second WebSocket ping is what keeps the worker alive while connected.
 */
export const RECONNECT_ALARM_MINUTES = 0.5;

export const HEARTBEAT_INTERVAL_MS = 15000;
export const COMMAND_TIMEOUT_MS = 30000;

export const CONTENT_SCRIPT_PING_TIMEOUT_MS = 500;
export const ELEMENT_SCROLL_SETTLE_MS = 100;
// Per-keystroke jitter for humanized typing. Small enough that long text
// (e.g. a multi-paragraph post body) finishes in a few seconds, large enough
// that keystrokes still arrive as discrete, irregularly-spaced events.
export const HUMANIZE_MIN_DELAY_MS = 5;
export const HUMANIZE_MAX_DELAY_MS = 20;
export const HUMANIZE_CLICK_MIN_DELAY_MS = 50;
export const HUMANIZE_CLICK_MAX_DELAY_MS = 150;

// ─── v2: snapshot, sessions, overlay ──────────────────────────────────────

/** Network and console ring-buffer size per tab (since last main-frame navigation). */
export const RING_BUFFER_SIZE = 500;
/** Response bodies longer than this are truncated (chars). */
export const NETWORK_BODY_MAX_CHARS = 200_000;
/** Post-action wait: how long a navigation has to START before we assume none. */
export const ACTION_NAV_START_MS = 200;
/** Post-action wait: DOM must be quiet this long. */
export const ACTION_DOM_QUIET_MS = 120;
/** Post-action wait: hard cap on the DOM-quiet check. */
export const ACTION_DOM_QUIET_MAX_MS = 1500;
/** Post-action wait: hard cap on a navigation settle. */
export const ACTION_NAV_SETTLE_MAX_MS = 5000;
/** An in-use tab whose last command is older than this loses its overlay. */
export const OVERLAY_IDLE_MS = 20_000;
/** Overlay idle sweep alarm (minutes; Chrome floor is 0.5). */
export const OVERLAY_IDLE_ALARM_MINUTES = 0.5;
/** Shadow-cursor updates are posted to the page at most this often. */
export const OVERLAY_CURSOR_MIN_INTERVAL_MS = 16;
/** Storage keys shared by the service worker and content script. */
export const STORAGE_KEY_OVERLAY_ENABLED = 'wf:overlay-enabled';
export const STORAGE_KEY_CDP_TABS = 'wf:cdp-tabs';
export const STORAGE_KEY_INUSE = 'wf:inuse';
export const STORAGE_KEY_SNAPSHOT_PREFIX = 'wf:snap:';
/** Bundled file the app writes into the extension folder; read at connect time. */
export const BRIDGE_TOKEN_FILE = 'bridge-token.json';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
