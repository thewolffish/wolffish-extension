import type { ConnectionStatus } from './constants.js';

// ─── Wire Protocol ───────────────────────────────────────────────────────────

export interface WolffishCommand {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface WolffishResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface WolffishEvent {
  type: 'event';
  event: string;
  data: unknown;
}

// ─── Internal Message Passing ────────────────────────────────────────────────

export type InternalMessageSource = 'offscreen' | 'service-worker' | 'content-script' | 'popup';

export interface InternalMessage {
  source: InternalMessageSource;
  target: InternalMessageSource;
  payload: WolffishCommand | WolffishResponse | WolffishEvent | ConnectionStatusPayload | PingPayload;
}

export interface ConnectionStatusPayload {
  type: 'connection_status';
  status: ConnectionStatus;
  port: number;
}

export interface PingPayload {
  type: 'ping' | 'pong';
}

export interface GetConnectionStatusRequest {
  type: 'get_connection_status';
}

export interface ConnectionStatusResponse {
  status: ConnectionStatus;
  port: number;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export interface BrowserNavigateParams {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded';
}

export interface BrowserNavigateResult {
  url: string;
  title: string;
  tabId: number;
}

export interface BrowserBackParams {
  tabId?: number;
}

export interface BrowserForwardParams {
  tabId?: number;
}

export interface BrowserReloadParams {
  hard?: boolean;
  tabId?: number;
}

// ─── Page Interaction ────────────────────────────────────────────────────────

export interface BrowserClickParams {
  selector: string;
  tabId?: number;
}

export interface BrowserClickResult {
  success: boolean;
  elementFound: boolean;
}

export interface BrowserTypeParams {
  selector: string;
  text: string;
  clearFirst?: boolean;
  humanize?: boolean;
  tabId?: number;
}

export interface BrowserSelectParams {
  selector: string;
  value: string;
  tabId?: number;
}

export interface BrowserHoverParams {
  selector: string;
  tabId?: number;
}

export interface BrowserScrollParams {
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  selector?: string;
  tabId?: number;
}

export interface BrowserFocusParams {
  selector: string;
  tabId?: number;
}

export interface BrowserKeypressParams {
  key: string;
  modifiers?: ('ctrl' | 'shift' | 'alt' | 'meta')[];
  tabId?: number;
}

export interface BrowserDragDropParams {
  sourceSelector: string;
  targetSelector: string;
  tabId?: number;
}

export interface BrowserFileUploadParams {
  selector: string;
  files: { name: string; content: string; mimeType: string }[];
  tabId?: number;
}

export interface BrowserSetValueParams {
  selector: string;
  value: string;
  tabId?: number;
}

export interface BrowserSetValueResult {
  success: boolean;
  value: string;
}

export interface BrowserSubmitFormParams {
  /** A selector inside (or of) the form. Omit to submit the focused element's form. */
  selector?: string;
  tabId?: number;
}

// ─── Page Reading ────────────────────────────────────────────────────────────

export interface BrowserReadPageParams {
  format?: 'text' | 'markdown' | 'html';
  selector?: string;
  tabId?: number;
}

export interface BrowserReadPageResult {
  content: string;
  url: string;
  title: string;
}

export interface BrowserQuerySelectorParams {
  selector: string;
  attributes?: string[];
  limit?: number;
  tabId?: number;
}

export interface ElementInfo {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserQuerySelectorResult {
  elements: ElementInfo[];
}

export interface BrowserGetAttributeParams {
  selector: string;
  attributes: string[];
  tabId?: number;
}

export interface BrowserGetAttributeResult {
  attributes: Record<string, string | null>;
}

export interface BrowserGetValueParams {
  selector: string;
  tabId?: number;
}

export interface BrowserGetValueResult {
  value: string;
  type: string;
}

export interface BrowserGetUrlParams {
  tabId?: number;
}

export interface BrowserGetUrlResult {
  url: string;
  title: string;
}

export interface BrowserGetPageInfoParams {
  tabId?: number;
}

export interface BrowserGetPageInfoResult {
  url: string;
  title: string;
  description: string;
  favicon: string;
  lang: string;
  links: { href: string; text: string }[];
  headings: { level: number; text: string }[];
  forms: { action: string; method: string; fields: { name: string; type: string; id: string }[] }[];
}

// ─── Tab Management ──────────────────────────────────────────────────────────

export interface BrowserTabsListParams {
  windowId?: number;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  windowId: number;
}

export interface BrowserTabsListResult {
  tabs: TabInfo[];
}

export interface BrowserTabOpenParams {
  url?: string;
  active?: boolean;
}

export interface BrowserTabOpenResult {
  tabId: number;
  url: string;
}

export interface BrowserTabCloseParams {
  tabId: number;
}

export interface BrowserTabSwitchParams {
  tabId: number;
}

export interface BrowserTabDuplicateParams {
  tabId: number;
}

export interface BrowserTabDuplicateResult {
  tabId: number;
}

export interface BrowserTabMoveParams {
  tabId: number;
  index: number;
  windowId?: number;
}

// ─── Window Management ───────────────────────────────────────────────────────

export interface WindowInfo {
  id: number;
  focused: boolean;
  tabs: number;
  type: string;
  state: string;
}

export interface BrowserWindowsListResult {
  windows: WindowInfo[];
}

export interface BrowserWindowOpenParams {
  url?: string;
  incognito?: boolean;
  width?: number;
  height?: number;
}

export interface BrowserWindowOpenResult {
  windowId: number;
}

export interface BrowserWindowCloseParams {
  windowId: number;
}

export interface BrowserWindowResizeParams {
  windowId: number;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

// ─── Screenshots & Visual ────────────────────────────────────────────────────

export interface BrowserScreenshotParams {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  selector?: string;
  tabId?: number;
}

export interface BrowserScreenshotResult {
  image: string;
  width: number;
  height: number;
}

export interface BrowserPdfParams {
  tabId?: number;
}

export interface BrowserPdfResult {
  data: string;
}

// ─── Cookies & Storage ───────────────────────────────────────────────────────

export interface BrowserCookiesGetParams {
  domain: string;
  name?: string;
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface BrowserCookiesGetResult {
  cookies: CookieInfo[];
}

export interface BrowserCookiesSetParams {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface BrowserCookiesRemoveParams {
  url: string;
  name: string;
}

export interface BrowserStorageGetParams {
  type: 'local' | 'session';
  keys?: string[];
  tabId?: number;
}

export interface BrowserStorageGetResult {
  data: Record<string, string>;
}

export interface BrowserStorageSetParams {
  type: 'local' | 'session';
  data: Record<string, string>;
  tabId?: number;
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

export interface BrowserClipboardReadResult {
  text: string;
}

export interface BrowserClipboardWriteParams {
  text: string;
}

// ─── Downloads ───────────────────────────────────────────────────────────────

export interface BrowserDownloadParams {
  url: string;
  filename?: string;
}

export interface BrowserDownloadResult {
  downloadId: number;
}

// ─── JavaScript Execution ────────────────────────────────────────────────────

export interface BrowserExecuteJsParams {
  code: string;
  tabId?: number;
  world?: 'ISOLATED' | 'MAIN';
}

export interface BrowserExecuteJsResult {
  result: unknown;
}

// ─── Wait & Polling ──────────────────────────────────────────────────────────

/**
 * Generic wait. Accepts the loose shapes agent models actually produce
 * (observed in the wild: `{type: 'selector', selector, timeout_ms}` —
 * the schema of the playwright twin tool). `type` is inferred when
 * omitted: a selector means "wait for element", nothing means "sleep".
 */
export interface BrowserWaitParams {
  type?: 'selector' | 'navigation' | 'network_idle' | 'timeout';
  selector?: string;
  /** Sleep duration for plain waits. */
  ms?: number;
  /** Max wait time — accepted under either name. */
  timeout_ms?: number;
  timeout?: number;
  visible?: boolean;
  tabId?: number;
}

export interface BrowserWaitSleepResult {
  waited: number;
}

export interface BrowserWaitForParams {
  selector: string;
  timeout?: number;
  visible?: boolean;
  tabId?: number;
}

export interface BrowserWaitForResult {
  found: boolean;
  elapsed: number;
}

export interface BrowserWaitForNavigationParams {
  timeout?: number;
  tabId?: number;
}

export interface BrowserWaitForNavigationResult {
  url: string;
  title: string;
}

export interface BrowserWaitForNetworkIdleParams {
  timeout?: number;
  idleTime?: number;
  tabId?: number;
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface BrowserNotifyParams {
  title: string;
  message: string;
  iconUrl?: string;
}

export interface BrowserNotifyResult {
  notificationId: string;
}

// ─── Debugger Mode ──────────────────────────────────────────────────────────

export interface DebuggerAttachParams {
  tabId: number;
}

export interface DebuggerAttachResult {
  success: boolean;
  tabId: number;
}

export interface DebuggerDetachResult {
  success: boolean;
}

export interface DebuggerStatusResult {
  attached: boolean;
  tabId: number | null;
}

// ─── Mouse Move ─────────────────────────────────────────────────────────────

export interface BrowserMouseMoveParams {
  x: number;
  y: number;
  tabId?: number;
}

export interface BrowserMouseMoveResult {
  success: boolean;
}

// ─── Mouse Interaction ──────────────────────────────────────────────────────

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Coordinate- or selector-targeted. Provide `selector` (resolved to the
 * element's center, scrolled into view) OR explicit `x`/`y` viewport pixels.
 */
export interface BrowserMouseClickParams {
  x?: number;
  y?: number;
  selector?: string;
  button?: MouseButton;
  /** Double-click instead of single. */
  double?: boolean;
  tabId?: number;
}

export interface BrowserMouseButtonParams {
  x?: number;
  y?: number;
  selector?: string;
  button?: MouseButton;
  tabId?: number;
}

export interface BrowserMouseDragParams {
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  sourceSelector?: string;
  targetSelector?: string;
  tabId?: number;
}

export interface BrowserMouseActionResult {
  success: boolean;
  x: number;
  y: number;
  /** true when dispatched as trusted CDP input (debugger attached). */
  trusted: boolean;
}

// ─── Coordinate ↔ DOM Bridging ──────────────────────────────────────────────

export interface BrowserElementFromPointParams {
  x: number;
  y: number;
  tabId?: number;
}

export interface BrowserElementFromPointResult {
  found: boolean;
  tag?: string;
  text?: string;
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface BrowserInteractiveElementsParams {
  selector?: string;
  limit?: number;
  tabId?: number;
}

export interface InteractiveElementInfo {
  tag: string;
  text: string;
  role: string;
  center: { x: number; y: number };
  rect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
}

export interface BrowserInteractiveElementsResult {
  elements: InteractiveElementInfo[];
}

// ─── Humanize ───────────────────────────────────────────────────────────────

export type HumanizeIntensity = 'light' | 'moderate' | 'heavy';

export interface HumanizeParams {
  intensity?: HumanizeIntensity;
  tabId?: number;
}

export interface HumanizeResult {
  action: string;
  duration_ms: number;
}
