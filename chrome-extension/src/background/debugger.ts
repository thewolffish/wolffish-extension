import { log, resolveTabId } from '@extension/shared';
import type {
  DebuggerAttachParams,
  DebuggerAttachResult,
  DebuggerDetachResult,
  DebuggerStatusResult,
  BrowserClickParams,
  BrowserTypeParams,
  BrowserHoverParams,
  BrowserKeypressParams,
  BrowserMouseMoveParams,
  BrowserMouseMoveResult,
  BrowserMouseClickParams,
  BrowserMouseButtonParams,
  BrowserMouseDragParams,
  BrowserMouseActionResult,
} from '@extension/shared';
import { gaussianDelay, sleep } from './gaussian.js';

const api = globalThis.chrome;

// ─── State ─────────────────────────────────────────────────────────────────

let attachedTabId: number | null = null;
let isAttached = false;

const resetState = (): void => {
  attachedTabId = null;
  isAttached = false;
};

const getDebuggerState = (): { attached: boolean; tabId: number | null } => ({
  attached: isAttached,
  tabId: attachedTabId,
});

// ─── CDP Helpers ───────────────────────────────────────────────────────────

const sendCDP = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
  if (!isAttached || attachedTabId === null) {
    throw new Error('Debugger not attached');
  }
  return api.debugger.sendCommand({ tabId: attachedTabId }, method, params);
};

// ─── Bezier Cursor Path ────────────────────────────────────────────────────

const generateBezierPath = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  steps: number,
): { x: number; y: number }[] => {
  const cpx1 = x0 + (x1 - x0) * 0.25 + (Math.random() - 0.5) * Math.abs(x1 - x0) * 0.3;
  const cpy1 = y0 + (y1 - y0) * 0.25 + (Math.random() - 0.5) * Math.abs(y1 - y0) * 0.3;
  const cpx2 = x0 + (x1 - x0) * 0.75 + (Math.random() - 0.5) * Math.abs(x1 - x0) * 0.3;
  const cpy2 = y0 + (y1 - y0) * 0.75 + (Math.random() - 0.5) * Math.abs(y1 - y0) * 0.3;

  const points: { x: number; y: number }[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * cpx1 + 3 * u * t * t * cpx2 + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * cpy1 + 3 * u * t * t * cpy2 + t * t * t * y1;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
};

// ─── Cursor Position Tracking ──────────────────────────────────────────────

let cursorX = 0;
let cursorY = 0;

const getCursorPosition = (): { x: number; y: number } => ({ x: cursorX, y: cursorY });

// ─── Selector → Coordinate Resolver ──────────────────────────────────────────
//
// `text=`-aware so selector behaviour in debugger mode matches the
// content-script path. The CDP handlers used to call `document.querySelector`
// directly, so `text=<visible text>` selectors (supported everywhere else)
// silently failed once the debugger was attached — a footgun now that the
// agent is told to attach for nearly everything. Mirrors the content
// script's findByText/querySelectorSafe: deepest visible match, exact beats
// substring; invalid CSS surfaces a deterministic validation message.

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 };

const resolveElementCoords = async (
  tabId: number,
  selector: string,
  opts: { scroll?: boolean } = {},
): Promise<{ x: number; y: number; href: string | null }> => {
  const result = await api.scripting.executeScript({
    target: { tabId },
    func: (sel: string, scroll: boolean) => {
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
          const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
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
      if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = el.getBoundingClientRect();
      const anchor = el.closest('a');
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        href: anchor?.href || null,
      };
    },
    args: [selector, opts.scroll ?? false],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const info = result[0]?.result as { x: number; y: number; href: string | null } | { error: string } | null;
  if (info && 'error' in info) throw new Error(info.error);
  if (!info) throw new Error(`Element not found: ${selector}`);
  return info;
};

/** Resolve a click target from either a selector or explicit x/y coordinates. */
const resolveTarget = async (
  tabId: number,
  params: { x?: number; y?: number; selector?: string },
  opts: { scroll?: boolean } = {},
): Promise<{ x: number; y: number; href: string | null }> => {
  if (params.selector) return resolveElementCoords(tabId, params.selector, opts);
  if (typeof params.x === 'number' && typeof params.y === 'number') {
    return { x: params.x, y: params.y, href: null };
  }
  throw new Error('Provide either a selector or x/y coordinates');
};

// ─── CDP Mouse Primitives ────────────────────────────────────────────────────

/** Glide the cursor to (x, y) along a bezier path. `dragging` holds the left button down. */
const cdpMove = async (x: number, y: number, dragging = false): Promise<void> => {
  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(cursorX, cursorY, x, y, steps);
  for (const point of path) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      ...(dragging ? { button: 'left', buttons: 1 } : {}),
    });
    await sleep(gaussianDelay(5, 15));
  }
  cursorX = x;
  cursorY = y;
};

const cdpPress = (x: number, y: number, button: string, clickCount = 1): Promise<unknown> =>
  sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons: BUTTON_MASK[button] ?? 1,
    clickCount,
  });

const cdpRelease = (x: number, y: number, button: string, clickCount = 1): Promise<unknown> =>
  sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount,
  });

/**
 * Non-debugger fallback: dispatch synthetic mouse events at the point in the
 * page. Functional (page handlers fire) but `isTrusted: false` — which is
 * exactly why debugger mode is preferred. Runs in MAIN so the events reach
 * the site's own listeners.
 */
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
      const el = document.elementFromPoint(px, py) ?? document.body;
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

// ─── Event Listeners ───────────────────────────────────────────────────────

api.debugger.onDetach.addListener((source: chrome.debugger.Debuggee, reason: string) => {
  if (source.tabId === attachedTabId) {
    log(`Debugger detached from tab ${source.tabId}: ${reason}`);
    resetState();
  }
});

api.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId === attachedTabId) {
    log(`Attached tab ${tabId} was closed`);
    resetState();
  }
});

// ─── Debugger Commands ─────────────────────────────────────────────────────

export const handleDebuggerAttach = async (params: Record<string, unknown>): Promise<DebuggerAttachResult> => {
  const { tabId } = params as unknown as DebuggerAttachParams;

  if (isAttached && attachedTabId === tabId) {
    return { success: true, tabId };
  }

  if (isAttached && attachedTabId !== null) {
    try {
      await api.debugger.detach({ tabId: attachedTabId });
    } catch {
      // Already detached
    }
    resetState();
  }

  try {
    await api.debugger.attach({ tabId }, '1.3');
    attachedTabId = tabId;
    isAttached = true;
    log(`Debugger attached to tab ${tabId}`);
    return { success: true, tabId };
  } catch (err) {
    resetState();
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('Cannot access') || message.includes('chrome://') || message.includes('chrome-extension://')) {
      throw new Error(`Cannot attach debugger to restricted page (chrome://, chrome-extension://, etc.)`);
    }
    if (message.includes('Another debugger')) {
      throw new Error(`Cannot attach debugger: DevTools or another debugger is already attached to this tab`);
    }
    throw new Error(`Failed to attach debugger: ${message}`);
  }
};

export const handleDebuggerDetach = async (): Promise<DebuggerDetachResult> => {
  if (!isAttached || attachedTabId === null) {
    return { success: true };
  }

  try {
    await api.debugger.detach({ tabId: attachedTabId });
  } catch {
    // Already detached
  }

  log(`Debugger detached from tab ${attachedTabId}`);
  resetState();
  return { success: true };
};

export const handleDebuggerStatus = async (): Promise<DebuggerStatusResult> => ({
  attached: isAttached,
  tabId: attachedTabId,
});

// ─── CDP Interaction Handlers ──────────────────────────────────────────────

export const handleCDPClick = async (
  params: Record<string, unknown>,
): Promise<{ success: boolean; elementFound: boolean }> => {
  const { selector } = params as unknown as BrowserClickParams;
  const tabId = attachedTabId!;

  const info = await resolveElementCoords(tabId, selector, { scroll: true });

  await sleep(gaussianDelay(50, 150));

  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(cursorX, cursorY, info.x, info.y, steps);
  for (const point of path) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await sleep(gaussianDelay(5, 15));
  }

  cursorX = info.x;
  cursorY = info.y;

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1,
  });

  await sleep(gaussianDelay(30, 80));

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: info.x,
    y: info.y,
    button: 'left',
    clickCount: 1,
  });

  // Fallback: if the clicked element is inside an <a> with href,
  // dispatch a real DOM click to ensure navigation triggers. The
  // querySelector is guarded because `selector` may be a `text=` form
  // (invalid CSS) — in that case the trusted click above already landed,
  // so skipping this belt-and-suspenders re-click is fine.
  if (info.href) {
    await sleep(200);
    await api.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        let el: Element | null = null;
        try {
          el = document.querySelector(sel);
        } catch {
          el = null;
        }
        const anchor = el?.closest('a');
        if (anchor) anchor.click();
      },
      args: [selector],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });
  }

  return { success: true, elementFound: true };
};

export const handleCDPType = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { selector, text, clearFirst } = params as unknown as BrowserTypeParams;
  const tabId = attachedTabId!;

  await api.scripting.executeScript({
    target: { tabId },
    func: (sel: string, clear: boolean) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.focus();
      if (clear) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          (el as HTMLInputElement).value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
        }
      }
    },
    args: [selector, clearFirst ?? false],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  for (const char of text) {
    const keyCode = char.charCodeAt(0);
    const key = char;
    const code =
      char.length === 1 && char >= 'a' && char <= 'z'
        ? `Key${char.toUpperCase()}`
        : char.length === 1 && char >= 'A' && char <= 'Z'
          ? `Key${char}`
          : char.length === 1 && char >= '0' && char <= '9'
            ? `Digit${char}`
            : char === ' '
              ? 'Space'
              : '';

    await sendCDP('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });

    await sendCDP('Input.dispatchKeyEvent', {
      type: 'char',
      text: char,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });

    await sendCDP('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });

    await sleep(gaussianDelay(40, 120, 70));
  }

  return { success: true };
};

export const handleCDPScroll = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { direction, amount, selector } = params as unknown as {
    direction: string;
    amount?: number;
    selector?: string;
  };

  if (selector) {
    const tabId = attachedTabId!;
    const result = await api.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      },
      args: [selector],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const coords = result[0]?.result as { x: number; y: number } | null;
    if (coords) {
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: coords.x,
        y: coords.y,
        deltaX: 0,
        deltaY: 0,
      });
      return { success: true };
    }
  }

  const delta = amount ?? 300;
  const scrollMap: Record<string, [number, number]> = {
    up: [0, -delta],
    down: [0, delta],
    left: [-delta, 0],
    right: [delta, 0],
  };
  const [deltaX, deltaY] = scrollMap[direction] ?? [0, 0];

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: cursorX || 400,
    y: cursorY || 400,
    deltaX,
    deltaY,
  });

  await sleep(gaussianDelay(50, 150));

  return { success: true };
};

export const handleCDPHover = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { selector } = params as unknown as BrowserHoverParams;
  const tabId = attachedTabId!;

  const coords = await resolveElementCoords(tabId, selector, { scroll: true });

  await sleep(100);
  await cdpMove(coords.x, coords.y);

  return { success: true };
};

export const handleCDPKeypress = async (params: Record<string, unknown>): Promise<{ success: boolean }> => {
  const { key, modifiers } = params as unknown as BrowserKeypressParams;
  const mods = modifiers ?? [];

  const modifierFlags: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  let modifierBitmask = 0;
  for (const mod of mods) {
    modifierBitmask |= modifierFlags[mod] ?? 0;
  }

  const specialKeys: Record<string, { code: string; keyCode: number }> = {
    Enter: { code: 'Enter', keyCode: 13 },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Space: { code: 'Space', keyCode: 32 },
  };

  const special = specialKeys[key];
  const code = special?.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  const keyCode = special?.keyCode ?? key.charCodeAt(0);

  await sendCDP('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: modifierBitmask,
  });

  if (key.length === 1) {
    await sendCDP('Input.dispatchKeyEvent', {
      type: 'char',
      text: key,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: modifierBitmask,
    });
  }

  await sendCDP('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers: modifierBitmask,
  });

  return { success: true };
};

export const handleMouseMove = async (params: Record<string, unknown>): Promise<BrowserMouseMoveResult> => {
  const { x, y } = params as unknown as BrowserMouseMoveParams;

  if (!isAttached) {
    cursorX = x;
    cursorY = y;
    return { success: true };
  }

  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(cursorX, cursorY, x, y, steps);

  for (const point of path) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await sleep(gaussianDelay(5, 15));
  }

  cursorX = x;
  cursorY = y;

  return { success: true };
};

// ─── Coordinate Mouse Handlers ───────────────────────────────────────────────
//
// Like handleMouseMove, these are service-worker handlers that branch on the
// debugger state rather than CDP-routable content commands. With the debugger
// attached they emit trusted `Input.dispatchMouseEvent` input (isTrusted:
// true); otherwise they fall back to synthetic events dispatched in the page.
// Each accepts a `selector` (resolved to the element's centre) OR explicit
// x/y viewport coordinates — the latter is what makes canvas, maps, SVG and
// other non-DOM surfaces clickable.

export const handleMouseClick = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseClickParams;
  const button = p.button ?? 'left';
  const double = p.double ?? false;

  if (isAttached && attachedTabId !== null) {
    const { x, y } = await resolveTarget(attachedTabId, p, { scroll: true });
    await sleep(gaussianDelay(50, 150));
    await cdpMove(x, y);
    await cdpPress(x, y, button, 1);
    await sleep(gaussianDelay(30, 80));
    await cdpRelease(x, y, button, 1);
    if (double) {
      await sleep(gaussianDelay(40, 90));
      await cdpPress(x, y, button, 2);
      await sleep(gaussianDelay(30, 80));
      await cdpRelease(x, y, button, 2);
    }
    return { success: true, x, y, trusted: true };
  }

  const tabId = await resolveTabId(p as { tabId?: number });
  const { x, y } = await resolveTarget(tabId, p, { scroll: true });
  const kind = button === 'right' ? 'contextmenu' : double ? 'dblclick' : 'click';
  await fallbackMouse(tabId, x, y, kind, button);
  return { success: true, x, y, trusted: false };
};

export const handleMouseDown = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseButtonParams;
  const button = p.button ?? 'left';

  if (isAttached && attachedTabId !== null) {
    const { x, y } = await resolveTarget(attachedTabId, p, { scroll: true });
    await cdpMove(x, y);
    await cdpPress(x, y, button, 1);
    return { success: true, x, y, trusted: true };
  }

  const tabId = await resolveTabId(p as { tabId?: number });
  const { x, y } = await resolveTarget(tabId, p, { scroll: true });
  await fallbackMouse(tabId, x, y, 'down', button);
  return { success: true, x, y, trusted: false };
};

export const handleMouseUp = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseButtonParams;
  const button = p.button ?? 'left';

  if (isAttached && attachedTabId !== null) {
    const { x, y } = await resolveTarget(attachedTabId, p, { scroll: false });
    await cdpRelease(x, y, button, 1);
    return { success: true, x, y, trusted: true };
  }

  const tabId = await resolveTabId(p as { tabId?: number });
  const { x, y } = await resolveTarget(tabId, p, { scroll: false });
  await fallbackMouse(tabId, x, y, 'up', button);
  return { success: true, x, y, trusted: false };
};

/**
 * Press at the source, glide to the target with the button held, release.
 * In debugger mode this is a real coordinate drag (the canonical CDP recipe
 * used by Playwright/Puppeteer) — far more reliable than the synthetic
 * HTML5 DragEvent path of ext_drag_drop, which most modern apps (canvas,
 * react-dnd, sliders) ignore.
 */
export const handleMouseDrag = async (params: Record<string, unknown>): Promise<BrowserMouseActionResult> => {
  const p = params as unknown as BrowserMouseDragParams;

  const point = async (
    tabId: number,
    selector: string | undefined,
    x: number | undefined,
    y: number | undefined,
  ): Promise<{ x: number; y: number }> => {
    if (selector) return resolveElementCoords(tabId, selector, { scroll: true });
    if (typeof x === 'number' && typeof y === 'number') return { x, y };
    throw new Error('Drag requires sourceSelector/targetSelector or startX/startY and endX/endY');
  };

  if (isAttached && attachedTabId !== null) {
    const tabId = attachedTabId;
    const start = await point(tabId, p.sourceSelector, p.startX, p.startY);
    const end = await point(tabId, p.targetSelector, p.endX, p.endY);
    await cdpMove(start.x, start.y);
    await cdpPress(start.x, start.y, 'left', 1);
    await sleep(gaussianDelay(60, 140));
    await cdpMove(end.x, end.y, true);
    await sleep(gaussianDelay(60, 140));
    await cdpRelease(end.x, end.y, 'left', 1);
    return { success: true, x: end.x, y: end.y, trusted: true };
  }

  const tabId = await resolveTabId(p as { tabId?: number });
  const start = await point(tabId, p.sourceSelector, p.startX, p.startY);
  const end = await point(tabId, p.targetSelector, p.endX, p.endY);
  await api.scripting.executeScript({
    target: { tabId },
    func: (sx: number, sy: number, ex: number, ey: number) => {
      const src = document.elementFromPoint(sx, sy) ?? document.body;
      const tgt = document.elementFromPoint(ex, ey) ?? document.body;
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
  return { success: true, x: end.x, y: end.y, trusted: false };
};

export { getDebuggerState, getCursorPosition };
