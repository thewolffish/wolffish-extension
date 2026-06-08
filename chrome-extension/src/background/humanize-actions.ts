import type { HumanizeIntensity, HumanizeResult } from '@extension/shared';
import { log, resolveTabId } from '@extension/shared';
import { getCursorPosition, getDebuggerState, handleMouseMove } from './debugger.js';
import { gaussianDelay, sleep } from './gaussian.js';

const api = globalThis.chrome;

// ─── CDP Helper ────────────────────────────────────────────────────────────

const sendCDP = async (tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  api.debugger.sendCommand({ tabId }, method, params);

// ─── Inert Element Finder ──────────────────────────────────────────────────

const findInertElement = async (tabId: number): Promise<{ x: number; y: number } | null> => {
  const result = await api.scripting.executeScript({
    target: { tabId },
    func: () => {
      const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'DETAILS', 'SUMMARY']);
      const candidates: { x: number; y: number }[] = [];
      const elements = document.querySelectorAll('div, span, p, section, article, li, td, th, h1, h2, h3, h4, h5, h6');

      for (let i = 0; i < elements.length && candidates.length < 30; i++) {
        const el = elements[i] as HTMLElement;
        const rect = el.getBoundingClientRect();

        if (rect.width < 10 || rect.height < 10) continue;
        if (rect.top < 0 || rect.left < 0) continue;
        if (rect.bottom > window.innerHeight || rect.right > window.innerWidth) continue;

        if (interactiveTags.has(el.tagName)) continue;
        if (el.closest('a, button, input, select, textarea, label')) continue;
        if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') continue;
        if (el.onclick || el.getAttribute('onclick')) continue;

        candidates.push({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
      }

      if (candidates.length === 0) return null;
      return candidates[Math.floor(Math.random() * candidates.length)];
    },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  return result[0]?.result as { x: number; y: number } | null;
};

// ─── Micro-Actions ─────────────────────────────────────────────────────────

type MicroAction = {
  name: string;
  execute: (tabId: number) => Promise<number>;
};

const actionRandomPause: MicroAction = {
  name: 'random_pause',
  execute: async () => {
    const duration = gaussianDelay(800, 2000);
    await sleep(duration);
    return duration;
  },
};

const actionMicroScroll: MicroAction = {
  name: 'micro_scroll',
  execute: async (tabId: number) => {
    const { attached } = getDebuggerState();
    const delta = gaussianDelay(20, 60);
    const direction = Math.random() > 0.5 ? 1 : -1;
    const start = performance.now();

    if (attached) {
      const cursor = getCursorPosition();
      await sendCDP(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: cursor.x || 400,
        y: cursor.y || 400,
        deltaX: 0,
        deltaY: delta * direction,
      });
      await sleep(gaussianDelay(200, 500));

      if (Math.random() > 0.4) {
        await sendCDP(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: cursor.x || 400,
          y: cursor.y || 400,
          deltaX: 0,
          deltaY: -delta * direction,
        });
      }
    } else {
      await api.scripting.executeScript({
        target: { tabId },
        func: (d: number, dir: number) => {
          window.scrollBy({ left: 0, top: d * dir, behavior: 'smooth' });
        },
        args: [delta, direction],
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
      });
      await sleep(gaussianDelay(200, 500));
    }

    return Math.round(performance.now() - start);
  },
};

const actionCursorMove: MicroAction = {
  name: 'cursor_move',
  execute: async (tabId: number) => {
    const start = performance.now();
    const coords = await findInertElement(tabId);

    if (!coords) {
      await sleep(gaussianDelay(500, 1000));
      return Math.round(performance.now() - start);
    }

    await handleMouseMove({ x: coords.x, y: coords.y } as Record<string, unknown>);
    return Math.round(performance.now() - start);
  },
};

const actionHoverInert: MicroAction = {
  name: 'hover_inert',
  execute: async (tabId: number) => {
    const start = performance.now();
    const coords = await findInertElement(tabId);

    if (!coords) {
      await sleep(gaussianDelay(300, 800));
      return Math.round(performance.now() - start);
    }

    await handleMouseMove({ x: coords.x, y: coords.y } as Record<string, unknown>);
    await sleep(gaussianDelay(300, 800));
    return Math.round(performance.now() - start);
  },
};

const actionVariableScroll: MicroAction = {
  name: 'variable_scroll',
  execute: async (tabId: number) => {
    const { attached } = getDebuggerState();
    const start = performance.now();
    const steps = gaussianDelay(2, 4);

    for (let i = 0; i < steps; i++) {
      const delta = gaussianDelay(15, 40);

      if (attached) {
        const cursor = getCursorPosition();
        await sendCDP(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: cursor.x || 400,
          y: cursor.y || 400,
          deltaX: 0,
          deltaY: delta,
        });
      } else {
        await api.scripting.executeScript({
          target: { tabId },
          func: (d: number) => window.scrollBy({ left: 0, top: d, behavior: 'smooth' }),
          args: [delta],
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
        });
      }

      await sleep(gaussianDelay(100, 300));
    }

    return Math.round(performance.now() - start);
  },
};

const actionScrollBounce: MicroAction = {
  name: 'scroll_bounce',
  execute: async (tabId: number) => {
    const { attached } = getDebuggerState();
    const start = performance.now();
    const delta = gaussianDelay(80, 200);

    if (attached) {
      const cursor = getCursorPosition();
      await sendCDP(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: cursor.x || 400,
        y: cursor.y || 400,
        deltaX: 0,
        deltaY: delta,
      });
      await sleep(gaussianDelay(500, 1200));
      await sendCDP(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: cursor.x || 400,
        y: cursor.y || 400,
        deltaX: 0,
        deltaY: -delta,
      });
    } else {
      await api.scripting.executeScript({
        target: { tabId },
        func: (d: number) => window.scrollBy({ left: 0, top: d, behavior: 'smooth' }),
        args: [delta],
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
      });
      await sleep(gaussianDelay(500, 1200));
      await api.scripting.executeScript({
        target: { tabId },
        func: (d: number) => window.scrollBy({ left: 0, top: -d, behavior: 'smooth' }),
        args: [delta],
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
      });
    }

    await sleep(gaussianDelay(200, 400));
    return Math.round(performance.now() - start);
  },
};

const actionIdleDrift: MicroAction = {
  name: 'idle_drift',
  execute: async (tabId: number) => {
    const { attached } = getDebuggerState();
    const start = performance.now();

    if (!attached) {
      await sleep(gaussianDelay(1000, 2000));
      return Math.round(performance.now() - start);
    }

    const cursor = getCursorPosition();
    const driftSteps = gaussianDelay(3, 6);

    for (let i = 0; i < driftSteps; i++) {
      const dx = gaussianDelay(-5, 5);
      const dy = gaussianDelay(-5, 5);
      const nx = Math.max(0, cursor.x + dx);
      const ny = Math.max(0, cursor.y + dy);

      await sendCDP(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: nx,
        y: ny,
      });
      await sleep(gaussianDelay(200, 400));
    }

    return Math.round(performance.now() - start);
  },
};

const actionLongPause: MicroAction = {
  name: 'long_pause',
  execute: async () => {
    const duration = gaussianDelay(2000, 5000);
    await sleep(duration);
    return duration;
  },
};

// ─── Action Pools ──────────────────────────────────────────────────────────

const POOLS: Record<HumanizeIntensity, MicroAction[]> = {
  light: [actionRandomPause, actionMicroScroll],
  moderate: [actionRandomPause, actionMicroScroll, actionCursorMove, actionHoverInert, actionVariableScroll],
  heavy: [
    actionRandomPause,
    actionMicroScroll,
    actionCursorMove,
    actionHoverInert,
    actionVariableScroll,
    actionScrollBounce,
    actionIdleDrift,
    actionLongPause,
  ],
};

// ─── Main Handler ──────────────────────────────────────────────────────────

export const handleHumanize = async (params: Record<string, unknown>): Promise<HumanizeResult> => {
  const intensity = (params.intensity as HumanizeIntensity) ?? 'moderate';
  const tabId = await resolveTabId(params as { tabId?: number });

  const pool = POOLS[intensity];
  const action = pool[Math.floor(Math.random() * pool.length)];

  log(`Humanize (${intensity}): executing ${action.name}`);

  const duration_ms = await action.execute(tabId);

  log(`Humanize: ${action.name} completed in ${duration_ms}ms`);

  return { action: action.name, duration_ms };
};
