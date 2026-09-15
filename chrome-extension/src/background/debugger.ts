import {
  NETWORK_BODY_MAX_CHARS,
  WolffishCommands,
  ensureContentScriptInjected,
  generateId,
  resolveTabId,
  sendToContentScript,
} from '@extension/shared';
import type {
  BrowserClickParams,
  BrowserEmulateParams,
  BrowserEmulateResult,
  BrowserExecuteJsParamsV2,
  BrowserFileUploadParamsV2,
  BrowserFileUploadResult,
  BrowserFillFormParams,
  BrowserFillFormResult,
  BrowserFillParams,
  BrowserFillResult,
  BrowserFindParams,
  BrowserFindResult,
  BrowserFocusParams,
  BrowserGetAttributeParams,
  BrowserGetAttributeResult,
  BrowserGetNetworkRequestParams,
  BrowserGetNetworkRequestResult,
  BrowserGetValueParams,
  BrowserGetValueResult,
  BrowserHandleDialogParams,
  BrowserHandleDialogResult,
  BrowserHoverParams,
  BrowserKeypressParams,
  BrowserListConsoleMessagesParams,
  BrowserListConsoleMessagesResult,
  BrowserListNetworkRequestsParams,
  BrowserListNetworkRequestsResult,
  BrowserMouseActionResult,
  BrowserMouseButtonParams,
  BrowserMouseClickParams,
  BrowserMouseDragParamsV2,
  BrowserMouseMoveParams,
  BrowserMouseMoveResult,
  BrowserResolveUidParams,
  BrowserResolveUidResult,
  BrowserScreenshotParamsV2,
  BrowserScreenshotResultV2,
  BrowserScrollParams,
  BrowserSelectParams,
  BrowserSetValueParams,
  BrowserSetValueResult,
  BrowserTakeSnapshotParams,
  BrowserTakeSnapshotResult,
  BrowserTypeParams,
  DebuggerAttachResult,
  DebuggerDetachParams,
  DebuggerDetachResult,
  DebuggerStatusResultV2,
  ElementTarget,
  EmulationState,
  NetworkConditionName,
  NetworkRequestSummary,
  WolffishCommand,
  WolffishResponse,
} from '@extension/shared';
import {
  anchorClickInPage,
  callOnNode,
  center,
  clearInPage,
  fillInPage,
  focusInPage,
  getAttributesInPage,
  getValueInPage,
  isFileInputInPage,
  nodeHrefInPage,
  nodeInfoInPage,
  nodeRect,
  releaseObject,
  resolveObjectId,
  resolveSelectorNode,
  scrollNodeIntoView,
  selectInPage,
  setFilesInPage,
  setValueInPage,
  unwrap,
} from './cdp-dom.js';
import type { EvalResult } from './cdp-dom.js';
import { cdpClick, cdpMove, cdpPress, cdpRelease, cdpWheel, pressKey, typeText } from './cdp-input.js';
import type { MouseButton } from './cdp-input.js';
import {
  assertNoDialog,
  attachTab,
  detachTab,
  dialogOpenError,
  getDebuggerState,
  getSession,
  hasSession,
  isRestrictedUrl,
  needsDebuggerError,
  paginate,
  requireSession,
  sendCDP,
  sessionsReady,
} from './cdp-session.js';
import type { NetworkEntry, Session } from './cdp-session.js';
import { findInSnapshot, lookupUid, takeSnapshot, withUidErrors } from './cdp-snapshot.js';
import { gaussianDelay, sleep } from './gaussian.js';
import { overlayHooks, postCursor } from './overlay-hooks.js';
import type { Rect } from './overlay-hooks.js';

const api = globalThis.chrome;

// ─── Tab + session resolution ────────────────────────────────────────────────

const tabOf = async (params: Record<string, unknown>): Promise<number> => {
  await sessionsReady;
  return resolveTabId(params as { tabId?: number });
};

/** The session for the tab a command names; throws the fallthrough phrase the dispatcher keys on. */
const sessionFor = async (params: Record<string, unknown>): Promise<Session> => requireSession(await tabOf(params));

/** Same, for commands with no content-script twin: the error tells the model what to do. */
const sessionForCapture = async (params: Record<string, unknown>, what: string): Promise<Session> => {
  const session = getSession(await tabOf(params));
  if (!session) throw new Error(needsDebuggerError(what));
  return session;
};

// ─── Cursor state for tabs without a session ─────────────────────────────────

const virtualCursor = new Map<number, { x: number; y: number }>();

/** Per-tab cursor; with no tab, the first attached tab's (or the first virtual one), so old zero-arg callers still work. */
const getCursorPosition = (tabId?: number): { x: number; y: number } => {
  if (tabId !== undefined) return getSession(tabId)?.cursor ?? virtualCursor.get(tabId) ?? { x: 0, y: 0 };
  const first = getDebuggerState().tabId;
  if (first !== null) return getSession(first)?.cursor ?? { x: 0, y: 0 };
  const virtual = virtualCursor.values().next();
  return virtual.done ? { x: 0, y: 0 } : virtual.value;
};

// ─── Target resolution ───────────────────────────────────────────────────────

interface TargetSpec {
  uid?: string;
  selector?: string;
  x?: number;
  y?: number;
}

interface ResolvedTarget {
  x: number;
  y: number;
  backendNodeId?: number;
  rect?: Rect;
  href: string | null;
}

interface NodeTarget {
  backendNodeId: number;
  ref: string;
  uid?: string;
}

const MISSING_TARGET_ERROR = 'Provide a uid, a selector, or x/y coordinates';

/** uid wins over selector. Returns the backend node plus the ref string used in error messages. */
const resolveNodeTarget = async (session: Session, spec: ElementTarget): Promise<NodeTarget> => {
  if (spec.uid) {
    const ref = lookupUid(session, spec.uid);
    return { backendNodeId: ref.backendNodeId, ref: spec.uid, uid: spec.uid };
  }
  if (spec.selector) {
    return { backendNodeId: await resolveSelectorNode(session.tabId, spec.selector), ref: spec.selector };
  }
  throw new Error('Provide a uid or a selector');
};

/** uid targets translate "node is gone" into the contract's detached phrase; selector targets pass errors through. */
const onTarget = <T>(target: NodeTarget, op: () => Promise<T>): Promise<T> =>
  target.uid ? withUidErrors(target.uid, op) : op();

const nodePoint = async (session: Session, target: NodeTarget, scroll: boolean): Promise<ResolvedTarget> =>
  onTarget(target, async () => {
    const tabId = session.tabId;
    if (scroll) await scrollNodeIntoView(tabId, target.backendNodeId);
    const rect = await nodeRect(tabId, target.backendNodeId);
    const href = await callOnNode<string | null>(tabId, target.backendNodeId, nodeHrefInPage).catch(() => null);
    overlayHooks.target(tabId, rect).catch(() => {});
    return { ...center(rect), backendNodeId: target.backendNodeId, rect, href };
  });

/**
 * No-session selector path: today's page-side resolver, kept verbatim so the
 * synthetic mouse fallback keeps `text=` support and the validation phrasing.
 */
const resolveElementCoordsFallback = async (
  tabId: number,
  selector: string,
  scroll: boolean,
): Promise<{ x: number; y: number; href: string | null; rect: Rect }> => {
  const result = await api.scripting.executeScript({
    target: { tabId },
    func: (sel: string, doScroll: boolean) => {
      const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (e: HTMLElement): boolean => {
        if (e.offsetParent !== null) return true;
        const st = getComputedStyle(e);
        return st.display !== 'none' && st.visibility !== 'hidden';
      };
      let el: HTMLElement | null = null;
      if (sel.startsWith('text=')) {
        const needle = normalize(sel.slice('text='.length).replace(/^(["'])([\s\S]*)\1$/, '$2'));
        if (needle) {
          const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'WOLFFISH-OVERLAY']);
          const exact: HTMLElement[] = [];
          const partial: HTMLElement[] = [];
          const all = document.body ? Array.from(document.body.getElementsByTagName('*')) : [];
          for (const node of all) {
            const e = node as HTMLElement;
            if (SKIP.has(e.tagName)) continue;
            const t = normalize(e.textContent ?? '');
            if (!t || t.length > needle.length + 200) continue;
            if (t === needle) exact.push(e);
            else if (t.includes(needle)) partial.push(e);
          }
          const pool = exact.length > 0 ? exact : partial;
          const deepest = pool.filter(e => !pool.some(o => o !== e && e.contains(o)));
          el = deepest.find(isVisible) ?? null;
        }
      } else {
        try {
          el = document.querySelector(sel) as HTMLElement | null;
        } catch {
          return {
            error: `selector syntax is incorrect: '${sel}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`,
          };
        }
      }
      if (!el) return null;
      if (doScroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = el.getBoundingClientRect();
      const anchor = el.closest('a');
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        href: anchor?.href || null,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      };
    },
    args: [selector, scroll],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const info = result[0]?.result as
    | { x: number; y: number; href: string | null; rect: Rect }
    | { error: string }
    | null;
  if (info && 'error' in info) throw new Error(info.error);
  if (!info) throw new Error(`Element not found: ${selector}`);
  return info;
};

/** No-session uid path: the content script owns the DOM-walker uid map, so ask it. */
const resolveUidViaContentScript = async (tabId: number, uid: string): Promise<ResolvedTarget> => {
  await ensureContentScriptInjected(tabId);
  const command: WolffishCommand = {
    id: generateId(),
    type: WolffishCommands.BROWSER_RESOLVE_UID,
    params: { uid, tabId },
  };
  const response = (await sendToContentScript(tabId, {
    source: 'service-worker',
    target: 'content-script',
    payload: command,
  })) as WolffishResponse;
  if (!response?.success) throw new Error(response?.error ?? `Element uid "${uid}" could not be resolved`);
  const data = response.data as BrowserResolveUidResult;
  if (!data.found || !data.center) {
    throw new Error(
      `Element uid "${uid}" not found in the latest snapshot. Take a new snapshot with ext_take_snapshot.`,
    );
  }
  if (data.rect) overlayHooks.target(tabId, data.rect).catch(() => {});
  return { x: data.center.x, y: data.center.y, rect: data.rect, href: null };
};

/**
 * The shared resolver for every uid/selector/x-y taking command. With a
 * session the node comes from CDP (backendNodeId, box model); without one the
 * mouse fallbacks still get coordinates from the page.
 */
const resolveTargetPoint = async (
  tabId: number,
  spec: TargetSpec,
  opts: { scroll?: boolean; missingError?: string } = {},
): Promise<ResolvedTarget> => {
  const scroll = opts.scroll ?? true;
  const session = getSession(tabId);
  if (spec.uid || spec.selector) {
    if (session) return nodePoint(session, await resolveNodeTarget(session, spec), scroll);
    if (spec.uid) return resolveUidViaContentScript(tabId, spec.uid);
    const found = await resolveElementCoordsFallback(tabId, spec.selector!, scroll);
    overlayHooks.target(tabId, found.rect).catch(() => {});
    return found;
  }
  if (typeof spec.x === 'number' && typeof spec.y === 'number') return { x: spec.x, y: spec.y, href: null };
  throw new Error(opts.missingError ?? MISSING_TARGET_ERROR);
};

// ─── Debugger commands ───────────────────────────────────────────────────────

const handleDebuggerAttach = async (params: Record<string, unknown>): Promise<DebuggerAttachResult> => {
  const tabId = await tabOf(params);
  await attachTab(tabId);
  return { success: true, tabId };
};

const handleDebuggerDetach = async (params: Record<string, unknown>): Promise<DebuggerDetachResult> => {
  await sessionsReady;
  const { tabId } = params as DebuggerDetachParams;
  await detachTab(typeof tabId === 'number' ? tabId : undefined);
  return { success: true };
};

const handleDebuggerStatus = async (params: Record<string, unknown>): Promise<DebuggerStatusResultV2> => {
  await sessionsReady;
  const state = getDebuggerState();
  if (!state.attached) return state;
  // Compatibility: `tabId` names the default tab when that one is attached, else the first attached.
  const defaultTab = await resolveTabId(params as { tabId?: number }).catch(() => null);
  return { ...state, tabId: defaultTab !== null && hasSession(defaultTab) ? defaultTab : state.tabId };
};

// ─── CDP interaction handlers ────────────────────────────────────────────────

const handleCDPClick = async (
  params: Record<string, unknown>,
): Promise<{ success: boolean; elementFound: boolean }> => {
  const p = params as unknown as BrowserClickParams & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const tabId = session.tabId;
  const before = await api.tabs.get(tabId).catch(() => null);

  const target = await resolveTargetPoint(tabId, p, { scroll: true, missingError: 'Provide a uid or a selector' });
  await sleep(gaussianDelay(50, 150));
  await cdpMove(session, target.x, target.y);
  await cdpClick(session, target.x, target.y, 'left');

  // Belt and suspenders from the selector era: a trusted click on a link that
  // did not navigate gets a DOM click on its anchor. Skipped once the tab is
  // already moving, so a successful click never navigates twice.
  if (target.href && target.backendNodeId !== undefined) {
    await sleep(200);
    const after = await api.tabs.get(tabId).catch(() => null);
    const moving = !after || after.status === 'loading' || (before?.url && after.url !== before.url);
    if (!moving) await callOnNode(tabId, target.backendNodeId, anchorClickInPage).catch(() => {});
  }

  return { success: true, elementFound: true };
};

const handleCDPType = async (params: Record<string, unknown>): Promise<{ success: boolean; typed: number }> => {
  const p = params as unknown as BrowserTypeParams & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const tabId = session.tabId;
  const text = p.text ?? '';

  const target = await resolveNodeTarget(session, p);
  const point = await nodePoint(session, target, true);
  await onTarget(target, async () => {
    await sendCDP(tabId, 'DOM.focus', { backendNodeId: target.backendNodeId }).catch(() =>
      callOnNode(tabId, target.backendNodeId, focusInPage),
    );
    if (p.clearFirst) await callOnNode(tabId, target.backendNodeId, clearInPage);
  });

  overlayHooks.cursor(tabId, point.x, point.y, 'keyboard').catch(() => {});
  const typed = await typeText(session, text, p.humanize !== false);
  return { success: true, typed };
};

const SCROLL_DELTAS: Record<string, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const handleCDPScroll = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const p = params as unknown as Partial<BrowserScrollParams> & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const amount = p.amount ?? 300;
  const [ux, uy] = (p.direction && SCROLL_DELTAS[p.direction]) || [0, 0];
  const deltaX = ux * amount;
  const deltaY = uy * amount;

  if (p.uid || p.selector) {
    const target = await resolveTargetPoint(session.tabId, p, { scroll: true });
    if (p.direction || p.amount !== undefined) await cdpWheel(session, target.x, target.y, deltaX, deltaY);
    await sleep(gaussianDelay(50, 150));
    return { success: true };
  }

  await cdpWheel(session, session.cursor.x || 400, session.cursor.y || 400, deltaX, deltaY);
  await sleep(gaussianDelay(50, 150));
  return { success: true };
};

const handleCDPHover = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const p = params as unknown as BrowserHoverParams & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const target = await resolveTargetPoint(session.tabId, p, {
    scroll: true,
    missingError: 'Provide a uid or a selector',
  });
  await sleep(100);
  await cdpMove(session, target.x, target.y);
  return { success: true };
};

const handleCDPKeypress = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { key, modifiers } = params as unknown as BrowserKeypressParams;
  const session = await sessionFor(params);
  assertNoDialog(session);
  if (!key) throw new Error('Provide a key');
  await pressKey(session, key, modifiers ?? []);
  return { success: true };
};

const handleCDPFocus = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const p = params as unknown as BrowserFocusParams & ElementTarget;
  const session = await sessionFor(params);
  const target = await resolveNodeTarget(session, p);
  await onTarget(target, () =>
    sendCDP(session.tabId, 'DOM.focus', { backendNodeId: target.backendNodeId }).catch(() =>
      callOnNode(session.tabId, target.backendNodeId, focusInPage),
    ),
  );
  return { success: true };
};

const handleCDPSelect = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const p = params as unknown as BrowserSelectParams & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const target = await resolveNodeTarget(session, p);
  await onTarget(target, () => callOnNode(session.tabId, target.backendNodeId, selectInPage, [p.value]));
  return { success: true };
};

const fillTarget = async (session: Session, spec: ElementTarget, value: string): Promise<BrowserFillResult> => {
  const target = await resolveNodeTarget(session, spec);
  const point = await nodePoint(session, target, true);
  overlayHooks.cursor(session.tabId, point.x, point.y, 'keyboard').catch(() => {});
  return onTarget(target, () =>
    callOnNode<BrowserFillResult>(session.tabId, target.backendNodeId, fillInPage, [value]),
  );
};

const handleCDPFill = async (params: Record<string, unknown>): Promise<BrowserFillResult> => {
  const p = params as unknown as BrowserFillParams;
  const session = await sessionFor(params);
  assertNoDialog(session);
  return fillTarget(session, p, p.value ?? '');
};

const handleCDPFillForm = async (params: Record<string, unknown>): Promise<BrowserFillFormResult> => {
  const p = params as unknown as BrowserFillFormParams;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const elements = Array.isArray(p.elements) ? p.elements : [];
  const failures: { ref: string; error: string }[] = [];
  let filled = 0;
  for (const element of elements) {
    try {
      await fillTarget(session, element, element.value ?? '');
      filled++;
    } catch (err) {
      failures.push({
        ref: element.uid ?? element.selector ?? '?',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { success: elements.length === 0 || filled > 0, filled, failures };
};

const handleCDPSetValue = async (params: Record<string, unknown>): Promise<BrowserSetValueResult> => {
  const p = params as unknown as BrowserSetValueParams & ElementTarget;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const target = await resolveNodeTarget(session, p);
  return onTarget(target, () =>
    callOnNode<BrowserSetValueResult>(session.tabId, target.backendNodeId, setValueInPage, [p.value ?? '']),
  );
};

const handleCDPGetValue = async (params: Record<string, unknown>): Promise<BrowserGetValueResult> => {
  const p = params as unknown as BrowserGetValueParams & ElementTarget;
  const session = await sessionFor(params);
  const target = await resolveNodeTarget(session, p);
  return onTarget(target, () => callOnNode<BrowserGetValueResult>(session.tabId, target.backendNodeId, getValueInPage));
};

const handleCDPGetAttribute = async (params: Record<string, unknown>): Promise<BrowserGetAttributeResult> => {
  const p = params as unknown as BrowserGetAttributeParams & ElementTarget;
  const session = await sessionFor(params);
  const target = await resolveNodeTarget(session, p);
  const attributes = await onTarget(target, () =>
    callOnNode<Record<string, string | null>>(session.tabId, target.backendNodeId, getAttributesInPage, [
      Array.isArray(p.attributes) ? p.attributes : [],
    ]),
  );
  return { attributes };
};

const handleCDPFileUpload = async (params: Record<string, unknown>): Promise<BrowserFileUploadResult> => {
  const p = params as unknown as BrowserFileUploadParamsV2;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const tabId = session.tabId;
  const target = await resolveNodeTarget(session, p);
  return onTarget(target, async () => {
    const isFile = await callOnNode<boolean>(tabId, target.backendNodeId, isFileInputInPage);
    if (!isFile) throw new Error(`Element is not a file input: ${target.ref}`);
    if (Array.isArray(p.filePaths) && p.filePaths.length > 0) {
      await sendCDP(tabId, 'DOM.setFileInputFiles', { files: p.filePaths, backendNodeId: target.backendNodeId });
      await callOnNode(tabId, target.backendNodeId, (el: HTMLInputElement) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});
      return { success: true, count: p.filePaths.length, via: 'paths' };
    }
    if (Array.isArray(p.files) && p.files.length > 0) {
      const count = await callOnNode<number>(tabId, target.backendNodeId, setFilesInPage, [p.files]);
      return { success: true, count, via: 'data' };
    }
    throw new Error('Provide files (base64 content) or filePaths.');
  });
};

// ─── Snapshot / find / resolve ───────────────────────────────────────────────

const handleCDPTakeSnapshot = async (params: Record<string, unknown>): Promise<BrowserTakeSnapshotResult> => {
  const { verbose } = params as BrowserTakeSnapshotParams;
  const session = await sessionFor(params);
  assertNoDialog(session);
  return takeSnapshot(session, verbose === true);
};

const handleCDPResolveUid = async (params: Record<string, unknown>): Promise<BrowserResolveUidResult> => {
  const { uid } = params as unknown as BrowserResolveUidParams;
  const session = await sessionFor(params);
  if (!uid) throw new Error('Provide a uid');
  const ref = lookupUid(session, uid);
  const meta = session.snapshotNodes.find(n => n.uid === uid);
  return withUidErrors(uid, async () => {
    const tabId = session.tabId;
    await scrollNodeIntoView(tabId, ref.backendNodeId);
    const rect = await nodeRect(tabId, ref.backendNodeId);
    const info = await callOnNode<{ tag: string }>(tabId, ref.backendNodeId, nodeInfoInPage).catch(() => null);
    return {
      found: true,
      center: center(rect),
      rect,
      tag: info?.tag ?? meta?.tag,
      role: meta?.role,
      name: meta?.name,
    };
  });
};

const handleCDPFind = async (params: Record<string, unknown>): Promise<BrowserFindResult> => {
  const { query, limit } = params as unknown as BrowserFindParams;
  const session = await sessionFor(params);
  assertNoDialog(session);
  if (!query) throw new Error('Provide a query');
  if (!session.hasSnapshot) await takeSnapshot(session, false);
  const elements = await findInSnapshot(session, query, limit ?? 10);
  return { elements, snapshotId: session.snapshotId };
};

// ─── Screenshot ──────────────────────────────────────────────────────────────

interface LayoutMetrics {
  cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
}

const devicePixelRatio = async (tabId: number): Promise<number> => {
  const res = (await sendCDP(tabId, 'Runtime.evaluate', {
    expression: 'window.devicePixelRatio',
    returnByValue: true,
  })) as EvalResult;
  const value = unwrap(res);
  return typeof value === 'number' && value > 0 ? value : 1;
};

const handleCDPScreenshot = async (params: Record<string, unknown>): Promise<BrowserScreenshotResultV2> => {
  const p = params as unknown as BrowserScreenshotParamsV2;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const tabId = session.tabId;
  const format = p.format === 'jpeg' ? 'jpeg' : 'png';
  const fullPage = p.fullPage === true;

  const metrics = (await sendCDP(tabId, 'Page.getLayoutMetrics')) as LayoutMetrics;
  const dpr = await devicePixelRatio(tabId);
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  let cssWidth = metrics.cssLayoutViewport.clientWidth;
  let cssHeight = metrics.cssLayoutViewport.clientHeight;

  if (p.uid || p.selector) {
    // Clips are page coordinates: viewport rect plus the current scroll offset.
    const target = await resolveTargetPoint(tabId, p, { scroll: true });
    const rect = target.rect ?? { x: target.x, y: target.y, width: 1, height: 1 };
    const scrolled = (await sendCDP(tabId, 'Page.getLayoutMetrics')) as LayoutMetrics;
    clip = {
      x: rect.x + scrolled.cssVisualViewport.pageX,
      y: rect.y + scrolled.cssVisualViewport.pageY,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      scale: 1,
    };
    cssWidth = clip.width;
    cssHeight = clip.height;
  } else if (fullPage) {
    clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 };
    cssWidth = clip.width;
    cssHeight = clip.height;
  }

  await overlayHooks.beforeCapture(tabId).catch(() => {});
  let data: string;
  try {
    const res = (await sendCDP(tabId, 'Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' && typeof p.quality === 'number' ? { quality: p.quality } : {}),
      captureBeyondViewport: fullPage,
      fromSurface: true,
      ...(clip ? { clip } : {}),
    })) as { data: string };
    data = res.data;
  } finally {
    await overlayHooks.afterCapture(tabId).catch(() => {});
  }

  return {
    image: `data:image/${format};base64,${data}`,
    width: Math.round(cssWidth * dpr),
    height: Math.round(cssHeight * dpr),
    cssWidth: Math.round(cssWidth),
    cssHeight: Math.round(cssHeight),
    dpr,
    mode: 'cdp',
  };
};

// ─── JavaScript ──────────────────────────────────────────────────────────────

const handleCDPExecuteJs = async (params: Record<string, unknown>): Promise<{ result: unknown; world: 'MAIN' }> => {
  const { code, args } = params as unknown as BrowserExecuteJsParamsV2;
  const session = await sessionFor(params);
  assertNoDialog(session);
  const tabId = session.tabId;
  if (typeof code !== 'string') throw new Error('Provide code');

  if (Array.isArray(args) && args.length > 0) {
    // With args, `code` is a function expression and each uid becomes a live element argument.
    const objectIds: string[] = [];
    try {
      for (const uid of args) {
        const ref = lookupUid(session, uid);
        objectIds.push(await withUidErrors(uid, () => resolveObjectId(tabId, ref.backendNodeId)));
      }
      let res: EvalResult;
      try {
        res = (await sendCDP(tabId, 'Runtime.callFunctionOn', {
          objectId: objectIds[0],
          functionDeclaration: code,
          arguments: objectIds.map(objectId => ({ objectId })),
          returnByValue: true,
          awaitPromise: true,
        })) as EvalResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/not.*function|does not evaluate/i.test(message)) {
          throw new Error('With args, code must be a function expression, e.g. (el) => el.innerText');
        }
        throw err;
      }
      return { result: unwrap(res), world: 'MAIN' };
    } finally {
      for (const objectId of objectIds) releaseObject(tabId, objectId);
    }
  }

  // Statements need a body to return from; a bare expression must stay bare so `document.title` works.
  const expression = /\b(return|await)\s/.test(code) ? `(async () => { ${code} })()` : code;
  const res = (await sendCDP(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as EvalResult;
  return { result: unwrap(res), world: 'MAIN' };
};

// ─── Network / console ───────────────────────────────────────────────────────

const summarize = (e: NetworkEntry): NetworkRequestSummary => ({
  reqid: e.reqid,
  method: e.method,
  url: e.url,
  status: e.status,
  type: e.type,
  mimeType: e.mimeType,
  size: e.size,
  durationMs: e.endedAt !== null ? Math.round((e.endedAt - e.startedAt) * 1000) : null,
  failed: e.failed,
  fromCache: e.fromCache,
});

const handleListNetworkRequests = async (
  params: Record<string, unknown>,
): Promise<BrowserListNetworkRequestsResult> => {
  const { pageSize, pageIdx, resourceTypes } = params as BrowserListNetworkRequestsParams;
  const session = await sessionForCapture(params, 'Network capture');
  const wanted = Array.isArray(resourceTypes) ? resourceTypes.map(t => String(t).toLowerCase()) : [];
  const filtered = wanted.length > 0 ? session.network.filter(e => wanted.includes(e.type)) : session.network;
  const { items, total, page } = paginate(filtered, pageSize, pageIdx);
  return { requests: items.map(summarize), total, page };
};

const handleGetNetworkRequest = async (params: Record<string, unknown>): Promise<BrowserGetNetworkRequestResult> => {
  const { reqid, includeBody } = params as unknown as BrowserGetNetworkRequestParams;
  const session = await sessionForCapture(params, 'Network capture');
  const entry = session.network.find(e => e.reqid === reqid);
  if (!entry) {
    throw new Error(
      `Network request ${reqid} is not in the capture buffer. Call ext_list_network_requests for current ids.`,
    );
  }
  const request = {
    method: entry.method,
    url: entry.url,
    headers: entry.headers,
    ...(entry.postData !== undefined ? { postData: entry.postData } : {}),
  };
  if (!entry.hasResponse || entry.status === null) return { request, response: null };

  const response: NonNullable<BrowserGetNetworkRequestResult['response']> = {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.responseHeaders,
    mimeType: entry.mimeType,
  };
  if (includeBody !== false) {
    try {
      const body = (await sendCDP(session.tabId, 'Network.getResponseBody', { requestId: entry.requestId })) as {
        body: string;
        base64Encoded: boolean;
      };
      response.bodyTruncated = body.body.length > NETWORK_BODY_MAX_CHARS;
      response.body = response.bodyTruncated ? body.body.slice(0, NETWORK_BODY_MAX_CHARS) : body.body;
      response.base64Encoded = body.base64Encoded;
    } catch {
      // Bodies are evicted from Chrome's cache quickly; the headers are still worth returning.
      response.bodyTruncated = false;
    }
  }
  return { request, response };
};

const handleListConsoleMessages = async (
  params: Record<string, unknown>,
): Promise<BrowserListConsoleMessagesResult> => {
  const { pageSize, pageIdx, types, includeStackTraces } = params as BrowserListConsoleMessagesParams;
  const session = await sessionForCapture(params, 'Console capture');
  const wanted = Array.isArray(types) ? types.map(t => String(t).toLowerCase()) : [];
  const filtered = wanted.length > 0 ? session.console.filter(m => wanted.includes(m.type)) : session.console;
  const { items, total, page } = paginate(filtered, pageSize, pageIdx);
  // Stack traces are long and usually noise; the caller opts in.
  const messages = items.map(m => {
    if (includeStackTraces) return { ...m };
    const copy = { ...m };
    delete copy.stack;
    return copy;
  });
  return { messages, total, page };
};

// ─── Dialogs ─────────────────────────────────────────────────────────────────

const handleHandleDialog = async (params: Record<string, unknown>): Promise<BrowserHandleDialogResult> => {
  const { action, promptText } = params as unknown as BrowserHandleDialogParams;
  const session = await sessionForCapture(params, 'Dialog handling');
  if (action !== 'accept' && action !== 'dismiss') throw new Error('action must be "accept" or "dismiss".');
  const dialog = session.dialog;
  try {
    await sendCDP(session.tabId, 'Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...(typeof promptText === 'string' ? { promptText } : {}),
    });
  } catch (err) {
    // "No dialog is showing" with nothing latched is the honest no-op; anything else is real.
    if (!dialog) return { success: true, handled: null };
    throw err;
  }
  session.dialog = null;
  return { success: true, handled: dialog ? { type: dialog.type, message: dialog.message } : null };
};

// ─── Emulation ───────────────────────────────────────────────────────────────

interface ViewportSpec {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  landscape: boolean;
}

const parseViewport = (spec: string): ViewportSpec | null => {
  const [size, ...flags] = spec.split(',').map(s => s.trim().toLowerCase());
  const m = /^(\d+)x(\d+)(?:x(\d+(?:\.\d+)?))?$/.exec(size ?? '');
  if (!m) return null;
  const known = new Set(['mobile', 'touch', 'landscape']);
  if (flags.some(f => !known.has(f))) return null;
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    dpr: m[3] ? Number(m[3]) : 0,
    mobile: flags.includes('mobile'),
    touch: flags.includes('touch'),
    landscape: flags.includes('landscape'),
  };
};

const kbps = (n: number): number => (n * 1000) / 8;
const mbps = (n: number): number => (n * 1_000_000) / 8;

const NETWORK_CONDITIONS: Record<
  NetworkConditionName,
  { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  Offline: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  'Slow 3G': { offline: false, latency: 400, downloadThroughput: kbps(500), uploadThroughput: kbps(500) },
  'Fast 3G': { offline: false, latency: 150, downloadThroughput: mbps(1.6), uploadThroughput: kbps(750) },
  'Slow 4G': { offline: false, latency: 150, downloadThroughput: mbps(4), uploadThroughput: mbps(3) },
  'Fast 4G': { offline: false, latency: 40, downloadThroughput: mbps(20), uploadThroughput: mbps(10) },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

const applyViewport = async (session: Session, viewport: string): Promise<void> => {
  const tabId = session.tabId;
  if (viewport === '') {
    await sendCDP(tabId, 'Emulation.clearDeviceMetricsOverride');
    await sendCDP(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    delete session.emulation.viewport;
    return;
  }
  const v = parseViewport(viewport);
  if (!v) {
    throw new Error(
      `Invalid viewport "${viewport}". Use WxH or WxHxDPR with optional ",mobile", ",touch", ",landscape" (e.g. 390x844x3,mobile,touch).`,
    );
  }
  await sendCDP(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: v.width,
    height: v.height,
    deviceScaleFactor: v.dpr,
    mobile: v.mobile,
    screenOrientation: v.landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
  });
  await sendCDP(tabId, 'Emulation.setTouchEmulationEnabled', {
    enabled: v.touch,
    ...(v.touch ? { maxTouchPoints: 5 } : {}),
  });
  session.emulation.viewport = viewport;
};

const applyGeolocation = async (session: Session, geolocation: string): Promise<void> => {
  const tabId = session.tabId;
  if (geolocation === '') {
    await sendCDP(tabId, 'Emulation.clearGeolocationOverride');
    delete session.emulation.geolocation;
    return;
  }
  const [lat, lng] = geolocation.split(',').map(s => Number(s.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid geolocation "${geolocation}". Use "lat,lng".`);
  }
  await sendCDP(tabId, 'Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: 1 });
  session.emulation.geolocation = geolocation;
};

const handleEmulate = async (params: Record<string, unknown>): Promise<BrowserEmulateResult> => {
  const p = params as BrowserEmulateParams;
  const session = await sessionForCapture(params, 'Emulation');
  const tabId = session.tabId;
  const state: EmulationState = session.emulation;

  if (typeof p.viewport === 'string') await applyViewport(session, p.viewport);

  if (typeof p.userAgent === 'string') {
    // An empty override string turns the override off in Chrome's emulation handler.
    await sendCDP(tabId, 'Emulation.setUserAgentOverride', { userAgent: p.userAgent });
    if (p.userAgent === '') delete state.userAgent;
    else state.userAgent = p.userAgent;
  }

  if (p.colorScheme !== undefined) {
    const value = p.colorScheme === 'dark' || p.colorScheme === 'light' ? p.colorScheme : '';
    await sendCDP(tabId, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    if (value === '') delete state.colorScheme;
    else state.colorScheme = value;
  }

  if (typeof p.geolocation === 'string') await applyGeolocation(session, p.geolocation);

  if (p.networkConditions !== undefined) {
    const conditions = NETWORK_CONDITIONS[p.networkConditions];
    if (!conditions) {
      throw new Error(
        `Unknown networkConditions "${p.networkConditions}". Use Offline, Slow 3G, Fast 3G, Slow 4G, Fast 4G or none.`,
      );
    }
    await sendCDP(tabId, 'Network.emulateNetworkConditions', conditions);
    if (p.networkConditions === 'none') delete state.networkConditions;
    else state.networkConditions = p.networkConditions;
  }

  if (typeof p.cpuThrottlingRate === 'number') {
    const rate = Math.max(1, p.cpuThrottlingRate);
    await sendCDP(tabId, 'Emulation.setCPUThrottlingRate', { rate });
    if (rate === 1) delete state.cpuThrottlingRate;
    else state.cpuThrottlingRate = rate;
  }

  return { success: true, state: { ...state } };
};

// ─── Coordinate mouse handlers ───────────────────────────────────────────────
//
// With a session on the resolved tab these emit trusted `Input.dispatchMouseEvent`
// input; otherwise they fall back to synthetic events dispatched in the page
// (functional, but `isTrusted: false`). Each accepts a uid or selector
// (resolved to the element's centre) OR explicit x/y viewport coordinates —
// the latter is what makes canvas, maps and SVG clickable.

/** Synthetic fallback. Runs in MAIN so the events reach the site's own listeners. */
const fallbackMouse = async (
  tabId: number,
  x: number,
  y: number,
  kind: 'click' | 'dblclick' | 'down' | 'up' | 'contextmenu',
  button: string,
): Promise<void> => {
  await api.scripting.executeScript({
    target: { tabId },
    func: (px: number, py: number, k: string, btn: string) => {
      const buttonNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
      const el = document.elementsFromPoint(px, py).find(e => !e.closest('wolffish-overlay')) ?? document.body;
      const fire = (type: string): void => {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: px,
            clientY: py,
            button: buttonNum,
            view: window,
          }),
        );
      };
      if (k === 'down') return fire('mousedown');
      if (k === 'up') return fire('mouseup');
      if (k === 'contextmenu') {
        fire('mousedown');
        fire('mouseup');
        return fire('contextmenu');
      }
      fire('mousedown');
      fire('mouseup');
      fire('click');
      if (k === 'dblclick') {
        fire('mousedown');
        fire('mouseup');
        fire('click');
        fire('dblclick');
      }
    },
    args: [x, y, kind, button],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });
};

const handleMouseMove = async (params: Record<string, unknown>): Promise<BrowserMouseMoveResult> => {
  const { x, y } = params as unknown as BrowserMouseMoveParams;
  const tabId = await tabOf(params);
  const session = getSession(tabId);
  if (!session) {
    virtualCursor.set(tabId, { x, y });
    postCursor(tabId, x, y, true);
    return { success: true };
  }
  assertNoDialog(session);
  await cdpMove(session, x, y);
  return { success: true };
};

const handleMouseClick = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseClickParams & ElementTarget;
  const button: MouseButton = p.button ?? 'left';
  const double = p.double ?? false;
  const tabId = await tabOf(params);
  const session = getSession(tabId);

  if (session) {
    assertNoDialog(session);
    const { x, y } = await resolveTargetPoint(tabId, p, { scroll: true });
    await sleep(gaussianDelay(50, 150));
    await cdpMove(session, x, y);
    await cdpClick(session, x, y, button, double);
    return { success: true, x, y, trusted: true };
  }

  const { x, y } = await resolveTargetPoint(tabId, p, { scroll: true });
  const kind = button === 'right' ? 'contextmenu' : double ? 'dblclick' : 'click';
  await fallbackMouse(tabId, x, y, kind, button);
  virtualCursor.set(tabId, { x, y });
  postCursor(tabId, x, y, true);
  return { success: true, x, y, trusted: false };
};

const handleMouseDown = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseButtonParams & ElementTarget;
  const button: MouseButton = p.button ?? 'left';
  const tabId = await tabOf(params);
  const session = getSession(tabId);

  if (session) {
    assertNoDialog(session);
    const { x, y } = await resolveTargetPoint(tabId, p, { scroll: true });
    await cdpMove(session, x, y);
    await cdpPress(session, x, y, button, 1);
    return { success: true, x, y, trusted: true };
  }

  const { x, y } = await resolveTargetPoint(tabId, p, { scroll: true });
  await fallbackMouse(tabId, x, y, 'down', button);
  virtualCursor.set(tabId, { x, y });
  postCursor(tabId, x, y, true);
  return { success: true, x, y, trusted: false };
};

const handleMouseUp = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseButtonParams & ElementTarget;
  const button: MouseButton = p.button ?? 'left';
  const tabId = await tabOf(params);
  const session = getSession(tabId);

  if (session) {
    assertNoDialog(session);
    const { x, y } = await resolveTargetPoint(tabId, p, { scroll: false });
    await cdpRelease(session, x, y, button, 1);
    session.cursor = { x, y };
    return { success: true, x, y, trusted: true };
  }

  const { x, y } = await resolveTargetPoint(tabId, p, { scroll: false });
  await fallbackMouse(tabId, x, y, 'up', button);
  virtualCursor.set(tabId, { x, y });
  return { success: true, x, y, trusted: false };
};

/**
 * Press at the source, glide to the target with the button held, release.
 * In debugger mode this is a real coordinate drag (the canonical CDP recipe
 * used by Playwright/Puppeteer) — far more reliable than the synthetic HTML5
 * DragEvent path of ext_drag_drop, which most modern apps ignore.
 */
const handleMouseDrag = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseDragParamsV2;
  const tabId = await tabOf(params);
  const session = getSession(tabId);
  const missingError = 'Drag requires from_uid/to_uid, sourceSelector/targetSelector, or startX/startY and endX/endY';

  const start = await resolveTargetPoint(
    tabId,
    { uid: p.from_uid, selector: p.sourceSelector, x: p.startX, y: p.startY },
    { scroll: true, missingError },
  );
  const end = await resolveTargetPoint(
    tabId,
    { uid: p.to_uid, selector: p.targetSelector, x: p.endX, y: p.endY },
    { scroll: true, missingError },
  );

  if (session) {
    assertNoDialog(session);
    await cdpMove(session, start.x, start.y);
    await cdpPress(session, start.x, start.y, 'left', 1);
    await sleep(gaussianDelay(60, 140));
    await cdpMove(session, end.x, end.y, true);
    await sleep(gaussianDelay(60, 140));
    await cdpRelease(session, end.x, end.y, 'left', 1);
    return { success: true, x: end.x, y: end.y, trusted: true };
  }

  await api.scripting.executeScript({
    target: { tabId },
    func: (sx: number, sy: number, ex: number, ey: number) => {
      const pick = (x: number, y: number): Element =>
        document.elementsFromPoint(x, y).find(e => !e.closest('wolffish-overlay')) ?? document.body;
      const src = pick(sx, sy);
      const tgt = pick(ex, ey);
      const fire = (type: string, x: number, y: number, el: Element): void => {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }),
        );
      };
      fire('mousedown', sx, sy, src);
      fire('mousemove', Math.round((sx + ex) / 2), Math.round((sy + ey) / 2), tgt);
      fire('mousemove', ex, ey, tgt);
      fire('mouseup', ex, ey, tgt);
    },
    args: [start.x, start.y, end.x, end.y],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });
  virtualCursor.set(tabId, { x: end.x, y: end.y });
  postCursor(tabId, end.x, end.y, true);
  return { success: true, x: end.x, y: end.y, trusted: false };
};

export type { ResolvedTarget, TargetSpec };
export {
  attachTab,
  detachTab,
  dialogOpenError,
  getCursorPosition,
  getDebuggerState,
  getSession,
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
  handleDebuggerAttach,
  handleDebuggerDetach,
  handleDebuggerStatus,
  handleEmulate,
  handleGetNetworkRequest,
  handleHandleDialog,
  handleListConsoleMessages,
  handleListNetworkRequests,
  handleMouseClick,
  handleMouseDown,
  handleMouseDrag,
  handleMouseMove,
  handleMouseUp,
  hasSession,
  isRestrictedUrl,
  overlayHooks,
  resolveTargetPoint,
  resolveTargetPoint as resolveTarget,
  sessionsReady,
};
