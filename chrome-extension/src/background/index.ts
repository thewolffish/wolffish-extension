import 'webextension-polyfill';
import {
  BRIDGE_TOKEN_FILE,
  COMMAND_TIMEOUT_MS,
  DEFAULT_PORT,
  DIALOG_BLOCKED_COMMANDS,
  HEARTBEAT_INTERVAL_MS,
  INPUT_COMMANDS,
  READ_COMMANDS,
  RECONNECT_ALARM_MINUTES,
  WolffishCommands,
  CONTENT_SCRIPT_COMMANDS,
  SERVICE_WORKER_COMMANDS,
  DEBUGGER_ROUTABLE_COMMANDS,
  log,
  logError,
  sendToContentScript,
  ensureContentScriptInjected,
  resolveTabId,
  setTabFallback,
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
  BrowserDoctorResult,
  BrowserDownloadParamsV2,
  BrowserDownloadResultV2,
  BrowserExecuteJsParamsV2,
  BrowserScreenshotParamsV2,
  BrowserScreenshotResultV2,
  BrowserFileUploadParamsV2,
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
  BrowserPdfParams,
  BrowserPdfResult,
  BrowserCookiesGetParams,
  BrowserCookiesGetResult,
  BrowserCookiesSetParams,
  BrowserCookiesRemoveParams,
  BrowserExecuteJsResult,
  BrowserWaitParams,
  BrowserWaitForNavigationParams,
  BrowserWaitForNavigationResult,
  BrowserNotifyParams,
  BrowserNotifyResult,
  BrowserGetUrlParams,
  BrowserGetUrlResult,
  BrowserSetActivityParams,
  BrowserSetActivityResult,
  ConnectionStatus,
} from '@extension/shared';
import {
  handleDebuggerAttach,
  handleDebuggerDetach,
  handleDebuggerStatus,
  handleCDPClick,
  handleCDPExecuteJs,
  handleCDPFileUpload,
  handleCDPFill,
  handleCDPFillForm,
  handleCDPFind,
  handleCDPFocus,
  handleCDPGetAttribute,
  handleCDPGetValue,
  handleCDPHover,
  handleCDPKeypress,
  handleCDPResolveUid,
  handleCDPScreenshot,
  handleCDPScroll,
  handleCDPSelect,
  handleCDPSetValue,
  handleCDPTakeSnapshot,
  handleCDPType,
  handleEmulate,
  handleGetNetworkRequest,
  handleHandleDialog,
  handleListConsoleMessages,
  handleListNetworkRequests,
  handleMouseMove,
  handleMouseClick,
  handleMouseDown,
  handleMouseUp,
  handleMouseDrag,
  dialogOpenError,
  hasSession,
  overlayHooks,
  sessionsReady,
} from './debugger.js';
import { captureBefore, waitAfterAction } from './aftermath.js';
import type { ActionBefore } from './aftermath.js';
import {
  initOverlayDriver,
  isOverlayEnabled,
  markTabInUse,
  overlayDriver,
  setOverlayEnabled,
} from './overlay-driver.js';
import { handleHumanize } from './humanize-actions.js';
import { getBrowserIdentity } from './identity.js';
import {
  adoptTab,
  ensureWorkspaceTab,
  getWorkspaceGroupId,
  openWorkspaceTab,
  rememberWorkspaceTab,
  setActivity,
} from './workspace.js';

const api = globalThis.chrome;

// Every command that does not name a tab targets Wolffish's own tab (created on
// first use, inside the Wolffish tab group) instead of whatever the user was
// looking at. This one line covers all ~15 `resolveTabId` call sites.
setTabFallback(ensureWorkspaceTab);

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
  api.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_ALARM_MINUTES });
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
    // Identity is async (storage + Firefox getBrowserInfo); keep the
    // extension_info → get_conversations ordering inside one chain. If the
    // socket drops meanwhile, sendToServer's readyState guard drops both.
    void Promise.all([getBrowserIdentity().catch(() => null), readBridgeToken()]).then(([identity, bridgeToken]) => {
      sendToServer({
        type: 'extension_info',
        version: manifest.version,
        extensionId: api.runtime.id,
        bridgeToken,
        overlayEnabled: isOverlayEnabled(),
        ...(identity ?? {}),
      });
      sendToServer({ type: 'get_conversations' });
    });
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

/**
 * The app writes this file into the extension folder it already syncs on
 * every launch, so possessing it proves this really is the app's own bundled
 * extension and not some other local process dialling the same port. Absent
 * on a pre-v2 build, which the server accepts and flags as legacy.
 */
const readBridgeToken = async (): Promise<string | null> => {
  try {
    const res = await fetch(api.runtime.getURL(BRIDGE_TOKEN_FILE));
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return typeof body.token === 'string' && body.token ? body.token : null;
  } catch {
    return null;
  }
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
  const { url, waitUntil, newTab } = params as unknown as BrowserNavigateParams;
  const tabId = newTab ? await openWorkspaceTab() : await resolveTabId(params as { tabId?: number });

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

  // `wolffish` marks the tabs it is free to drive; everything else is the
  // user's, and is only touched when a command names its id explicitly.
  const groupId = await getWorkspaceGroupId();

  return {
    tabs: tabs.map(t => ({
      id: t.id!,
      url: t.url || '',
      title: t.title || '',
      active: t.active,
      pinned: t.pinned,
      windowId: t.windowId,
      groupId: t.groupId,
      wolffish: groupId !== null && t.groupId === groupId,
    })),
  };
};

const handleTabOpen = async (params: Record<string, unknown>): Promise<BrowserTabOpenResult> => {
  const { url, active } = params as unknown as BrowserTabOpenParams;
  const tabId = await openWorkspaceTab(url, active ?? true);
  const tab = await api.tabs.get(tabId).catch(() => null);

  return {
    tabId,
    url: tab?.pendingUrl || tab?.url || url || '',
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
  // Switching between Wolffish's own tabs also moves the default target; a
  // switch into one of the user's tabs deliberately does not.
  await rememberWorkspaceTab(tabId);

  return { success: true };
};

const handleTabDuplicate = async (params: Record<string, unknown>): Promise<BrowserTabDuplicateResult> => {
  const { tabId } = params as unknown as BrowserTabDuplicateParams;
  const newTab = await api.tabs.duplicate(tabId);

  if (!newTab) {
    throw new Error(`Failed to duplicate tab ${tabId}`);
  }

  // The copy is Wolffish's, even when the original was the user's — so it joins
  // the group and becomes the target rather than being left stranded outside.
  await adoptTab(newTab.id!);

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

  // A separate window is deliberately outside the Wolffish group (grouping its
  // tab would drag it straight back into the group's window), so hand back the
  // tab id — it is the only way later commands can address this window.
  return { windowId: win.id!, tabId: win.tabs?.[0]?.id };
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

const handleScreenshot = async (params: Record<string, unknown>): Promise<BrowserScreenshotResultV2> => {
  const { format, quality, fullPage, selector, uid } = params as unknown as BrowserScreenshotParamsV2;
  const tabId = await resolveTabId(params as { tabId?: number });

  // With a session, CDP captures anything: full page beyond the viewport, a
  // clip around one element, and a background tab (fromSurface) without
  // stealing the user's foreground.
  if (hasSession(tabId)) {
    return handleCDPScreenshot({ ...params, tabId }) as Promise<BrowserScreenshotResultV2>;
  }

  // Without one, captureVisibleTab is all there is — and it can only do the
  // visible area of the active tab. Full-page and element captures used to be
  // delegated to a content-script handler that never existed: the dispatcher
  // wrapped the missing data as success, so the model got "captured" with no
  // image and no way to tell. Say what is needed instead.
  if (fullPage || selector || uid) {
    throw new Error('Full-page and element screenshots need the debugger. Call ext_debugger_attach first.');
  }

  const captureFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const options: chrome.tabs.CaptureVisibleTabOptions = { format: captureFormat };
  if (captureFormat === 'jpeg' && quality !== undefined) {
    options.quality = quality;
  }

  // captureVisibleTab can only photograph the *active* tab of a window, so the
  // target has to be foregrounded first — otherwise the capture silently
  // returns whichever other tab happened to be in front.
  let tab = await api.tabs.get(tabId);
  if (!tab.active) {
    await api.tabs.update(tabId, { active: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    tab = await api.tabs.get(tabId);
  }

  await overlayHooks.beforeCapture(tabId).catch(() => {});
  let dataUrl: string;
  try {
    dataUrl = await api.tabs.captureVisibleTab(tab.windowId, options);
  } finally {
    void overlayHooks.afterCapture(tabId).catch(() => {});
  }

  // The window's outer size is NOT the image's size: it includes the browser
  // chrome and ignores the device pixel ratio, so every coordinate the model
  // derived from it was off. Measure the page itself.
  const metrics = await api.scripting
    .executeScript({
      target: { tabId },
      func: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    })
    .then(r => r[0]?.result as { w: number; h: number; dpr: number } | undefined)
    .catch(() => undefined);

  const cssWidth = metrics?.w ?? 0;
  const cssHeight = metrics?.h ?? 0;
  const dpr = metrics?.dpr ?? 1;

  return {
    image: dataUrl,
    width: Math.round(cssWidth * dpr),
    height: Math.round(cssHeight * dpr),
    cssWidth,
    cssHeight,
    dpr,
    mode: 'visible',
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

const handleDownload = async (params: Record<string, unknown>): Promise<BrowserDownloadResultV2> => {
  const { url, filename, waitMs } = params as unknown as BrowserDownloadParamsV2;
  const options: chrome.downloads.DownloadOptions = { url };
  if (filename !== undefined) {
    options.filename = filename;
  }

  const downloadId = await api.downloads.download(options);
  const budget = Number.isFinite(waitMs) ? Math.max(0, waitMs as number) : 60_000;
  if (budget === 0) return { downloadId, state: 'in_progress' };

  // A download id alone told the model nothing: it could not say whether the
  // file landed, where, or why it failed. Wait for the terminal state.
  return new Promise<BrowserDownloadResultV2>(resolve => {
    let settled = false;
    const finish = (result: BrowserDownloadResultV2): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      api.downloads.onChanged.removeListener(listener);
      resolve(result);
    };

    const report = async (): Promise<void> => {
      const [item] = await api.downloads.search({ id: downloadId }).catch(() => []);
      if (!item) return;
      if (item.state === 'complete') finish({ downloadId, state: 'complete', filename: item.filename });
      else if (item.state === 'interrupted') {
        finish({ downloadId, state: 'interrupted', error: item.error ?? 'interrupted' });
      }
    };

    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id === downloadId) void report();
    };
    api.downloads.onChanged.addListener(listener);
    const timer = setTimeout(() => finish({ downloadId, state: 'in_progress' }), budget);
    void report();
  });
};

// ─── JavaScript Execution Handler ───────────────────────────────────────────

const handleExecuteJs = async (params: Record<string, unknown>): Promise<BrowserExecuteJsResult> => {
  const { code, world } = params as unknown as BrowserExecuteJsParamsV2;
  const tabId = await resolveTabId(params as { tabId?: number });

  // With a session, Runtime.evaluate handles expressions, await, and uid
  // arguments resolved to live element handles.
  if (hasSession(tabId)) {
    return handleCDPExecuteJs({ ...params, tabId }) as Promise<BrowserExecuteJsResult>;
  }

  // MAIN, not ISOLATED: an isolated-world eval runs under the extension's MV3
  // content-security policy, which forbids unsafe-eval — so the old default
  // threw EvalError on every call that did not name a world.
  const results = await api.scripting.executeScript({
    target: { tabId },
    func: (source: string) => eval(source),
    args: [code],
    world: (world || 'MAIN') as chrome.scripting.ExecutionWorld,
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

// ─── Tab Group Activity Handler ─────────────────────────────────────────────

/**
 * The Wolffish tab group's title is fully model-driven: it sets an emoji and a
 * short phrase for whatever it is doing, and clearing both restores "Wolffish".
 */
const handleSetActivity = async (params: Record<string, unknown>): Promise<BrowserSetActivityResult> => {
  const { emoji, text } = params as unknown as BrowserSetActivityParams;
  return setActivity({ emoji, text });
};

// ─── Get URL Handler ────────────────────────────────────────────────────────

const handleGetUrl = async (params: Record<string, unknown>): Promise<BrowserGetUrlResult> => {
  const tabId = await resolveTabId(params as BrowserGetUrlParams);
  const tab = await api.tabs.get(tabId);

  return { url: tab.url || '', title: tab.title || '' };
};

/** Send one command to a tab's content script and unwrap its response. */
const relayToContentScript = async (type: string, params: Record<string, unknown>): Promise<unknown> => {
  const tabId = await resolveTabId(params as { tabId?: number });
  await ensureContentScriptInjected(tabId);
  const result = (await sendToContentScript(tabId, {
    source: 'service-worker',
    target: 'content-script',
    payload: { id: generateId(), type, params } as WolffishCommand,
  })) as WolffishResponse;
  if (!result?.success) throw new Error(result?.error ?? `${type} failed`);
  return result.data;
};

// ─── Readiness Probe ────────────────────────────────────────────────────────

/**
 * What this browser lets Wolffish do, asked of the browser itself. The app
 * composes findings from this plus what it knows locally (installed browsers,
 * folder versions, port state), so everything here is a raw fact, never a
 * verdict — the phrasing the user reads lives in the app.
 *
 * The one that bites most often is site access: a user who set the extension
 * to "On click" gets "Cannot access contents of url" from every command, which
 * reads like a bug rather than a setting.
 */
const handleDoctor = async (params: Record<string, unknown>): Promise<BrowserDoctorResult> => {
  const manifest = api.runtime.getManifest();

  const maybe = async <T>(fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const siteAccessAllUrls = await maybe(
    () => api.permissions?.contains({ origins: ['<all_urls>'] }) ?? Promise.resolve(null),
    null as boolean | null,
  );
  const incognitoAllowed = await maybe(
    () => api.extension?.isAllowedIncognitoAccess?.() ?? Promise.resolve(null),
    null as boolean | null,
  );
  const fileSchemeAllowed = await maybe(
    () => api.extension?.isAllowedFileSchemeAccess?.() ?? Promise.resolve(null),
    null as boolean | null,
  );
  const notifications = await maybe(
    async () => ((await api.notifications?.getPermissionLevel?.()) ?? null) as 'granted' | 'denied' | null,
    null as 'granted' | 'denied' | null,
  );
  const self = await maybe(
    async () => (await api.management?.getSelf?.()) ?? null,
    null as chrome.management.ExtensionInfo | null,
  );
  const targets = await maybe(
    async () => (await api.debugger?.getTargets?.()) ?? [],
    [] as chrome.debugger.TargetInfo[],
  );

  // A scripting ping on the tab the model is actually working in: the only
  // probe that proves the content script can run *here*, policy included.
  let scriptable: BrowserDoctorResult['scriptable'] = null;
  let policyBlocked = false;
  try {
    const tabId = await resolveTabId(params as { tabId?: number });
    const tab = await api.tabs.get(tabId).catch(() => null);
    try {
      await api.scripting.executeScript({ target: { tabId }, func: () => true });
      scriptable = { tabId, ok: true, url: tab?.url };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      policyBlocked = /policy|ExtensionSettings|blocked by/i.test(error);
      scriptable = { tabId, ok: false, error, url: tab?.url };
    }
  } catch {
    // No resolvable tab (a brand-new browser with nothing open yet).
  }

  return {
    extension: {
      id: api.runtime.id,
      version: manifest.version,
      manifestPermissions: manifest.permissions ?? [],
      hostPermissions: manifest.host_permissions ?? [],
    },
    siteAccessAllUrls,
    incognitoAllowed,
    fileSchemeAllowed,
    notifications,
    installType: self?.installType ?? null,
    enabled: self?.enabled ?? null,
    mayDisable: self?.mayDisable ?? null,
    apis: {
      debugger: typeof api.debugger !== 'undefined',
      tabGroups: typeof api.tabGroups !== 'undefined',
      sidePanel: typeof api.sidePanel !== 'undefined',
      scripting: typeof api.scripting !== 'undefined',
      downloads: typeof api.downloads !== 'undefined',
    },
    debuggerAttachedTabs: targets.filter(t => t.attached && typeof t.tabId === 'number').map(t => t.tabId as number),
    scriptable,
    policyBlocked,
    overlayEnabled: isOverlayEnabled(),
  };
};

/**
 * File upload splits by source: real disk paths can only be handed to the page
 * through CDP (DOM.setFileInputFiles), while base64 content is built into a
 * DataTransfer in the page and works with no session at all.
 */
const handleFileUpload = async (params: Record<string, unknown>): Promise<unknown> => {
  const { filePaths } = params as unknown as BrowserFileUploadParamsV2;
  await sessionsReady;
  const tabId = await resolveTabId(params as { tabId?: number });
  if (filePaths && filePaths.length > 0) {
    if (!hasSession(tabId)) {
      throw new Error(
        'Uploading by file path needs the debugger. Call ext_debugger_attach first, or pass files as base64 content.',
      );
    }
    return handleCDPFileUpload({ ...params, tabId });
  }
  return relayToContentScript(WolffishCommands.BROWSER_FILE_UPLOAD, { ...params, tabId });
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
  [WolffishCommands.BROWSER_SET_ACTIVITY]: handleSetActivity,
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
  [WolffishCommands.BROWSER_FILE_UPLOAD]: handleFileUpload,
  // CDP-only observation: each answers with a deterministic "needs the
  // debugger" error when the resolved tab has no session.
  [WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS]: handleListNetworkRequests,
  [WolffishCommands.BROWSER_GET_NETWORK_REQUEST]: handleGetNetworkRequest,
  [WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES]: handleListConsoleMessages,
  [WolffishCommands.BROWSER_HANDLE_DIALOG]: handleHandleDialog,
  [WolffishCommands.BROWSER_EMULATE]: handleEmulate,
  [WolffishCommands.BROWSER_DOCTOR]: handleDoctor,
};

const CDP_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  [WolffishCommands.BROWSER_CLICK]: handleCDPClick,
  [WolffishCommands.BROWSER_TYPE]: handleCDPType,
  [WolffishCommands.BROWSER_SCROLL]: handleCDPScroll,
  [WolffishCommands.BROWSER_HOVER]: handleCDPHover,
  [WolffishCommands.BROWSER_KEYPRESS]: handleCDPKeypress,
  // The v2 pairs: an accessibility-tree snapshot and uid-addressed actions
  // through CDP, each with a DOM twin in the content script for Firefox and
  // for pages the debugger cannot attach to.
  [WolffishCommands.BROWSER_TAKE_SNAPSHOT]: handleCDPTakeSnapshot,
  [WolffishCommands.BROWSER_RESOLVE_UID]: handleCDPResolveUid,
  [WolffishCommands.BROWSER_FIND]: handleCDPFind,
  [WolffishCommands.BROWSER_FILL]: handleCDPFill,
  [WolffishCommands.BROWSER_FILL_FORM]: handleCDPFillForm,
  [WolffishCommands.BROWSER_SET_VALUE]: handleCDPSetValue,
  [WolffishCommands.BROWSER_GET_VALUE]: handleCDPGetValue,
  [WolffishCommands.BROWSER_GET_ATTRIBUTE]: handleCDPGetAttribute,
  [WolffishCommands.BROWSER_FOCUS]: handleCDPFocus,
  [WolffishCommands.BROWSER_SELECT]: handleCDPSelect,
};

// ─── Response Relay ─────────────────────────────────────────────────────────

const sendResponseToServer = (response: WolffishResponse): void => {
  sendToServer(response);
};

// ─── Command Dispatcher ─────────────────────────────────────────────────────

/**
 * Does this command touch a page, and how? Drives both the on-page overlay
 * (cursor vs pill) and whether the result gets the post-action aftermath.
 */
const commandKind = (type: string): 'input' | 'read' | null => {
  if (INPUT_COMMANDS.has(type)) return 'input';
  if (READ_COMMANDS.has(type)) return 'read';
  return null;
};

/** Commands whose tab is incidental — marking them in-use would light an overlay on a tab nobody is driving. */
const TAB_AGNOSTIC = new Set<string>([
  WolffishCommands.BROWSER_TABS_LIST,
  WolffishCommands.BROWSER_WINDOWS_LIST,
  WolffishCommands.BROWSER_COOKIES_GET,
  WolffishCommands.BROWSER_COOKIES_SET,
  WolffishCommands.BROWSER_COOKIES_REMOVE,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_DOWNLOAD,
  WolffishCommands.BROWSER_SET_ACTIVITY,
  WolffishCommands.DEBUGGER_STATUS,
  WolffishCommands.BROWSER_DOCTOR,
]);

const handleCommand = async (command: WolffishCommand): Promise<void> => {
  log('←', command.type, command.params);

  try {
    let response: WolffishResponse;
    const kind = commandKind(command.type);
    let tabId: number | null = null;

    // Which tab is this for? Needed before the handler runs so the dialog gate
    // and the overlay both speak about the right page. Never fatal: a command
    // with no resolvable tab just skips both.
    if (!TAB_AGNOSTIC.has(command.type)) {
      tabId = await resolveTabId(command.params as { tabId?: number }).catch(() => null);
    }

    // A JavaScript dialog freezes its page: the renderer will not run script,
    // paint, or accept input until it is answered. Anything that would touch
    // the page is answered with what to do instead, and the app marks it
    // non-retryable — three identical retries against a modal help nobody.
    if (tabId !== null && DIALOG_BLOCKED_COMMANDS.has(command.type)) {
      const blocked = dialogOpenError(tabId);
      if (blocked) {
        sendResponseToServer(makeErrorResponse(command.id, blocked));
        log('→', command.type, 'blocked by dialog');
        return;
      }
    }

    if (tabId !== null && kind) void markTabInUse(tabId, kind);

    // The page's state BEFORE the action: a click handler that appends a node
    // runs synchronously, so a comparison made only afterwards sees nothing.
    const before = tabId !== null && INPUT_COMMANDS.has(command.type) ? await captureBefore(tabId) : undefined;

    if (SERVICE_WORKER_COMMANDS.has(command.type)) {
      const handler = SERVICE_WORKER_HANDLERS[command.type];
      if (!handler) {
        response = makeErrorResponse(command.id, `No handler for command: ${command.type}`);
      } else {
        const data = await withTimeout(handler(command.params));
        response = makeResponse(command.id, await decorate(command.type, tabId, data, before));
      }
    } else if (CONTENT_SCRIPT_COMMANDS.has(command.type)) {
      // CDP routing: with a session on THIS tab, the trusted path runs; a CDP
      // failure falls through to the content script, which implements the same
      // contract with synthetic events.
      if (tabId !== null && hasSession(tabId) && DEBUGGER_ROUTABLE_COMMANDS.has(command.type)) {
        const cdpHandler = CDP_HANDLERS[command.type];
        if (cdpHandler) {
          try {
            const data = await withTimeout(cdpHandler({ ...command.params, tabId }));
            response = makeResponse(command.id, await decorate(command.type, tabId, data, before));
            log('→', command.type, 'success (CDP)');
            sendResponseToServer(response);
            return;
          } catch (cdpErr) {
            const message = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
            // A uid names a node in the CDP snapshot that produced it; the
            // content script keeps its own, unrelated map. Falling through
            // would answer a real CDP failure with "No snapshot for this tab",
            // which sends the model off fixing the wrong thing.
            if (typeof command.params?.uid === 'string' || typeof command.params?.from_uid === 'string') {
              sendResponseToServer(makeErrorResponse(command.id, message));
              log('→', command.type, 'CDP error (uid target, no fallback):', message);
              return;
            }
            log('CDP fallback:', command.type, message);
          }
        }
      }

      const target = tabId ?? (await resolveTabId(command.params as { tabId?: number }));
      await ensureContentScriptInjected(target);

      const result = (await withTimeout(
        sendToContentScript(target, {
          source: 'service-worker',
          target: 'content-script',
          payload: command,
        }),
      )) as WolffishResponse;

      response =
        result?.success === true
          ? makeResponse(command.id, await decorate(command.type, target, result.data, before))
          : result;
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

/**
 * Every action that changes the page answers with what the page did: whether
 * it navigated, or whether anything in the DOM moved at all. "No visible
 * change" after a click is the single most useful signal the model can get —
 * it is the difference between reporting success and re-aiming.
 */
const decorate = async (type: string, tabId: number | null, data: unknown, before?: ActionBefore): Promise<unknown> => {
  if (tabId === null || !INPUT_COMMANDS.has(type)) return data;
  const aftermath = await waitAfterAction(tabId, before);
  if (!aftermath.navigated && aftermath.domChanged === undefined) return data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), ...aftermath };
  }
  return data;
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

  if (event.event === 'overlay_config') {
    const { enabled } = event.data as { enabled: boolean };
    log(`Overlay switch from app: ${enabled}`);
    void setOverlayEnabled(enabled !== false);
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

// The CDP layer draws the shadow cursor through these hooks; without them it
// runs exactly as before, silently.
overlayHooks.beforeCapture = overlayDriver.beforeCapture;
overlayHooks.afterCapture = overlayDriver.afterCapture;
overlayHooks.cursor = overlayDriver.cursor;
overlayHooks.pulse = overlayDriver.pulse;
overlayHooks.target = overlayDriver.target;

void initOverlayDriver();
// Sessions are rebuilt from storage + chrome.debugger.getTargets() before any
// command runs, so a restarted worker never reports "not attached" for a tab
// Chrome is still showing the debugging banner for.
void sessionsReady;

startConnection().catch(err => logError('Failed to start connection:', err));

log('Service worker loaded');
