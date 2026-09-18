import type { ConnectionStatus } from './constants.js';

// ─── Wire Protocol ───────────────────────────────────────────────────────────

export interface WolffishCommand {
  id: string;
  type: string;
  params: Record<string, unknown>;
  /**
   * Which Wolffish conversation sent this command. Each one drives its own tab
   * group, so two jobs running at once — or one right after another — never
   * inherit each other's tab or each other's group title. Absent from an older
   * desktop build, which then shares the single default workspace.
   */
  session?: string;
}

/**
 * What `resolveTabId` needs out of a command's params. `__wfSession` is not a
 * tool argument: the dispatcher stamps the command's session onto params so
 * every existing `resolveTabId(params)` call site resolves against the right
 * workspace without threading a second argument through all of them.
 */
export interface TabTarget {
  tabId?: number;
  __wfSession?: string;
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

export type InternalMessageSource = 'service-worker' | 'content-script' | 'popup' | 'side-panel';

export interface InternalMessage {
  source: InternalMessageSource;
  target: InternalMessageSource;
  payload: WolffishCommand | WolffishResponse | WolffishEvent | ConnectionStatusPayload | PingPayload | OverlayPayload;
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
  /** Open a fresh tab in the Wolffish group instead of reusing the current one. */
  newTab?: boolean;
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
  /** Tab-group id, or -1 when ungrouped. */
  groupId?: number;
  /** True for tabs Wolffish opened and owns; the rest belong to the user. */
  wolffish?: boolean;
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
  /** The window's first tab. It sits outside the Wolffish group, so commands must name it. */
  tabId?: number;
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

// ─── Wolffish Tab Group ─────────────────────────────────────────────────────

export interface BrowserSetActivityParams {
  emoji?: string;
  text?: string;
}

export interface BrowserSetActivityResult {
  /** The title now shown on the Wolffish tab group. */
  title: string;
  /** False when the group does not exist yet — the title applies on creation. */
  applied: boolean;
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

// ─── v2: uid element references & snapshot ───────────────────────────────────

/** A stable per-snapshot element reference: `${snapshotId}_${n}`. */
export type ElementUid = string;

export interface BrowserTakeSnapshotParams {
  verbose?: boolean;
  tabId?: number;
}

export interface BrowserTakeSnapshotResult {
  snapshot: string;
  url: string;
  title: string;
  nodeCount: number;
  source: 'cdp' | 'dom';
  snapshotId: number;
}

export interface BrowserResolveUidParams {
  uid: ElementUid;
  tabId?: number;
}

export interface BrowserResolveUidResult {
  found: boolean;
  center?: { x: number; y: number };
  rect?: { x: number; y: number; width: number; height: number };
  tag?: string;
  role?: string;
  name?: string;
}

/** Element targeting shared by every uid-aware command: uid wins over selector. */
export interface ElementTarget {
  uid?: ElementUid;
  selector?: string;
}

export interface BrowserFindParams {
  query: string;
  limit?: number;
  tabId?: number;
}

export interface FoundElement {
  uid: ElementUid;
  tag: string;
  role: string;
  text: string;
  score: number;
  center: { x: number; y: number };
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserFindResult {
  elements: FoundElement[];
  snapshotId: number;
}

export type FillKind = 'input' | 'textarea' | 'contenteditable' | 'select' | 'checkbox' | 'radio';

export interface BrowserFillParams extends ElementTarget {
  value: string;
  tabId?: number;
}

export interface BrowserFillResult {
  success: boolean;
  value: string;
  kind: FillKind;
}

export interface BrowserFillFormParams {
  elements: Array<ElementTarget & { value: string }>;
  tabId?: number;
}

export interface BrowserFillFormResult {
  success: boolean;
  filled: number;
  failures: Array<{ ref: string; error: string }>;
}

/** Decorations added to every input command's result by the post-action wait. */
export interface ActionAftermath {
  navigated?: { url: string; title: string };
  domChanged?: boolean;
}

// ─── v2: network / console / dialogs / emulation ─────────────────────────────

export interface BrowserListNetworkRequestsParams {
  pageSize?: number;
  pageIdx?: number;
  resourceTypes?: string[];
  tabId?: number;
}

export interface NetworkRequestSummary {
  reqid: number;
  method: string;
  url: string;
  status: number | null;
  type: string;
  mimeType: string;
  size: number | null;
  durationMs: number | null;
  failed: boolean;
  fromCache: boolean;
}

export interface PageInfo {
  index: number;
  size: number;
  pages: number;
}

export interface BrowserListNetworkRequestsResult {
  requests: NetworkRequestSummary[];
  total: number;
  page: PageInfo;
}

export interface BrowserGetNetworkRequestParams {
  reqid: number;
  includeBody?: boolean;
  tabId?: number;
}

export interface BrowserGetNetworkRequestResult {
  request: { method: string; url: string; headers: Record<string, string>; postData?: string };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    body?: string;
    base64Encoded?: boolean;
    bodyTruncated?: boolean;
  } | null;
}

export type ConsoleMessageType =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'exception'
  | 'trace'
  | 'assert'
  | 'dir'
  | 'table'
  | 'other';

export interface BrowserListConsoleMessagesParams {
  pageSize?: number;
  pageIdx?: number;
  types?: ConsoleMessageType[];
  includeStackTraces?: boolean;
  tabId?: number;
}

export interface ConsoleMessageEntry {
  msgid: number;
  type: ConsoleMessageType;
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface BrowserListConsoleMessagesResult {
  messages: ConsoleMessageEntry[];
  total: number;
  page: PageInfo;
}

export interface BrowserHandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  tabId?: number;
}

export interface BrowserHandleDialogResult {
  success: boolean;
  handled: { type: string; message: string } | null;
}

export type NetworkConditionName = 'Offline' | 'Slow 3G' | 'Fast 3G' | 'Slow 4G' | 'Fast 4G' | 'none';

export interface EmulationState {
  viewport?: string;
  userAgent?: string;
  colorScheme?: 'dark' | 'light' | 'auto';
  geolocation?: string;
  networkConditions?: NetworkConditionName;
  cpuThrottlingRate?: number;
}

export interface BrowserEmulateParams extends EmulationState {
  tabId?: number;
}

export interface BrowserEmulateResult {
  success: boolean;
  state: EmulationState;
}

// ─── v2: changed commands ────────────────────────────────────────────────────

export interface BrowserScreenshotParamsV2 extends BrowserScreenshotParams {
  uid?: ElementUid;
}

export interface BrowserScreenshotResultV2 extends BrowserScreenshotResult {
  /** CSS-pixel viewport (or clip) size; coordinates for mouse tools live here. */
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  mode: 'cdp' | 'visible';
}

export interface BrowserFileUploadParamsV2 extends ElementTarget {
  files?: { name: string; content: string; mimeType: string }[];
  filePaths?: string[];
  tabId?: number;
}

export interface BrowserFileUploadResult {
  success: boolean;
  count: number;
  via: 'paths' | 'data';
}

export interface BrowserDownloadParamsV2 extends BrowserDownloadParams {
  waitMs?: number;
}

export interface BrowserDownloadResultV2 extends BrowserDownloadResult {
  state: 'complete' | 'interrupted' | 'in_progress';
  filename?: string;
  error?: string;
}

export interface BrowserExecuteJsParamsV2 extends BrowserExecuteJsParams {
  /** uids resolved to live element handles and passed positionally (CDP only). */
  args?: ElementUid[];
}

export interface BrowserWaitForParamsV2 extends Omit<BrowserWaitForParams, 'selector'> {
  selector?: string;
  /** Resolves when ANY entry appears in the page's visible text. */
  text?: string[];
}

export interface BrowserWaitForResultV2 extends BrowserWaitForResult {
  matched?: string;
}

export interface BrowserMouseDragParamsV2 extends BrowserMouseDragParams {
  from_uid?: ElementUid;
  to_uid?: ElementUid;
}

export interface DebuggerDetachParams {
  tabId?: number;
}

export interface DebuggerStatusResultV2 extends DebuggerStatusResult {
  tabs: number[];
}

// ─── v2: readiness probe ─────────────────────────────────────────────────────

export interface BrowserDoctorParams {
  tabId?: number;
}

export interface BrowserDoctorResult {
  extension: { id: string; version: string; manifestPermissions: string[]; hostPermissions: string[] };
  siteAccessAllUrls: boolean | null;
  incognitoAllowed: boolean | null;
  fileSchemeAllowed: boolean | null;
  notifications: 'granted' | 'denied' | null;
  installType: string | null;
  enabled: boolean | null;
  mayDisable: boolean | null;
  apis: { debugger: boolean; tabGroups: boolean; sidePanel: boolean; scripting: boolean; downloads: boolean };
  debuggerAttachedTabs: number[];
  scriptable: { tabId: number; ok: boolean; error?: string; url?: string } | null;
  policyBlocked: boolean;
  overlayEnabled: boolean;
}

// ─── v2: overlay (service worker → content script) ───────────────────────────

export type OverlayOp = 'pill' | 'cursor' | 'pulse' | 'target' | 'hide' | 'capture_hide' | 'capture_show';

export interface OverlayPayload {
  type: 'overlay';
  op: OverlayOp;
  mode?: 'working' | 'reading';
  text?: string;
  x?: number;
  y?: number;
  kind?: 'pointer' | 'keyboard' | 'approximate';
  label?: string;
  animate?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

/** Server → extension event that flips the overlay switch. */
export interface OverlayConfigEvent {
  enabled: boolean;
}
