import { log } from '@extension/shared';
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

  const result = await api.scripting.executeScript({
    target: { tabId },
    func: (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    },
    args: [selector],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const coords = result[0]?.result as { x: number; y: number } | null;
  if (!coords) throw new Error(`Element not found: ${selector}`);

  await sleep(gaussianDelay(50, 150));

  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(cursorX, cursorY, coords.x, coords.y, steps);
  for (const point of path) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await sleep(gaussianDelay(5, 15));
  }

  cursorX = coords.x;
  cursorY = coords.y;

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });

  await sleep(gaussianDelay(30, 80));

  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });

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

  const result = await api.scripting.executeScript({
    target: { tabId },
    func: (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    },
    args: [selector],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const coords = result[0]?.result as { x: number; y: number } | null;
  if (!coords) throw new Error(`Element not found: ${selector}`);

  await sleep(100);

  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(cursorX, cursorY, coords.x, coords.y, steps);
  for (const point of path) {
    await sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await sleep(gaussianDelay(5, 15));
  }

  cursorX = coords.x;
  cursorY = coords.y;

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

export { getDebuggerState, getCursorPosition };
