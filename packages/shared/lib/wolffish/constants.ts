export const DEFAULT_PORT = 23151;
export const LOG_PREFIX = '[Wolffish]';

export const RECONNECT = {
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  BACKOFF_MULTIPLIER: 2,
} as const;

export const HEARTBEAT_INTERVAL_MS = 15000;
export const COMMAND_TIMEOUT_MS = 30000;

export const CONTENT_SCRIPT_PING_TIMEOUT_MS = 500;
export const ELEMENT_SCROLL_SETTLE_MS = 100;
export const HUMANIZE_MIN_DELAY_MS = 30;
export const HUMANIZE_MAX_DELAY_MS = 100;
export const HUMANIZE_CLICK_MIN_DELAY_MS = 50;
export const HUMANIZE_CLICK_MAX_DELAY_MS = 150;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
