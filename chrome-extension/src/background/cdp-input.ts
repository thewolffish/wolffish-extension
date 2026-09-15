import { sendCDP } from './cdp-session.js';
import type { Session } from './cdp-session.js';
import { gaussianDelay, sleep } from './gaussian.js';
import { overlayHooks, postCursor } from './overlay-hooks.js';

type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 };

// ─── Bezier cursor path ──────────────────────────────────────────────────────

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

// ─── Mouse primitives ────────────────────────────────────────────────────────

/** Glide the cursor to (x, y) along a bezier path. `dragging` holds the left button down. */
const cdpMove = async (session: Session, x: number, y: number, dragging = false): Promise<void> => {
  const tabId = session.tabId;
  const steps = gaussianDelay(10, 20);
  const path = generateBezierPath(session.cursor.x, session.cursor.y, x, y, steps);
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    await sendCDP(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      ...(dragging ? { button: 'left', buttons: 1 } : {}),
    });
    postCursor(tabId, point.x, point.y, i === path.length - 1);
    await sleep(gaussianDelay(5, 15));
  }
  session.cursor = { x, y };
  postCursor(tabId, x, y, true);
};

const cdpPress = async (session: Session, x: number, y: number, button: MouseButton, clickCount = 1): Promise<void> => {
  overlayHooks.pulse(session.tabId).catch(() => {});
  await sendCDP(session.tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons: BUTTON_MASK[button] ?? 1,
    clickCount,
  });
};

const cdpRelease = (session: Session, x: number, y: number, button: MouseButton, clickCount = 1): Promise<unknown> =>
  sendCDP(session.tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount,
  });

/** A full click at a point the cursor has already glided to. */
const cdpClick = async (session: Session, x: number, y: number, button: MouseButton, double = false): Promise<void> => {
  await cdpPress(session, x, y, button, 1);
  await sleep(gaussianDelay(30, 80));
  await cdpRelease(session, x, y, button, 1);
  if (double) {
    await sleep(gaussianDelay(40, 90));
    await cdpPress(session, x, y, button, 2);
    await sleep(gaussianDelay(30, 80));
    await cdpRelease(session, x, y, button, 2);
  }
};

/** Real wheel input at a point. Zero deltas are a no-op rather than a no-op event. */
const cdpWheel = async (session: Session, x: number, y: number, deltaX: number, deltaY: number): Promise<void> => {
  if (deltaX === 0 && deltaY === 0) return;
  await sendCDP(session.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  session.cursor = { x, y };
  postCursor(session.tabId, x, y, true);
};

// ─── Keyboard primitives ─────────────────────────────────────────────────────

const MODIFIER_FLAGS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const MODIFIER_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

const SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Insert: { code: 'Insert', keyCode: 45 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  F1: { code: 'F1', keyCode: 112 },
  F2: { code: 'F2', keyCode: 113 },
  F3: { code: 'F3', keyCode: 114 },
  F4: { code: 'F4', keyCode: 115 },
  F5: { code: 'F5', keyCode: 116 },
  F6: { code: 'F6', keyCode: 117 },
  F7: { code: 'F7', keyCode: 118 },
  F8: { code: 'F8', keyCode: 119 },
  F9: { code: 'F9', keyCode: 120 },
  F10: { code: 'F10', keyCode: 121 },
  F11: { code: 'F11', keyCode: 122 },
  F12: { code: 'F12', keyCode: 123 },
};

/**
 * Editing shortcuts on macOS are dispatched as editor commands, not key
 * combos; without these `meta+a` reaches the page as a bare keydown and
 * selects nothing (Playwright/Puppeteer send the same list).
 */
const EDIT_COMMANDS: Record<string, string> = {
  a: 'SelectAll',
  c: 'Copy',
  v: 'Paste',
  x: 'Cut',
  z: 'Undo',
  y: 'Redo',
};

const codeForChar = (char: string): string => {
  if (char >= 'a' && char <= 'z') return `Key${char.toUpperCase()}`;
  if (char >= 'A' && char <= 'Z') return `Key${char}`;
  if (char >= '0' && char <= '9') return `Digit${char}`;
  if (char === ' ') return 'Space';
  return '';
};

const isPrintableAscii = (char: string): boolean => {
  const c = char.charCodeAt(0);
  return char.length === 1 && c >= 0x20 && c <= 0x7e;
};

const keyEvent = (tabId: number, params: Record<string, unknown>): Promise<unknown> =>
  sendCDP(tabId, 'Input.dispatchKeyEvent', params);

/** keyDown/char/keyUp for one printable ASCII character — the trusted-keystroke path. */
const typeAsciiChar = async (tabId: number, char: string, modifiers = 0): Promise<void> => {
  const keyCode = char.charCodeAt(0);
  const code = codeForChar(char);
  const base = { key: char, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await keyEvent(tabId, { type: 'keyDown', ...base });
  await keyEvent(tabId, { type: 'char', text: char, ...base });
  await keyEvent(tabId, { type: 'keyUp', ...base });
};

const pressEnter = async (tabId: number, modifiers = 0): Promise<void> => {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
  await keyEvent(tabId, { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base });
  await keyEvent(tabId, { type: 'keyUp', ...base });
};

/**
 * Type into the focused element. ASCII goes through real key events; anything
 * else (Arabic, CJK, emoji, curly quotes) is inserted as text, because there is
 * no virtual key code that produces it and a `char` event alone confuses IMEs.
 * `\n` becomes an Enter press so newlines submit or break lines like a human's.
 */
const typeText = async (session: Session, text: string, humanize: boolean): Promise<number> => {
  const tabId = session.tabId;
  const chars = Array.from(text);
  if (!humanize) {
    await sendCDP(tabId, 'Input.insertText', { text });
    return chars.length;
  }
  for (const char of chars) {
    if (char === '\n' || char === '\r') await pressEnter(tabId);
    else if (isPrintableAscii(char)) await typeAsciiChar(tabId, char);
    else await sendCDP(tabId, 'Input.insertText', { text: char });
    await sleep(gaussianDelay(40, 120, 70));
  }
  return chars.length;
};

/**
 * One key with modifiers. Modifier keys are really pressed (keyDown) and
 * always released in `finally` — a stuck Shift would silently capitalise every
 * later keystroke on the page.
 */
const pressKey = async (session: Session, key: string, modifiers: string[]): Promise<void> => {
  const tabId = session.tabId;
  const mods = modifiers.filter(m => m in MODIFIER_FLAGS);
  let bitmask = 0;
  const held: string[] = [];
  try {
    for (const mod of mods) {
      const m = MODIFIER_KEYS[mod];
      bitmask |= MODIFIER_FLAGS[mod];
      await keyEvent(tabId, {
        type: 'keyDown',
        key: m.key,
        code: m.code,
        windowsVirtualKeyCode: m.keyCode,
        nativeVirtualKeyCode: m.keyCode,
        modifiers: bitmask,
      });
      held.push(mod);
    }

    const special = SPECIAL_KEYS[key];
    const single = key.length === 1;
    const code = special?.code ?? (single ? codeForChar(key) : key);
    const keyCode = special?.keyCode ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
    const shortcut = single && (bitmask & (MODIFIER_FLAGS.meta | MODIFIER_FLAGS.ctrl)) !== 0;
    const command = shortcut ? EDIT_COMMANDS[key.toLowerCase()] : undefined;
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: bitmask };

    await keyEvent(tabId, {
      type: 'keyDown',
      ...base,
      ...(special?.text && !shortcut ? { text: special.text, unmodifiedText: special.text } : {}),
      ...(command ? { commands: [command] } : {}),
    });
    if (single && !shortcut) {
      if (isPrintableAscii(key)) await keyEvent(tabId, { type: 'char', text: key, ...base });
      else await sendCDP(tabId, 'Input.insertText', { text: key });
    }
    await keyEvent(tabId, { type: 'keyUp', ...base });
  } finally {
    for (const mod of held.reverse()) {
      const m = MODIFIER_KEYS[mod];
      bitmask &= ~MODIFIER_FLAGS[mod];
      await keyEvent(tabId, {
        type: 'keyUp',
        key: m.key,
        code: m.code,
        windowsVirtualKeyCode: m.keyCode,
        nativeVirtualKeyCode: m.keyCode,
        modifiers: bitmask,
      }).catch(() => {});
    }
  }
};

export type { MouseButton };
export { cdpClick, cdpMove, cdpPress, cdpRelease, cdpWheel, generateBezierPath, pressKey, typeText };
