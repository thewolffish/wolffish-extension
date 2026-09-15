import { log, RING_BUFFER_SIZE, STORAGE_KEY_CDP_TABS, STORAGE_KEY_SNAPSHOT_PREFIX } from '@extension/shared';
import type { ConsoleMessageEntry, ConsoleMessageType, EmulationState, PageInfo } from '@extension/shared';

const api = globalThis.chrome;

// ─── Types ───────────────────────────────────────────────────────────────────

interface UidRef {
  backendNodeId: number;
  loaderId: string;
  frameId?: string;
}

/** What handleCDPFind scores against: the kept nodes of the latest snapshot. */
interface SnapshotNode {
  uid: string;
  role: string;
  name: string;
  tag: string;
  backendNodeId: number;
  id: string;
  ariaLabel: string;
}

interface DialogState {
  type: string;
  message: string;
  defaultPrompt: string;
  url: string;
}

interface NetworkEntry {
  reqid: number;
  requestId: string;
  /** The document this request belongs to — lets a navigation keep its own document request. */
  loaderId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  type: string;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  mimeType: string;
  size: number | null;
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
  fromCache: boolean;
  hasResponse: boolean;
}

interface Session {
  tabId: number;
  attachedAt: number;
  /** Main-frame loader id — changes on every navigation, which invalidates every uid. */
  loaderId: string;
  snapshotId: number;
  hasSnapshot: boolean;
  uidMap: Map<string, UidRef>;
  /** Reverse of uidMap keyed `${loaderId}:${backendNodeId}` so a re-snapshot keeps old uids. */
  uidByNode: Map<string, string>;
  snapshotNodes: SnapshotNode[];
  dialog: DialogState | null;
  network: NetworkEntry[];
  networkById: Map<string, NetworkEntry>;
  console: ConsoleMessageEntry[];
  reqSeq: number;
  msgSeq: number;
  emulation: EmulationState;
  cursor: { x: number; y: number };
}

interface DebuggerState {
  attached: boolean;
  tabId: number | null;
  tabs: number[];
}

// ─── Deterministic error phrases (the app classifies errors by text) ─────────

const restrictedPageError = (url: string): string =>
  `Cannot attach the debugger to a browser-internal page (${url}). Browser settings pages are outside the extension's reach; use computer use for those.`;

const ANOTHER_DEBUGGER_ERROR =
  'Cannot attach debugger: DevTools or another debugger is already attached to this tab. Close DevTools on that tab and retry.';

const notAttachedError = (tabId: number): string => `Debugger not attached to tab ${tabId}`;

const needsDebuggerError = (what: string): string => `${what} needs the debugger. Call ext_debugger_attach first.`;

// ─── Session registry ────────────────────────────────────────────────────────

const sessions = new Map<number, Session>();

const DOMAINS = ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.enable', 'Accessibility.enable'];

const sendCDP = (tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  api.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;

const stateArea = (): chrome.storage.StorageArea => api.storage.session ?? api.storage.local;

/** Attached tab ids live in storage.session so a restarted worker can rebuild the map. */
const persistTabs = async (): Promise<void> => {
  try {
    await stateArea().set({ [STORAGE_KEY_CDP_TABS]: [...sessions.keys()] });
  } catch {
    // Best effort: losing the mirror costs a re-attach, never a failed command.
  }
};

const snapshotCounterKey = (tabId: number): string => `${STORAGE_KEY_SNAPSHOT_PREFIX}${tabId}`;

const readSnapshotCounter = async (tabId: number): Promise<number> => {
  try {
    const bag = await stateArea().get(snapshotCounterKey(tabId));
    const value = bag?.[snapshotCounterKey(tabId)];
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
};

/** Bump the per-tab snapshot counter; it survives service-worker death, so uids never repeat. */
const nextSnapshotId = async (session: Session): Promise<number> => {
  const stored = await readSnapshotCounter(session.tabId);
  const next = Math.max(stored, session.snapshotId) + 1;
  session.snapshotId = next;
  try {
    await stateArea().set({ [snapshotCounterKey(session.tabId)]: next });
  } catch {
    // See persistTabs.
  }
  return next;
};

const createSession = (tabId: number): Session => ({
  tabId,
  attachedAt: Date.now(),
  loaderId: '',
  snapshotId: 0,
  hasSnapshot: false,
  uidMap: new Map(),
  uidByNode: new Map(),
  snapshotNodes: [],
  dialog: null,
  network: [],
  networkById: new Map(),
  console: [],
  reqSeq: 0,
  msgSeq: 0,
  emulation: {},
  cursor: { x: 0, y: 0 },
});

const enableDomains = async (tabId: number): Promise<void> => {
  for (const method of DOMAINS) await sendCDP(tabId, method);
};

const currentLoaderId = async (tabId: number): Promise<string> => {
  try {
    const tree = (await sendCDP(tabId, 'Page.getFrameTree')) as { frameTree?: { frame?: { loaderId?: string } } };
    return tree.frameTree?.frame?.loaderId ?? '';
  } catch {
    return '';
  }
};

const isRestrictedUrl = (url: string): boolean => {
  if (!url) return false;
  if (url === 'about:blank') return false;
  const prefixes = ['chrome://', 'chrome-extension://', 'devtools://', 'edge://', 'brave://', 'about:'];
  if (prefixes.some(p => url.startsWith(p))) return true;
  return url.startsWith('https://chromewebstore.google.com/');
};

const attachError = (err: unknown, url: string): Error => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Another debugger')) return new Error(ANOTHER_DEBUGGER_ERROR);
  if (message.includes('Cannot access') || message.includes('chrome://') || message.includes('chrome-extension://')) {
    return new Error(restrictedPageError(url || 'unknown url'));
  }
  return new Error(`Failed to attach debugger: ${message}`);
};

const getSession = (tabId: number): Session | undefined => sessions.get(tabId);

const hasSession = (tabId: number): boolean => sessions.has(tabId);

/** The session for a tab, or the fallthrough error the dispatcher keys on. */
const requireSession = (tabId: number): Session => {
  const session = sessions.get(tabId);
  if (!session) throw new Error(notAttachedError(tabId));
  return session;
};

const attachTab = async (tabId: number): Promise<Session> => {
  const existing = sessions.get(tabId);
  if (existing) return existing;

  const tab = await api.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? tab?.pendingUrl ?? '';
  if (isRestrictedUrl(url)) throw new Error(restrictedPageError(url));

  try {
    await api.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    throw attachError(err, url);
  }

  const session = createSession(tabId);
  sessions.set(tabId, session);
  try {
    await enableDomains(tabId);
  } catch (err) {
    sessions.delete(tabId);
    await api.debugger.detach({ tabId }).catch(() => {});
    throw new Error(`Failed to attach debugger: ${err instanceof Error ? err.message : String(err)}`);
  }
  session.loaderId = await currentLoaderId(tabId);
  session.snapshotId = await readSnapshotCounter(tabId);
  await persistTabs();
  log(`Debugger attached to tab ${tabId}`);
  return session;
};

const dropSession = async (tabId: number): Promise<void> => {
  if (!sessions.delete(tabId)) return;
  await persistTabs();
};

/** Detach one tab, or every attached tab when no id is given. */
const detachTab = async (tabId?: number): Promise<number[]> => {
  const ids = tabId === undefined ? [...sessions.keys()] : [tabId];
  const detached: number[] = [];
  for (const id of ids) {
    if (!sessions.has(id)) continue;
    await api.debugger.detach({ tabId: id }).catch(() => {});
    sessions.delete(id);
    detached.push(id);
    log(`Debugger detached from tab ${id}`);
  }
  await persistTabs();
  return detached;
};

/**
 * Synchronous view for callers that cannot await (humanize, the dispatcher's
 * routing check). `tabId` is the first attached tab — handleDebuggerStatus
 * swaps in the resolved default tab when that one is attached.
 */
const getDebuggerState = (): DebuggerState => {
  const tabs = [...sessions.keys()];
  return { attached: tabs.length > 0, tabId: tabs[0] ?? null, tabs };
};

/** The deterministic "a dialog is open" phrase for a tab, or null when none is latched. */
const dialogOpenError = (tabId: number): string | null => {
  const dialog = sessions.get(tabId)?.dialog;
  if (!dialog) return null;
  return `A dialog is open (${dialog.type}: ${dialog.message}). Call ext_handle_dialog to accept or dismiss it first.`;
};

const assertNoDialog = (session: Session): void => {
  const error = dialogOpenError(session.tabId);
  if (error) throw new Error(error);
};

// ─── Rings ───────────────────────────────────────────────────────────────────

const pushNetwork = (session: Session, entry: NetworkEntry): void => {
  session.network.push(entry);
  session.networkById.set(entry.requestId, entry);
  while (session.network.length > RING_BUFFER_SIZE) {
    const evicted = session.network.shift();
    if (evicted && session.networkById.get(evicted.requestId) === evicted)
      session.networkById.delete(evicted.requestId);
  }
};

const pushConsole = (session: Session, entry: ConsoleMessageEntry): void => {
  session.console.push(entry);
  while (session.console.length > RING_BUFFER_SIZE) session.console.shift();
};

/**
 * A new document: every uid and message belonged to the old one.
 *
 * Network is the exception. `Page.frameNavigated` arrives AFTER the document
 * request has already been recorded, so clearing everything threw away the
 * very request that caused the navigation — and on a page with no
 * subresources (example.com) that left the list permanently empty. Keep the
 * rows that belong to the incoming document and drop the rest.
 */
const resetForNavigation = (session: Session, loaderId: string): void => {
  session.loaderId = loaderId;
  session.uidMap.clear();
  session.uidByNode.clear();
  session.snapshotNodes = [];
  session.network = session.network.filter(e => e.loaderId === loaderId);
  session.networkById.clear();
  for (const entry of session.network) session.networkById.set(entry.requestId, entry);
  session.console = [];
  session.dialog = null;
};

const paginate = <T>(
  items: T[],
  pageSize?: number,
  pageIdx?: number,
): { items: T[]; total: number; page: PageInfo } => {
  const total = items.length;
  if (!pageSize || pageSize <= 0) return { items, total, page: { index: 0, size: total, pages: 1 } };
  const size = Math.floor(pageSize);
  const pages = Math.max(1, Math.ceil(total / size));
  const index = Math.min(Math.max(0, Math.floor(pageIdx ?? 0)), pages - 1);
  return { items: items.slice(index * size, (index + 1) * size), total, page: { index, size, pages } };
};

// ─── Event routing ───────────────────────────────────────────────────────────

interface RemoteObjectLike {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

interface StackTraceLike {
  callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[];
}

const remoteText = (o: RemoteObjectLike): string => {
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  if (o.type === 'string') return String(o.value ?? '');
  if (o.value !== undefined) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  return o.description ?? o.type;
};

const formatStack = (stack?: StackTraceLike): string | undefined => {
  const frames = stack?.callFrames ?? [];
  if (frames.length === 0) return undefined;
  return frames
    .map(
      f =>
        `    at ${f.functionName || '<anonymous>'} (${f.url ?? ''}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`,
    )
    .join('\n');
};

const CONSOLE_TYPE_MAP: Record<string, ConsoleMessageType> = {
  log: 'log',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  verbose: 'debug',
  trace: 'trace',
  assert: 'assert',
  dir: 'dir',
  dirxml: 'dir',
  table: 'table',
};

const consoleType = (raw: string): ConsoleMessageType => CONSOLE_TYPE_MAP[raw] ?? 'other';

const onConsoleApiCalled = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { type: string; args?: RemoteObjectLike[]; timestamp: number; stackTrace?: StackTraceLike };
  const top = e.stackTrace?.callFrames?.[0];
  pushConsole(session, {
    msgid: ++session.msgSeq,
    type: consoleType(e.type),
    text: (e.args ?? []).map(remoteText).join(' '),
    timestamp: e.timestamp,
    url: top?.url || undefined,
    line: top ? (top.lineNumber ?? 0) + 1 : undefined,
    column: top ? (top.columnNumber ?? 0) + 1 : undefined,
    stack: formatStack(e.stackTrace),
  });
};

const onExceptionThrown = (session: Session, p: Record<string, unknown>): void => {
  const e = p as {
    timestamp: number;
    exceptionDetails: {
      text: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
      exception?: RemoteObjectLike;
      stackTrace?: StackTraceLike;
    };
  };
  const d = e.exceptionDetails;
  const text = d.exception?.description ?? (d.exception ? remoteText(d.exception) : d.text);
  pushConsole(session, {
    msgid: ++session.msgSeq,
    type: 'exception',
    text,
    timestamp: e.timestamp,
    url: d.url,
    line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined,
    column: d.columnNumber !== undefined ? d.columnNumber + 1 : undefined,
    stack: formatStack(d.stackTrace),
  });
};

const onLogEntry = (session: Session, p: Record<string, unknown>): void => {
  const e = p as {
    entry: {
      source: string;
      level: string;
      text: string;
      timestamp: number;
      url?: string;
      lineNumber?: number;
      stackTrace?: StackTraceLike;
    };
  };
  const entry = e.entry;
  pushConsole(session, {
    msgid: ++session.msgSeq,
    type: consoleType(entry.level),
    text: entry.source && entry.source !== 'javascript' ? `[${entry.source}] ${entry.text}` : entry.text,
    timestamp: entry.timestamp,
    url: entry.url,
    line: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined,
    stack: formatStack(entry.stackTrace),
  });
};

const onRequestWillBeSent = (session: Session, p: Record<string, unknown>): void => {
  const e = p as {
    requestId: string;
    loaderId?: string;
    request: { url: string; method: string; headers: Record<string, string>; postData?: string };
    timestamp: number;
    type?: string;
    redirectResponse?: { status: number; statusText: string; headers: Record<string, string>; mimeType: string };
  };
  // A redirect reuses the request id: close the hop we have, open a fresh row for the new URL.
  const prev = session.networkById.get(e.requestId);
  if (prev && e.redirectResponse) {
    prev.status = e.redirectResponse.status;
    prev.statusText = e.redirectResponse.statusText;
    prev.responseHeaders = e.redirectResponse.headers ?? {};
    prev.mimeType = e.redirectResponse.mimeType ?? '';
    prev.hasResponse = true;
    prev.endedAt = e.timestamp;
  }
  pushNetwork(session, {
    reqid: ++session.reqSeq,
    requestId: e.requestId,
    loaderId: e.loaderId ?? '',
    method: e.request.method,
    url: e.request.url,
    headers: e.request.headers ?? {},
    postData: e.request.postData,
    type: (e.type ?? 'Other').toLowerCase(),
    status: null,
    statusText: '',
    responseHeaders: {},
    mimeType: '',
    size: null,
    startedAt: e.timestamp,
    endedAt: null,
    failed: false,
    fromCache: false,
    hasResponse: false,
  });
};

const onResponseReceived = (session: Session, p: Record<string, unknown>): void => {
  const e = p as {
    requestId: string;
    type?: string;
    response: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      mimeType: string;
      fromDiskCache?: boolean;
      fromServiceWorker?: boolean;
      encodedDataLength?: number;
    };
  };
  const entry = session.networkById.get(e.requestId);
  if (!entry) return;
  entry.status = e.response.status;
  entry.statusText = e.response.statusText ?? '';
  entry.responseHeaders = e.response.headers ?? {};
  entry.mimeType = e.response.mimeType ?? '';
  entry.hasResponse = true;
  if (e.type) entry.type = e.type.toLowerCase();
  if (e.response.fromDiskCache) entry.fromCache = true;
};

const onLoadingFinished = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { requestId: string; timestamp: number; encodedDataLength?: number };
  const entry = session.networkById.get(e.requestId);
  if (!entry) return;
  entry.endedAt = e.timestamp;
  entry.size = e.encodedDataLength ?? null;
};

const onLoadingFailed = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { requestId: string; timestamp: number; errorText?: string };
  const entry = session.networkById.get(e.requestId);
  if (!entry) return;
  entry.endedAt = e.timestamp;
  entry.failed = true;
  if (e.errorText && !entry.statusText) entry.statusText = e.errorText;
};

const onServedFromCache = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { requestId: string };
  const entry = session.networkById.get(e.requestId);
  if (entry) entry.fromCache = true;
};

const onFrameNavigated = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { frame: { id: string; parentId?: string; loaderId: string; url: string } };
  if (e.frame.parentId) return;
  resetForNavigation(session, e.frame.loaderId);
};

const onDialogOpening = (session: Session, p: Record<string, unknown>): void => {
  const e = p as { url: string; message: string; type: string; defaultPrompt?: string };
  session.dialog = { type: e.type, message: e.message, defaultPrompt: e.defaultPrompt ?? '', url: e.url };
};

const EVENT_HANDLERS: Record<string, (session: Session, params: Record<string, unknown>) => void> = {
  'Page.javascriptDialogOpening': onDialogOpening,
  'Page.javascriptDialogClosed': session => {
    session.dialog = null;
  },
  'Page.frameNavigated': onFrameNavigated,
  'Network.requestWillBeSent': onRequestWillBeSent,
  'Network.responseReceived': onResponseReceived,
  'Network.loadingFinished': onLoadingFinished,
  'Network.loadingFailed': onLoadingFailed,
  'Network.requestServedFromCache': onServedFromCache,
  'Runtime.consoleAPICalled': onConsoleApiCalled,
  'Runtime.exceptionThrown': onExceptionThrown,
  'Log.entryAdded': onLogEntry,
};

// One global listener; events route to the session of the tab they came from.
api.debugger.onEvent.addListener((source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
  if (source.tabId === undefined) return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  const handler = EVENT_HANDLERS[method];
  if (handler) handler(session, (params ?? {}) as Record<string, unknown>);
});

api.debugger.onDetach.addListener((source: chrome.debugger.Debuggee, reason: string) => {
  if (source.tabId === undefined || !sessions.has(source.tabId)) return;
  log(`Debugger detached from tab ${source.tabId}: ${reason}`);
  void dropSession(source.tabId);
});

api.tabs.onRemoved.addListener((tabId: number) => {
  if (!sessions.has(tabId)) return;
  log(`Attached tab ${tabId} was closed`);
  void dropSession(tabId);
});

// ─── Restore after service-worker restart ────────────────────────────────────

/**
 * The debugger attachment outlives the worker; the map does not. Rebuild it
 * from the storage mirror, trusting only tabs Chrome still reports attached.
 */
const restoreSessions = async (): Promise<void> => {
  try {
    const bag = await stateArea().get(STORAGE_KEY_CDP_TABS);
    const stored = (bag?.[STORAGE_KEY_CDP_TABS] as number[] | undefined) ?? [];
    if (stored.length === 0) return;
    const targets = await api.debugger.getTargets();
    const live = new Set(targets.filter(t => t.attached && typeof t.tabId === 'number').map(t => t.tabId as number));
    for (const tabId of stored) {
      if (!live.has(tabId) || sessions.has(tabId)) continue;
      const session = createSession(tabId);
      sessions.set(tabId, session);
      try {
        await enableDomains(tabId);
        session.loaderId = await currentLoaderId(tabId);
        session.snapshotId = await readSnapshotCounter(tabId);
        log(`Debugger session restored for tab ${tabId}`);
      } catch {
        sessions.delete(tabId);
      }
    }
  } catch (err) {
    log('Debugger session restore failed:', err instanceof Error ? err.message : String(err));
  } finally {
    await persistTabs();
  }
};

/** Resolves once the restore pass has run; handlers await it so the first command after a restart sees its session. */
const sessionsReady: Promise<void> = restoreSessions();

export type { Session, SnapshotNode, NetworkEntry, UidRef, DialogState, DebuggerState };

export {
  ANOTHER_DEBUGGER_ERROR,
  assertNoDialog,
  attachTab,
  detachTab,
  dialogOpenError,
  getDebuggerState,
  getSession,
  hasSession,
  isRestrictedUrl,
  needsDebuggerError,
  nextSnapshotId,
  notAttachedError,
  paginate,
  requireSession,
  restrictedPageError,
  sendCDP,
  sessionsReady,
};
