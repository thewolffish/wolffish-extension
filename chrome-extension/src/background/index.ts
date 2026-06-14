import 'webextension-polyfill';
import {
  COMMAND_TIMEOUT_MS,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  WolffishCommands,
  CONTENT_SCRIPT_COMMANDS,
  SERVICE_WORKER_COMMANDS,
  DEBUGGER_ROUTABLE_COMMANDS,
  log,
  logError,
  sendToContentScript,
  ensureContentScriptInjected,
  resolveTabId,
  withTimeout,
  makeResponse,
  makeErrorResponse,
  generateId,
  isFirefox,
} from '@extension/shared';
import { wolffishConnectionStorage } from '@extension/storage';
import type {
  WolffishCommand,
  WolffishResponse,
  ConnectionStatusResponse,
  BrowserNavigateParams,
  BrowserNavigateResult,
  BrowserBackParams,
  BrowserForwardParams,
  BrowserReloadParams,
  BrowserTabsListParams,
  BrowserTabsListResult,
  BrowserTabOpenParams,
  BrowserTabOpenResult,
  BrowserTabCloseParams,
  BrowserTabSwitchParams,
  BrowserTabDuplicateParams,
  BrowserTabDuplicateResult,
  BrowserTabMoveParams,
  BrowserWindowsListResult,
  BrowserWindowOpenParams,
  BrowserWindowOpenResult,
  BrowserWindowCloseParams,
  BrowserWindowResizeParams,
  BrowserScreenshotParams,
  BrowserScreenshotResult,
  BrowserPdfParams,
  BrowserPdfResult,
  BrowserCookiesGetParams,
  BrowserCookiesGetResult,
  BrowserCookiesSetParams,
  BrowserCookiesRemoveParams,
  BrowserDownloadParams,
  BrowserDownloadResult,
  BrowserExecuteJsParams,
  BrowserExecuteJsResult,
  BrowserWaitParams,
  BrowserWaitForNavigationParams,
  BrowserWaitForNavigationResult,
  BrowserNotifyParams,
  BrowserNotifyResult,
  BrowserGetUrlParams,
  BrowserGetUrlResult,
  ConnectionStatus,
} from '@extension/shared';
import {
  handleDebuggerAttach,
  handleDebuggerDetach,
  handleDebuggerStatus,
  handleCDPClick,
  handleCDPType,
  handleCDPScroll,
  handleCDPHover,
  handleCDPKeypress,
  handleMouseMove,
  handleMouseClick,
  handleMouseDown,
  handleMouseUp,
  handleMouseDrag,
  getDebuggerState,
} from './debugger.js';
import { handleHumanize } from './humanize-actions.js';

const api = globalThis.chrome;

let connectionStatus: ConnectionStatus = 'disconnected';
let connectionPort = DEFAULT_PORT;

// ─── WebSocket Connection (direct in service worker) ────────────────────────

const RECONNECT_ALARM = 'wolffish-reconnect';

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const stopHeartbeat = (): void => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const startHeartbeat = (): void => {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
};

const setStatus = (status: ConnectionStatus): void => {
  connectionStatus = status;
  log(`Connection status: ${status}`);
  api.runtime.sendMessage({ type: 'status_update', status, port: connectionPort }).catch(() => {});
};

const scheduleReconnect = (): void => {
  api.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.05 });
};

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM && connectionStatus !== 'connected') {
    connectWebSocket(connectionPort);
  }
});

const connectWebSocket = async (port: number): Promise<void> => {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  connectionPort = port;

  // Probe first — avoid Chrome's ERR_CONNECTION_REFUSED console error
  try {
    await fetch(`http://localhost:${port}`, { mode: 'no-cors' });
  } catch {
    setStatus('disconnected');
    scheduleReconnect();
    return;
  }

  setStatus('connecting');
  log(`Connecting to ws://localhost:${port}`);

  ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => {
    setStatus('connected');
    api.alarms.clear(RECONNECT_ALARM);
    startHeartbeat();
    log('Connected');

    const manifest = api.runtime.getManifest();
    sendToServer({ type: 'extension_info', version: manifest.version });
    sendToServer({ type: 'get_conversations' });
  };

  ws.onclose = () => {
    setStatus('disconnected');
    stopHeartbeat();
    log('Disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    log('WebSocket error');
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string);

      // Pong from server — no action needed
      if (data.type === 'pong') return;

      // Events from the Wolffish app (events_sync, event_logged, extension_reload)
      if (data.type === 'event') {
        handleWolffishEvent(data);
        return;
      }

      // Command from the Wolffish app — execute it
      if (data.id && data.type) {
        handleCommand(data as WolffishCommand);
        return;
      }
    } catch (err) {
      logError('Failed to parse WebSocket message', err);
    }
  };
};

const sendToServer = (data: unknown): void => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

// ─── Navigation Handlers ────────────────────────────────────────────────────

/**
 * Wait until a *fresh* navigation in this tab finishes and report the tab's
 * settled state. `chrome.tabs.update` resolves the instant a navigation is
 * initiated, so reading the tab back immediately returns the PREVIOUS page —
 * an off-by-one that makes every navigate result lag one step (observed live:
 * navigating to a Reddit post reported the prior claude.ai page, which then
 * made the agent re-navigate two more times chasing a target the tool kept
 * misreporting). Waiting only for the first `webNavigation.onCompleted` is
 * also unreliable on redirect chains (e.g. Reddit old<->www while logged in),
 * where an early event can land mid-redirect.
 *
 * So we settle only once the tab has actually begun a new load — observed
 * either as a `loading` status, a URL that moved off the pre-navigation URL,
 * or an `onCompleted` for the top frame — AND then reached `status:
 * 'complete'`. This never returns the stale pre-navigation state, follows
 * redirects to the final URL, and falls back to whatever the tab settled on
 * if the timeout fires. `onCompleted` is a wake signal; a poll is the
 * backstop for fast/cached loads and SPA redirects it can miss.
 */
const waitForTabSettled = (tabId: number, beforeUrl: string, timeoutMs: number): Promise<chrome.tabs.Tab | null> =>
  new Promise(resolve => {
    let done = false;
    let navStarted = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      clearInterval(poll);
      api.webNavigation?.onCompleted?.removeListener(onCompleted);
    };
    const finish = (tab: chrome.tabs.Tab | null): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(tab);
    };

    const check = async (): Promise<void> => {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      if (tab.status === 'loading' || (tab.url && tab.url !== beforeUrl)) navStarted = true;
      if (tab.status === 'complete' && navStarted) finish(tab);
    };

    const onCompleted = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (d.tabId === tabId && d.frameId === 0) {
        navStarted = true;
        void check();
      }
    };

    api.webNavigation?.onCompleted?.addListener(onCompleted);
    const poll = setInterval(() => void check(), 100);
    const timer = setTimeout(() => {
      api.tabs
        .get(tabId)
        .then(finish)
        .catch(() => finish(null));
    }, timeoutMs);
  });

const handleNavigate = async (params: Record<string, unknown>): Promise<BrowserNavigateResult> => {
  const { url, waitUntil } = params as unknown as BrowserNavigateParams;
  const tabId = await resolveTabId(params as { tabId?: number });

  // Snapshot where the tab is *before* navigating so waitForTabSettled can
  // tell a real commit from a stale read of the page we're leaving.
  const before = await api.tabs.get(tabId).catch(() => null);
  const beforeUrl = before?.url ?? '';

  await api.tabs.update(tabId, { url });

  const settled = await waitForTabSettled(tabId, beforeUrl, COMMAND_TIMEOUT_MS);
  const tab = settled ?? (await api.tabs.get(tabId).catch(() => null));
  if (waitUntil && (!tab || tab.status !== 'complete')) {
    throw new Error(`Navigation timed out waiting for '${waitUntil}'`);
  }
  return { url: tab?.url || url, title: tab?.title || '', tabId };
};

const handleBack = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const tabId = await resolveTabId(params as BrowserBackParams);

  await api.scripting.executeScript({
    target: { tabId },
    func: () => history.back(),
  });

  return { success: true };
};

const handleForward = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const tabId = await resolveTabId(params as BrowserForwardParams);

  await api.scripting.executeScript({
    target: { tabId },
    func: () => history.forward(),
  });

  return { success: true };
};

const handleReload = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { hard } = params as unknown as BrowserReloadParams;
  const tabId = await resolveTabId(params as { tabId?: number });

  await api.tabs.reload(tabId, { bypassCache: hard ?? false });

  return { success: true };
};

// ─── Tab Management Handlers ────────────────────────────────────────────────

const handleTabsList = async (params: Record<string, unknown>): Promise<BrowserTabsListResult> => {
  const { windowId } = params as unknown as BrowserTabsListParams;
  const query = windowId !== undefined ? { windowId } : {};
  const tabs = await api.tabs.query(query);

  return {
    tabs: tabs.map(t => ({
      id: t.id!,
      url: t.url || '',
      title: t.title || '',
      active: t.active,
      pinned: t.pinned,
      windowId: t.windowId,
    })),
  };
};

const handleTabOpen = async (params: Record<string, unknown>): Promise<BrowserTabOpenResult> => {
  const { url, active } = params as unknown as BrowserTabOpenParams;
  const tab = await api.tabs.create({ url, active: active ?? true });

  return {
    tabId: tab.id!,
    url: tab.pendingUrl || tab.url || url || '',
  };
};

const handleTabClose = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { tabId } = params as unknown as BrowserTabCloseParams;
  await api.tabs.remove(tabId);

  return { success: true };
};

const handleTabSwitch = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { tabId } = params as unknown as BrowserTabSwitchParams;
  await api.tabs.update(tabId, { active: true });

  return { success: true };
};

const handleTabDuplicate = async (params: Record<string, unknown>): Promise<BrowserTabDuplicateResult> => {
  const { tabId } = params as unknown as BrowserTabDuplicateParams;
  const newTab = await api.tabs.duplicate(tabId);

  if (!newTab) {
    throw new Error(`Failed to duplicate tab ${tabId}`);
  }

  return { tabId: newTab.id! };
};

const handleTabMove = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { tabId, index, windowId } = params as unknown as BrowserTabMoveParams;
  const moveProperties: chrome.tabs.MoveProperties = { index };
  if (windowId !== undefined) {
    moveProperties.windowId = windowId;
  }

  await api.tabs.move(tabId, moveProperties);

  return { success: true };
};

// ─── Window Management Handlers ─────────────────────────────────────────────

const handleWindowsList = async (): Promise<BrowserWindowsListResult> => {
  const windows = await api.windows.getAll({ populate: true });

  return {
    windows: windows.map(w => ({
      id: w.id!,
      focused: w.focused,
      tabs: w.tabs?.length ?? 0,
      type: w.type || 'normal',
      state: w.state || 'normal',
    })),
  };
};

const handleWindowOpen = async (params: Record<string, unknown>): Promise<BrowserWindowOpenResult> => {
  const { url, incognito, width, height } = params as unknown as BrowserWindowOpenParams;
  const createData: chrome.windows.CreateData = {};

  if (url !== undefined) createData.url = url;
  if (incognito !== undefined) createData.incognito = incognito;
  if (width !== undefined) createData.width = width;
  if (height !== undefined) createData.height = height;

  const win = await api.windows.create(createData);

  return { windowId: win.id! };
};

const handleWindowClose = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { windowId } = params as unknown as BrowserWindowCloseParams;
  await api.windows.remove(windowId);

  return { success: true };
};

const handleWindowResize = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { windowId, width, height, left, top, state } = params as unknown as BrowserWindowResizeParams;
  const updateInfo: chrome.windows.UpdateInfo = {};

  if (width !== undefined) updateInfo.width = width;
  if (height !== undefined) updateInfo.height = height;
  if (left !== undefined) updateInfo.left = left;
  if (top !== undefined) updateInfo.top = top;
  if (state !== undefined) updateInfo.state = state;

  await api.windows.update(windowId, updateInfo);

  return { success: true };
};

// ─── Screenshot & PDF Handlers ──────────────────────────────────────────────

const handleScreenshot = async (params: Record<string, unknown>): Promise<BrowserScreenshotResult> => {
  const { format, quality, fullPage, selector } = params as unknown as BrowserScreenshotParams;

  if (selector || fullPage) {
    const tabId = await resolveTabId(params as { tabId?: number });
    await ensureContentScriptInjected(tabId);

    const result = await sendToContentScript(tabId, {
      source: 'service-worker',
      target: 'content-script',
      payload: {
        id: crypto.randomUUID(),
        type: WolffishCommands.BROWSER_SCREENSHOT,
        params: params,
      } as WolffishCommand,
    });

    return (result as WolffishResponse).data as BrowserScreenshotResult;
  }

  const captureFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const options: chrome.tabs.CaptureVisibleTabOptions = { format: captureFormat };
  if (captureFormat === 'jpeg' && quality !== undefined) {
    options.quality = quality;
  }

  const dataUrl = await api.tabs.captureVisibleTab(null as unknown as number, options);

  const tabId = await resolveTabId(params as { tabId?: number });
  const tab = await api.tabs.get(tabId);
  const win = await api.windows.get(tab.windowId);

  return {
    image: dataUrl,
    width: win.width || 0,
    height: win.height || 0,
  };
};

const handlePdf = async (params: Record<string, unknown>): Promise<BrowserPdfResult> => {
  if (isFirefox()) {
    throw new Error('PDF generation is not supported on Firefox');
  }

  const tabId = await resolveTabId(params as BrowserPdfParams);

  await api.debugger.attach({ tabId }, '1.3');

  try {
    const result = (await api.debugger.sendCommand({ tabId }, 'Page.printToPDF', {})) as { data: string };
    return { data: result.data };
  } finally {
    await api.debugger.detach({ tabId }).catch(() => {
      // Detach may fail if already detached
    });
  }
};

// ─── Cookie Handlers ────────────────────────────────────────────────────────

const handleCookiesGet = async (params: Record<string, unknown>): Promise<BrowserCookiesGetResult> => {
  const { domain, name } = params as unknown as BrowserCookiesGetParams;
  const query: chrome.cookies.GetAllDetails = { domain };
  if (name !== undefined) {
    query.name = name;
  }

  const cookies = await api.cookies.getAll(query);

  return {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expirationDate || -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
    })),
  };
};

const handleCookiesSet = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { url, name, value, domain, path, expires, httpOnly, secure } = params as unknown as BrowserCookiesSetParams;

  const details: chrome.cookies.SetDetails = { url, name, value };
  if (domain !== undefined) details.domain = domain;
  if (path !== undefined) details.path = path;
  if (expires !== undefined) details.expirationDate = expires;
  if (httpOnly !== undefined) details.httpOnly = httpOnly;
  if (secure !== undefined) details.secure = secure;

  await api.cookies.set(details);

  return { success: true };
};

const handleCookiesRemove = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { url, name } = params as unknown as BrowserCookiesRemoveParams;
  await api.cookies.remove({ url, name });

  return { success: true };
};

// ─── Download Handler ───────────────────────────────────────────────────────

const handleDownload = async (params: Record<string, unknown>): Promise<BrowserDownloadResult> => {
  const { url, filename } = params as unknown as BrowserDownloadParams;
  const options: chrome.downloads.DownloadOptions = { url };
  if (filename !== undefined) {
    options.filename = filename;
  }

  const downloadId = await api.downloads.download(options);

  return { downloadId };
};

// ─── JavaScript Execution Handler ───────────────────────────────────────────

const handleExecuteJs = async (params: Record<string, unknown>): Promise<BrowserExecuteJsResult> => {
  const { code, world } = params as unknown as BrowserExecuteJsParams;
  const tabId = await resolveTabId(params as { tabId?: number });

  const results = await api.scripting.executeScript({
    target: { tabId },
    func: (source: string) => eval(source),
    args: [code],
    world: (world || 'ISOLATED') as chrome.scripting.ExecutionWorld,
  });

  return { result: results[0]?.result };
};

// ─── Wait For Navigation Handler ────────────────────────────────────────────

const handleWaitForNavigation = async (params: Record<string, unknown>): Promise<BrowserWaitForNavigationResult> => {
  const { timeout } = params as unknown as BrowserWaitForNavigationParams;
  const tabId = await resolveTabId(params as { tabId?: number });
  const timeoutMs = timeout ?? COMMAND_TIMEOUT_MS;
  const startUrl = await api.tabs
    .get(tabId)
    .then(t => t.url || '')
    .catch(() => '');

  return new Promise<BrowserWaitForNavigationResult>(resolve => {
    let settled = false;
    const finish = (url: string, title: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.webNavigation.onCompleted.removeListener(navListener);
      api.tabs.onUpdated.removeListener(updateListener);
      resolve({ url, title });
    };

    const timer = setTimeout(() => {
      api.tabs
        .get(tabId)
        .then(tab => finish(tab.url || '', tab.title || ''))
        .catch(() => finish(startUrl, ''));
    }, timeoutMs);

    const navListener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (details.tabId === tabId && details.frameId === 0) {
        api.tabs
          .get(tabId)
          .then(tab => finish(tab.url || details.url, tab.title || ''))
          .catch(() => finish(details.url, ''));
      }
    };

    const updateListener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.url && info.url !== startUrl) {
        api.tabs
          .get(tabId)
          .then(tab => finish(tab.url || info.url!, tab.title || ''))
          .catch(() => finish(info.url!, ''));
      }
    };

    api.webNavigation.onCompleted.addListener(navListener);
    api.tabs.onUpdated.addListener(updateListener);
  });
};

// No cap on plain sleeps — the model decides the duration (see the
// browser-extension SKILL.md). A wait cannot be interrupted once it's in
// flight, so very long waits should be split across several ext_wait calls
// rather than done as one giant sleep. Multi-minute waits survive MV3
// service-worker idling because the WebSocket heartbeat keeps the worker
// awake. We only sanitize the argument below — a missing, negative, or
// non-finite value waits 0ms (no minimum is imposed).

/**
 * Generic wait — the name agent models guess first, mirroring the
 * playwright capability's browser_wait (observed live: a model invented
 * `ext_wait {type: 'selector', selector, timeout_ms}` and the task lost a
 * step to "unknown tool"). Dispatches on `type`, inferring it when
 * omitted: a selector means "wait for element", nothing means "sleep".
 * Selector and network-idle variants delegate to the existing content
 * script implementations; navigation reuses the local handler.
 */
const handleWait = async (params: Record<string, unknown>): Promise<unknown> => {
  const p = params as unknown as BrowserWaitParams;
  const timeoutMs = p.timeout_ms ?? p.timeout ?? p.ms;
  const kind = p.type ?? (p.selector ? 'selector' : 'timeout');

  if (kind === 'navigation') {
    return handleWaitForNavigation({ timeout: timeoutMs, tabId: p.tabId });
  }

  if (kind === 'selector' || kind === 'network_idle') {
    if (kind === 'selector' && !p.selector) {
      throw new Error('selector is required for type=selector');
    }
    const tabId = await resolveTabId(p as { tabId?: number });
    await ensureContentScriptInjected(tabId);
    const payload: WolffishCommand = {
      id: generateId(),
      type: kind === 'selector' ? WolffishCommands.BROWSER_WAIT_FOR : WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
      params:
        kind === 'selector'
          ? { selector: p.selector, timeout: timeoutMs, visible: p.visible, tabId }
          : { timeout: timeoutMs, tabId },
    };
    const result = (await sendToContentScript(tabId, {
      source: 'service-worker',
      target: 'content-script',
      payload,
    })) as WolffishResponse;
    if (!result?.success) {
      throw new Error(result?.error ?? `${kind} wait failed`);
    }
    return result.data;
  }

  const requested = Number(timeoutMs);
  const waited = Number.isFinite(requested) && requested > 0 ? requested : 0;
  await new Promise(resolve => setTimeout(resolve, waited));
  return { waited };
};

// ─── Notification Handler ───────────────────────────────────────────────────

const handleNotify = async (params: Record<string, unknown>): Promise<BrowserNotifyResult> => {
  const { title, message, iconUrl } = params as unknown as BrowserNotifyParams;

  const notificationId = await api.notifications.create('', {
    type: 'basic',
    title,
    message,
    iconUrl: iconUrl || api.runtime.getURL('icon-128.png'),
  });

  return { notificationId };
};

// ─── Get URL Handler ────────────────────────────────────────────────────────

const handleGetUrl = async (params: Record<string, unknown>): Promise<BrowserGetUrlResult> => {
  const tabId = await resolveTabId(params as BrowserGetUrlParams);
  const tab = await api.tabs.get(tabId);

  return { url: tab.url || '', title: tab.title || '' };
};

// ─── Command Router ─────────────────────────────────────────────────────────

const SERVICE_WORKER_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  [WolffishCommands.BROWSER_NAVIGATE]: handleNavigate,
  [WolffishCommands.BROWSER_BACK]: handleBack,
  [WolffishCommands.BROWSER_FORWARD]: handleForward,
  [WolffishCommands.BROWSER_RELOAD]: handleReload,
  [WolffishCommands.BROWSER_TABS_LIST]: handleTabsList,
  [WolffishCommands.BROWSER_TAB_OPEN]: handleTabOpen,
  [WolffishCommands.BROWSER_TAB_CLOSE]: handleTabClose,
  [WolffishCommands.BROWSER_TAB_SWITCH]: handleTabSwitch,
  [WolffishCommands.BROWSER_TAB_DUPLICATE]: handleTabDuplicate,
  [WolffishCommands.BROWSER_TAB_MOVE]: handleTabMove,
  [WolffishCommands.BROWSER_WINDOWS_LIST]: handleWindowsList,
  [WolffishCommands.BROWSER_WINDOW_OPEN]: handleWindowOpen,
  [WolffishCommands.BROWSER_WINDOW_CLOSE]: handleWindowClose,
  [WolffishCommands.BROWSER_WINDOW_RESIZE]: handleWindowResize,
  [WolffishCommands.BROWSER_SCREENSHOT]: handleScreenshot,
  [WolffishCommands.BROWSER_PDF]: handlePdf,
  [WolffishCommands.BROWSER_COOKIES_GET]: handleCookiesGet,
  [WolffishCommands.BROWSER_COOKIES_SET]: handleCookiesSet,
  [WolffishCommands.BROWSER_COOKIES_REMOVE]: handleCookiesRemove,
  [WolffishCommands.BROWSER_DOWNLOAD]: handleDownload,
  [WolffishCommands.BROWSER_EXECUTE_JS]: handleExecuteJs,
  [WolffishCommands.BROWSER_WAIT]: handleWait,
  [WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION]: handleWaitForNavigation,
  [WolffishCommands.BROWSER_NOTIFY]: handleNotify,
  [WolffishCommands.BROWSER_GET_URL]: handleGetUrl,
  [WolffishCommands.DEBUGGER_ATTACH]: handleDebuggerAttach,
  [WolffishCommands.DEBUGGER_DETACH]: handleDebuggerDetach,
  [WolffishCommands.DEBUGGER_STATUS]: handleDebuggerStatus,
  [WolffishCommands.BROWSER_MOUSE_MOVE]: handleMouseMove,
  [WolffishCommands.BROWSER_MOUSE_CLICK]: handleMouseClick,
  [WolffishCommands.BROWSER_MOUSE_DOWN]: handleMouseDown,
  [WolffishCommands.BROWSER_MOUSE_UP]: handleMouseUp,
  [WolffishCommands.BROWSER_MOUSE_DRAG]: handleMouseDrag,
  [WolffishCommands.HUMANIZE]: handleHumanize,
};

const CDP_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  [WolffishCommands.BROWSER_CLICK]: handleCDPClick,
  [WolffishCommands.BROWSER_TYPE]: handleCDPType,
  [WolffishCommands.BROWSER_SCROLL]: handleCDPScroll,
  [WolffishCommands.BROWSER_HOVER]: handleCDPHover,
  [WolffishCommands.BROWSER_KEYPRESS]: handleCDPKeypress,
};

// ─── Response Relay ─────────────────────────────────────────────────────────

const sendResponseToServer = (response: WolffishResponse): void => {
  sendToServer(response);
};

// ─── Command Dispatcher ─────────────────────────────────────────────────────

const handleCommand = async (command: WolffishCommand): Promise<void> => {
  log('←', command.type, command.params);

  try {
    let response: WolffishResponse;

    if (SERVICE_WORKER_COMMANDS.has(command.type)) {
      const handler = SERVICE_WORKER_HANDLERS[command.type];
      if (!handler) {
        response = makeErrorResponse(command.id, `No handler for command: ${command.type}`);
      } else {
        const data = await withTimeout(handler(command.params));
        response = makeResponse(command.id, data);
      }
    } else if (CONTENT_SCRIPT_COMMANDS.has(command.type)) {
      // CDP routing: if debugger is attached and this is an interaction command, use CDP
      const debuggerState = getDebuggerState();
      if (debuggerState.attached && DEBUGGER_ROUTABLE_COMMANDS.has(command.type)) {
        const cdpHandler = CDP_HANDLERS[command.type];
        if (cdpHandler) {
          try {
            const data = await withTimeout(cdpHandler(command.params));
            response = makeResponse(command.id, data);
            log('→', command.type, 'success (CDP)');
            sendResponseToServer(response);
            return;
          } catch (cdpErr) {
            log('CDP fallback:', command.type, cdpErr instanceof Error ? cdpErr.message : String(cdpErr));
            // Fall through to content script path
          }
        }
      }

      const tabId = await resolveTabId(command.params as { tabId?: number });
      await ensureContentScriptInjected(tabId);

      const result = await withTimeout(
        sendToContentScript(tabId, {
          source: 'service-worker',
          target: 'content-script',
          payload: command,
        }),
      );

      response = result as WolffishResponse;
    } else {
      response = makeErrorResponse(command.id, `Unknown command: ${command.type}`);
    }

    log('→', command.type, response.success ? 'success' : response.error);
    sendResponseToServer(response);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const response = makeErrorResponse(command.id, errorMessage);
    log('→', command.type, 'error:', response.error);
    sendResponseToServer(response);
  }
};

// ─── Persistent Cache ───────────────────────────────────────────────────────
//
// Mirrors in-memory state to chrome.storage.local so the side panel can
// display conversations and events even when the Wolffish app is down.
// Storage keys are prefixed with "wf:" to avoid collisions.

const CACHE_MAX_CONVERSATIONS = 50;
const CACHE_MAX_EVENTS = 500;

type CachedEvent = { id: string; type: string; title: string; timestamp: number };
type CachedConversation = { conversationId: string; title: string; eventCount: number; lastTimestamp: number };

const cache = {
  saveConversations(list: CachedConversation[]) {
    const trimmed = list.slice(0, CACHE_MAX_CONVERSATIONS);
    api.storage.local.set({ 'wf:conversations': trimmed }).catch(() => {});
  },
  saveActive(id: string | null) {
    api.storage.local.set({ 'wf:active': id }).catch(() => {});
  },
  saveEvents(conversationId: string, events: CachedEvent[]) {
    const trimmed = events.slice(0, CACHE_MAX_EVENTS);
    api.storage.local.set({ [`wf:events:${conversationId}`]: trimmed }).catch(() => {});
  },
  async loadAll(): Promise<{
    conversations: CachedConversation[];
    active: string | null;
    events: CachedEvent[];
  }> {
    try {
      const data = await api.storage.local.get(['wf:conversations', 'wf:active']);
      const conversations = (data['wf:conversations'] as CachedConversation[]) ?? [];
      const active = (data['wf:active'] as string) ?? null;
      let events: CachedEvent[] = [];
      if (active) {
        const evData = await api.storage.local.get([`wf:events:${active}`]);
        events = (evData[`wf:events:${active}`] as CachedEvent[]) ?? [];
      }
      return { conversations, active, events };
    } catch {
      return { conversations: [], active: null, events: [] };
    }
  },
  async loadEvents(conversationId: string): Promise<CachedEvent[]> {
    try {
      const data = await api.storage.local.get([`wf:events:${conversationId}`]);
      return (data[`wf:events:${conversationId}`] as CachedEvent[]) ?? [];
    } catch {
      return [];
    }
  },
};

// ─── Wolffish Event Handler ─────────────────────────────────────────────────

let cachedEvents: CachedEvent[] = [];
let cachedConversations: CachedConversation[] = [];
let activeConversationId: string | null = null;
let activeConversationTitle: string | null = null;
let cacheRestored = false;

const handleWolffishEvent = (event: { type: 'event'; event: string; data: unknown }): void => {
  if (event.event === 'port_update') {
    const { port } = event.data as { port: number };
    log(`Port update received: ${port}`);
    wolffishConnectionStorage.set({ port });
    return;
  }

  if (event.event === 'extension_reload') {
    log('Received reload command from Wolffish');
    api.runtime.reload();
    return;
  }

  if (event.event === 'events_sync') {
    const data = event.data as { conversationId: string; title?: string; events: CachedEvent[] };
    activeConversationId = data.conversationId;
    activeConversationTitle = data.title ?? null;
    cachedEvents = (data.events ?? []).slice().reverse();
    cache.saveActive(activeConversationId);
    cache.saveEvents(activeConversationId, cachedEvents);
    api.runtime.sendMessage({ payload: { event: 'events_sync', data: event.data } }).catch(() => {});
    return;
  }

  if (event.event === 'event_logged') {
    const entry = event.data as CachedEvent;
    cachedEvents.unshift(entry);
    if (activeConversationId) {
      cache.saveEvents(activeConversationId, cachedEvents);
    }
    api.runtime.sendMessage({ payload: { event: 'event_logged', data: entry } }).catch(() => {});
    return;
  }

  if (event.event === 'conversations_list') {
    cachedConversations = event.data as CachedConversation[];
    cache.saveConversations(cachedConversations);
    api.runtime.sendMessage({ payload: { event: 'conversations_list', data: event.data } }).catch(() => {});
    // Pre-fetch events for all conversations so they're available offline
    for (const conv of cachedConversations) {
      sendToServer({ type: 'get_conversation_events', conversationId: conv.conversationId });
    }
    return;
  }

  if (event.event === 'conversation_events') {
    const data = event.data as { conversationId: string; events: CachedEvent[] };
    cache.saveEvents(data.conversationId, (data.events ?? []).slice().reverse());
    api.runtime.sendMessage({ payload: { event: 'conversation_events', data } }).catch(() => {});
    return;
  }
};

// ─── Message Listener (side panel queries only) ─────────────────────────────

api.runtime.onMessage.addListener((message: { type?: string; conversationId?: string }, _sender, sendResponse) => {
  if (message.type === 'get_connection_status') {
    const actual: ConnectionStatus =
      ws && ws.readyState === WebSocket.OPEN
        ? 'connected'
        : ws && ws.readyState === WebSocket.CONNECTING
          ? 'connecting'
          : 'disconnected';
    if (actual !== connectionStatus) connectionStatus = actual;
    sendResponse({ status: connectionStatus, port: connectionPort } as ConnectionStatusResponse);
    return true;
  }

  if (message.type === 'get_events') {
    sendToServer({ type: 'get_conversations' });
    // If in-memory cache is populated, respond immediately
    if (cachedConversations.length > 0 || activeConversationId) {
      sendResponse({
        events: cachedEvents,
        conversations: cachedConversations,
        activeConversation: activeConversationId,
        activeConversationTitle,
      });
    } else {
      // Service worker just restarted — load from storage
      cache.loadAll().then(data => {
        cachedConversations = data.conversations;
        activeConversationId = data.active;
        cachedEvents = data.events;
        sendResponse({
          events: cachedEvents,
          conversations: cachedConversations,
          activeConversation: activeConversationId,
          activeConversationTitle,
        });
        // Also emit so the side panel listener picks it up
        api.runtime
          .sendMessage({ payload: { event: 'conversations_list', data: cachedConversations } })
          .catch(() => {});
      });
    }
    return true;
  }

  if (message.type === 'get_conversation_events' && message.conversationId) {
    const id = message.conversationId;
    sendToServer({ type: 'get_conversation_events', conversationId: id });
    // Always emit from cache so the side panel updates even when offline
    cache.loadEvents(id).then(events => {
      cachedEvents = events;
      api.runtime
        .sendMessage({ payload: { event: 'conversation_events', data: { conversationId: id, events } } })
        .catch(() => {});
      sendResponse({ events });
    });
    return true;
  }

  return false;
});

// ─── Lifecycle & Startup ────────────────────────────────────────────────────

const startConnection = async (): Promise<void> => {
  const config = await wolffishConnectionStorage.get().catch(() => ({ port: DEFAULT_PORT }));
  connectionPort = config.port;
  connectWebSocket(connectionPort);
};

api.runtime.onInstalled.addListener(async () => {
  log('Extension installed');
  if (api.sidePanel) {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  await startConnection();
});

api.runtime.onStartup.addListener(async () => {
  log('Extension started');
  if (api.sidePanel) {
    api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  await startConnection();
});

// Watch for port changes in storage
wolffishConnectionStorage.subscribe(() => {
  const snapshot = wolffishConnectionStorage.getSnapshot();
  if (snapshot && snapshot.port !== connectionPort) {
    log(`Port changed to ${snapshot.port}`);
    api.alarms.clear(RECONNECT_ALARM);
    connectWebSocket(snapshot.port);
  }
});

// Restore cache from storage, then connect
cache
  .loadAll()
  .then(data => {
    if (!cacheRestored) {
      cachedConversations = data.conversations;
      activeConversationId = data.active;
      cachedEvents = data.events;
      cacheRestored = true;
      log(`Cache restored: ${data.conversations.length} conversations, ${data.events.length} events`);
    }
  })
  .catch(() => {});

startConnection().catch(err => logError('Failed to start connection:', err));

log('Service worker loaded');
