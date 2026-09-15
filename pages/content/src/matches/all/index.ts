import { log, ELEMENT_SCROLL_SETTLE_MS, WolffishCommands } from '@extension/shared';
import { handleFill, handleFillForm } from '@src/fill';
import { htmlToMarkdown } from '@src/html-to-markdown';
import { humanizedType, dispatchClick, sleep, randomDelay } from '@src/humanize';
import { handleOverlay, isOverlayNode, OVERLAY_HOST_TAG } from '@src/overlay';
import {
  takeSnapshot,
  hasSnapshot,
  resolveUid,
  resolveUidElement,
  findInSnapshot,
  currentSnapshotId,
} from '@src/snapshot';
import type {
  WolffishCommand,
  WolffishResponse,
  InternalMessage,
  InteractiveElementInfo,
  ElementTarget,
  OverlayPayload,
} from '@extension/shared';

const api = globalThis.chrome ?? (globalThis as Record<string, unknown>).browser;

log('Content script loaded');

// ─── Helpers ────────────────────────────────────────────────────────────────

const isVisible = (el: HTMLElement): boolean => {
  if (el.offsetParent !== null) return true;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

/**
 * Playwright-style `text=` selector. Agent models produce these reflexively
 * because the playwright twin tools accept them — observed live on
 * 2026-06-12 (`text=join`, `text=78 comments`), each burning three motor
 * retries as a querySelector SyntaxError. Resolves to the deepest visible
 * element whose whitespace-normalized text matches: exact match beats
 * substring, both case-insensitive; earlier in document order wins ties.
 * Returns null when nothing visible matches.
 */
const findByText = (raw: string): HTMLElement | null => {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = normalize(raw.replace(/^(["'])(.*)\1$/s, '$2'));
  if (!needle) return null;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const exact: HTMLElement[] = [];
  const partial: HTMLElement[] = [];
  const all = document.body ? Array.from(document.body.getElementsByTagName('*')) : [];
  for (const node of all) {
    const el = node as HTMLElement;
    if (SKIP.has(el.tagName) || isOverlayNode(el)) continue;
    const text = normalize(el.textContent ?? '');
    // Anything much longer than the needle is a container, not a target.
    if (!text || text.length > needle.length + 200) continue;
    if (text === needle) exact.push(el);
    else if (text.includes(needle)) partial.push(el);
  }

  const pool = exact.length > 0 ? exact : partial;
  // Deepest match only — clicking the innermost node still bubbles to the
  // ancestor link/button, while clicking a matched container would not
  // necessarily hit the control the model meant.
  const deepest = pool.filter(el => !pool.some(other => other !== el && el.contains(other)));
  return deepest.find(isVisible) ?? null;
};

/**
 * Selector resolution for every selector-taking command. CSS by default;
 * `text=` falls through to findByText. Invalid CSS is rethrown with
 * phrasing the motor's error classifier treats as a deterministic
 * validation failure — the raw "Failed to execute 'querySelector'"
 * SyntaxError classifies as retryable-unknown and burns three attempts
 * on a selector that can never work.
 */
const querySelectorSafe = (selector: string): HTMLElement | null => {
  if (selector.startsWith('text=')) {
    return findByText(selector.slice('text='.length));
  }
  try {
    return document.querySelector(selector) as HTMLElement | null;
  } catch {
    throw new Error(
      `selector syntax is incorrect: '${selector}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`,
    );
  }
};

const findElement = (selector: string): HTMLElement => {
  const el = querySelectorSafe(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
};

/**
 * Element targeting for every uid-aware command: a snapshot uid wins over a
 * selector, so a model that has both never falls back to the weaker one.
 */
const resolveElement = (target: ElementTarget): HTMLElement => {
  if (typeof target.uid === 'string' && target.uid !== '') return resolveUidElement(target.uid).el;
  if (typeof target.selector === 'string' && target.selector !== '') return findElement(target.selector);
  throw new Error('Provide uid or selector.');
};

const targetOf = (params: Record<string, unknown>): ElementTarget => ({
  uid: params.uid as string | undefined,
  selector: params.selector as string | undefined,
});

const refOf = (params: Record<string, unknown>): string => String(params.uid ?? params.selector ?? '');

/**
 * Multi-element form of querySelectorSafe for ext_query_selector. Same
 * `text=` support and the same deterministic validation message on invalid
 * CSS — the raw `querySelectorAll` SyntaxError ("… is not a valid selector")
 * classifies as retryable-unknown and burned three motor attempts every time
 * the model produced a Playwright pseudo like `button:has-text("save")`.
 */
const querySelectorAllSafe = (selector: string): HTMLElement[] => {
  if (selector.startsWith('text=')) {
    const el = findByText(selector.slice('text='.length));
    return el ? [el] : [];
  }
  try {
    return Array.from(document.querySelectorAll(selector)) as HTMLElement[];
  } catch {
    throw new Error(
      `selector syntax is incorrect: '${selector}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`,
    );
  }
};

// ─── Page Interaction Handlers ──────────────────────────────────────────────

const handleClick = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(ELEMENT_SCROLL_SETTLE_MS);
  await sleep(randomDelay(50, 150));
  await dispatchClick(el);
  return { success: true, elementFound: true };
};

const handleType = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  const text = params.text as string;
  const clearFirst = (params.clearFirst as boolean) ?? false;
  const humanize = (params.humanize as boolean) ?? true;

  if (humanize) {
    await humanizedType(el, text, clearFirst);
  } else {
    el.focus();

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const input = el as HTMLInputElement;
      if (clearFirst) input.value = '';
      input.value += text;
    } else if (el.isContentEditable) {
      if (clearFirst) {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
      document.execCommand('insertText', false, text);
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return { success: true };
};

const handleSelect = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params)) as HTMLSelectElement;
  if (el.tagName !== 'SELECT') throw new Error(`Element is not a <select>: ${refOf(params)}`);

  el.value = params.value as string;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
};

const handleHover = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(ELEMENT_SCROLL_SETTLE_MS);

  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  return { success: true };
};

const handleScroll = async (params: Record<string, unknown>) => {
  if (params.uid || params.selector) {
    const el = resolveElement(targetOf(params));
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    const direction = params.direction as string;
    const amount = (params.amount as number) ?? 300;
    const scrollMap: Record<string, [number, number]> = {
      up: [0, -amount],
      down: [0, amount],
      left: [-amount, 0],
      right: [amount, 0],
    };
    const [x, y] = scrollMap[direction] ?? [0, 0];
    window.scrollBy({ left: x, top: y, behavior: 'smooth' });
  }

  await sleep(ELEMENT_SCROLL_SETTLE_MS);
  return { success: true };
};

const handleFocus = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  el.focus();
  return { success: true };
};

const handleKeypress = async (params: Record<string, unknown>) => {
  const key = params.key as string;
  const modifiers = (params.modifiers as string[]) ?? [];

  const eventInit: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.includes('ctrl'),
    shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt'),
    metaKey: modifiers.includes('meta'),
  };

  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  if (key.length === 1) {
    target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  return { success: true };
};

const handleDragDrop = async (params: Record<string, unknown>) => {
  const source = findElement(params.sourceSelector as string);
  const target = findElement(params.targetSelector as string);

  const dataTransfer = new DataTransfer();

  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));

  return { success: true };
};

const handleFileUpload = async (params: Record<string, unknown>) => {
  const input = resolveElement(targetOf(params)) as HTMLInputElement;
  if (input.type !== 'file') throw new Error(`Element is not a file input: ${refOf(params)}`);

  const filesData = params.files as { name: string; content: string; mimeType: string }[] | undefined;
  if (!Array.isArray(filesData) || filesData.length === 0) {
    // Only the CDP path can hand the page a real disk file.
    throw new Error(
      'Uploading by file path needs the debugger. Call ext_debugger_attach first, or pass files as base64 content.',
    );
  }
  const dataTransfer = new DataTransfer();

  for (const fileData of filesData) {
    const binary = atob(fileData.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const file = new File([bytes], fileData.name, { type: fileData.mimeType });
    dataTransfer.items.add(file);
  }

  input.files = dataTransfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, count: filesData.length, via: 'data' };
};

/**
 * Set a field's value reliably and instantly — the framework-safe fill.
 *
 * Plain assignment (`el.value = x`, which ext_type's non-humanized path uses)
 * is invisible to React: React installs its own value setter on the element
 * instance and tracks the last value it set, so a direct assignment is seen as
 * "no change" and gets reverted on the next render — the field looks filled but
 * the component state (and therefore any submit) is empty. The fix is to call
 * the *native prototype* setter and then dispatch `input`, which is exactly
 * what a real keystroke does under the hood. This is why submits silently
 * no-op'd in the 06-14 run; ext_type stays for when humanized keystrokes are
 * needed for stealth, ext_set_value is the reliable instant path.
 */
const handleSetValue = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  const value = (params.value as string) ?? '';
  el.focus();

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    throw new Error(`Element is not an input, textarea, or contenteditable: ${refOf(params)}`);
  }

  return { success: true, value };
};

/**
 * Submit the form containing `selector` (or a form selector, or the focused
 * element's form). Uses `form.requestSubmit()` — which fires a *cancelable
 * submit event* and runs validation exactly like clicking the submit button,
 * the event old.reddit/jQuery and most server-rendered forms actually listen
 * for. The 06-14 run never found a reliable submit and cycled through
 * `.usertext-buttons button`, `form.usertext button.save`, `text=save`,
 * Tab+Enter, execute_js and even a second browser engine; this is the one
 * primitive that replaces all of that. Falls back to clicking the submit
 * control, then to `form.submit()`.
 */
const handleSubmitForm = async (params: Record<string, unknown>) => {
  const sel = params.selector as string | undefined;
  let form: HTMLFormElement | null = null;

  if (sel) {
    const el = findElement(sel);
    form = el.tagName === 'FORM' ? (el as HTMLFormElement) : el.closest('form');
  } else if (document.activeElement) {
    form = (document.activeElement as HTMLElement).closest('form');
  }

  if (!form) {
    throw new Error(
      sel
        ? `No form found for selector: ${sel}`
        : 'No form to submit — pass a selector inside the form, or focus a field first',
    );
  }

  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    const btn = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])');
    if (btn) btn.click();
    else form.submit();
  }

  return { success: true };
};

// ─── Page Reading Handlers ──────────────────────────────────────────────────

// The presence overlay host is stripped so the agent never reads its own pill.
const STRIP_SELECTORS = `script, style, noscript, svg, template, iframe, ${OVERLAY_HOST_TAG}, [aria-hidden="true"], [hidden]`;

const cleanClone = (root: Element): Element => {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll(STRIP_SELECTORS).forEach(el => el.remove());
  return clone;
};

const handleReadPage = async (params: Record<string, unknown>) => {
  const root = params.selector ? findElement(params.selector as string) : document.body;

  const format = (params.format as string) ?? 'text';
  let content: string;

  switch (format) {
    case 'markdown':
      content = htmlToMarkdown(cleanClone(root));
      break;
    case 'html':
      content = cleanClone(root).innerHTML;
      break;
    case 'text':
    default:
      content = (cleanClone(root) as HTMLElement).innerText.replace(/\n{3,}/g, '\n\n').trim();
      break;
  }

  return { content, url: location.href, title: document.title };
};

const handleQuerySelector = async (params: Record<string, unknown>) => {
  const selector = params.selector as string;
  const requestedAttrs = params.attributes as string[] | undefined;
  const limit = (params.limit as number) ?? 20;
  const defaultAttrs = ['id', 'class', 'href', 'src', 'type', 'name', 'value', 'role', 'aria-label'];

  const nodes = querySelectorAllSafe(selector);
  const elements: {
    tag: string;
    text: string;
    attributes: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
  }[] = [];

  const attrsToGet = requestedAttrs ?? defaultAttrs;

  for (let i = 0; i < Math.min(nodes.length, limit); i++) {
    const el = nodes[i] as HTMLElement;
    const text = (el.textContent ?? '').trim().slice(0, 200);
    const rect = el.getBoundingClientRect();

    const attributes: Record<string, string> = {};
    for (const attr of attrsToGet) {
      const val = el.getAttribute(attr);
      if (val !== null) attributes[attr] = val;
    }

    elements.push({
      tag: el.tagName.toLowerCase(),
      text,
      attributes,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }

  return { elements };
};

const handleGetAttribute = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params));
  const attrNames = params.attributes as string[];
  const attributes: Record<string, string | null> = {};

  for (const name of attrNames) {
    attributes[name] = el.getAttribute(name);
  }

  return { attributes };
};

const handleGetValue = async (params: Record<string, unknown>) => {
  const el = resolveElement(targetOf(params)) as HTMLInputElement;
  return {
    value: el.value ?? '',
    type: el.type || el.tagName.toLowerCase(),
  };
};

const handleGetPageInfo = async () => {
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';

  const favicon = document.querySelector<HTMLLinkElement>('link[rel*="icon"]')?.href ?? '';

  const lang = document.documentElement.lang ?? '';

  const links: { href: string; text: string }[] = [];
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (let i = 0; i < Math.min(anchors.length, 100); i++) {
    links.push({
      href: anchors[i].href,
      text: (anchors[i].textContent ?? '').trim().slice(0, 100),
    });
  }

  const headings: { level: number; text: string }[] = [];
  const headingEls = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of Array.from(headingEls)) {
    headings.push({
      level: parseInt(h.tagName[1], 10),
      text: (h.textContent ?? '').trim(),
    });
  }

  const forms: { action: string; method: string; fields: { name: string; type: string; id: string }[] }[] = [];
  for (const form of Array.from(document.querySelectorAll<HTMLFormElement>('form'))) {
    const fields: { name: string; type: string; id: string }[] = [];
    const inputs = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    );
    for (const input of Array.from(inputs)) {
      fields.push({
        name: input.name ?? '',
        type: (input as HTMLInputElement).type ?? input.tagName.toLowerCase(),
        id: input.id ?? '',
      });
    }
    forms.push({
      action: form.action ?? '',
      method: (form.method ?? 'get').toUpperCase(),
      fields,
    });
  }

  return {
    url: location.href,
    title: document.title,
    description: meta('description'),
    favicon,
    lang,
    links,
    headings,
    forms,
  };
};

// ─── Coordinate ↔ DOM Bridging Handlers ─────────────────────────────────────

const POINT_ATTRS = [
  'id',
  'class',
  'href',
  'src',
  'type',
  'name',
  'value',
  'role',
  'aria-label',
  'placeholder',
  'title',
];

const handleElementFromPoint = async (params: Record<string, unknown>) => {
  const x = params.x as number;
  const y = params.y as number;
  // The overlay host sits on top of everything; look through it.
  const el = (document.elementsFromPoint(x, y).find(n => !isOverlayNode(n)) as HTMLElement | undefined) ?? null;
  if (!el) return { found: false };

  const rect = el.getBoundingClientRect();
  const attributes: Record<string, string> = {};
  for (const a of POINT_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null) attributes[a] = v;
  }

  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    attributes,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
};

const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [tabindex]:not([tabindex="-1"]), summary, label[for]';

const INTERACTIVE_ATTRS = ['id', 'name', 'type', 'href', 'value', 'placeholder', 'aria-label', 'title', 'role'];

/**
 * Map every visible interactive element to its centre coordinates plus the
 * attributes needed to build a CSS selector. Bridges screenshot/visual
 * coordinates and the DOM: read this, then act with ext_mouse_click (by
 * centre coords) or ext_click (by a selector built from id/name/aria-label).
 */
const handleInteractiveElements = async (params: Record<string, unknown>) => {
  const limit = (params.limit as number) ?? 50;
  const scopeSel = params.selector as string | undefined;
  const root: ParentNode = scopeSel ? findElement(scopeSel) : document;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  const elements: InteractiveElementInfo[] = [];

  for (const el of nodes) {
    if (elements.length >= limit) break;
    if (isOverlayNode(el) || !isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const attributes: Record<string, string> = {};
    for (const a of INTERACTIVE_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && v !== '') attributes[a] = v;
    }

    const label =
      (el.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      (el as HTMLInputElement).value ||
      el.getAttribute('title') ||
      '';

    elements.push({
      tag: el.tagName.toLowerCase(),
      text: label.slice(0, 120),
      role: el.getAttribute('role') ?? '',
      center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      attributes,
    });
  }

  return { elements };
};

// ─── Storage Handlers ───────────────────────────────────────────────────────

const handleStorageGet = async (params: Record<string, unknown>) => {
  const storage = params.type === 'session' ? sessionStorage : localStorage;
  const keys = params.keys as string[] | undefined;
  const data: Record<string, string> = {};

  if (keys) {
    for (const key of keys) {
      const val = storage.getItem(key);
      if (val !== null) data[key] = val;
    }
  } else {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) data[key] = storage.getItem(key)!;
    }
  }

  return { data };
};

const handleStorageSet = async (params: Record<string, unknown>) => {
  const storage = params.type === 'session' ? sessionStorage : localStorage;
  const data = params.data as Record<string, string>;

  for (const [key, value] of Object.entries(data)) {
    storage.setItem(key, value);
  }

  return { success: true };
};

// ─── Clipboard Handlers ─────────────────────────────────────────────────────

const handleClipboardRead = async () => {
  const text = await navigator.clipboard.readText();
  return { text };
};

const handleClipboardWrite = async (params: Record<string, unknown>) => {
  await navigator.clipboard.writeText(params.text as string);
  return { success: true };
};

// ─── Wait Handlers ──────────────────────────────────────────────────────────

const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Wait for a selector to appear and/or for ANY of `text` to show up in the
 * page's visible text. `matched` names what satisfied the wait so the model
 * knows which branch it is on.
 */
const handleWaitFor = async (params: Record<string, unknown>) => {
  const selector = typeof params.selector === 'string' && params.selector !== '' ? params.selector : undefined;
  const rawText = params.text;
  const texts = (Array.isArray(rawText) ? rawText : typeof rawText === 'string' ? [rawText] : [])
    .map(t => String(t))
    .filter(t => normalizeText(t) !== '');
  if (!selector && texts.length === 0) throw new Error('Provide selector or text.');

  const timeout = (params.timeout as number) ?? 10000;
  const requireVisible = (params.visible as boolean) ?? false;
  const start = Date.now();

  const check = (): string | null => {
    if (selector) {
      const el = querySelectorSafe(selector);
      if (el && (!requireVisible || isVisible(el))) return selector;
    }
    if (texts.length > 0 && document.body) {
      const haystack = normalizeText(document.body.innerText);
      const hit = texts.find(t => haystack.includes(normalizeText(t)));
      if (hit !== undefined) return hit;
    }
    return null;
  };

  const first = check();
  if (first !== null) return { found: true, elapsed: Date.now() - start, matched: first };

  return new Promise<{ found: boolean; elapsed: number; matched?: string }>(resolve => {
    let resolved = false;
    const cleanup = () => {
      resolved = true;
      observer.disconnect();
      clearInterval(pollId);
      clearTimeout(timeoutId);
    };
    const attempt = () => {
      if (resolved) return;
      const matched = check();
      if (matched !== null) {
        cleanup();
        resolve({ found: true, elapsed: Date.now() - start, matched });
      }
    };

    const observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

    const pollId = setInterval(attempt, 200);

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      cleanup();
      resolve({ found: false, elapsed: Date.now() - start });
    }, timeout);
  });
};

const handleWaitForNetworkIdle = async (params: Record<string, unknown>) => {
  const timeout = (params.timeout as number) ?? 30000;
  const idleTime = (params.idleTime as number) ?? 500;

  return new Promise<{ success: boolean }>(resolve => {
    let lastActivity = Date.now();
    let resolved = false;

    const cleanup = () => {
      resolved = true;
      observer.disconnect();
      clearInterval(checkId);
      clearTimeout(timeoutId);
    };

    const observer = new PerformanceObserver(() => {
      lastActivity = Date.now();
    });

    try {
      observer.observe({ type: 'resource', buffered: false });
    } catch {
      resolve({ success: true });
      return;
    }

    const checkId = setInterval(() => {
      if (resolved) return;
      if (Date.now() - lastActivity >= idleTime) {
        cleanup();
        resolve({ success: true });
      }
    }, 100);

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      cleanup();
      resolve({ success: true });
    }, timeout);
  });
};

// ─── Snapshot / uid Handlers (DOM fallback) ─────────────────────────────────

const handleTakeSnapshot = async (params: Record<string, unknown>) =>
  takeSnapshot({
    verbose: params.verbose === true,
    snapshotId: typeof params.snapshotId === 'number' ? params.snapshotId : undefined,
  });

const handleResolveUid = async (params: Record<string, unknown>) => resolveUid(String(params.uid ?? ''));

const handleFind = async (params: Record<string, unknown>) => {
  const query = String(params.query ?? '');
  const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 10;
  if (!hasSnapshot()) {
    takeSnapshot({ snapshotId: typeof params.snapshotId === 'number' ? params.snapshotId : undefined });
  }
  return { elements: findInSnapshot(query, limit), snapshotId: currentSnapshotId() };
};

// ─── Command Dispatch ─────────────────────────────────────────────────────────

// Keys come from the shared constants only: a literal here once silently
// disagreed with the service worker and the command fell into "Unknown".
const HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  [WolffishCommands.BROWSER_CLICK]: handleClick,
  [WolffishCommands.BROWSER_TYPE]: handleType,
  [WolffishCommands.BROWSER_SELECT]: handleSelect,
  [WolffishCommands.BROWSER_HOVER]: handleHover,
  [WolffishCommands.BROWSER_SCROLL]: handleScroll,
  [WolffishCommands.BROWSER_FOCUS]: handleFocus,
  [WolffishCommands.BROWSER_KEYPRESS]: handleKeypress,
  [WolffishCommands.BROWSER_DRAG_DROP]: handleDragDrop,
  [WolffishCommands.BROWSER_FILE_UPLOAD]: handleFileUpload,
  [WolffishCommands.BROWSER_SET_VALUE]: handleSetValue,
  [WolffishCommands.BROWSER_SUBMIT_FORM]: handleSubmitForm,
  [WolffishCommands.BROWSER_READ_PAGE]: handleReadPage,
  [WolffishCommands.BROWSER_QUERY_SELECTOR]: handleQuerySelector,
  [WolffishCommands.BROWSER_GET_ATTRIBUTE]: handleGetAttribute,
  [WolffishCommands.BROWSER_GET_VALUE]: handleGetValue,
  [WolffishCommands.BROWSER_GET_PAGE_INFO]: handleGetPageInfo,
  [WolffishCommands.BROWSER_STORAGE_GET]: handleStorageGet,
  [WolffishCommands.BROWSER_STORAGE_SET]: handleStorageSet,
  [WolffishCommands.BROWSER_CLIPBOARD_READ]: handleClipboardRead,
  [WolffishCommands.BROWSER_CLIPBOARD_WRITE]: handleClipboardWrite,
  [WolffishCommands.BROWSER_WAIT_FOR]: handleWaitFor,
  [WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE]: handleWaitForNetworkIdle,
  [WolffishCommands.BROWSER_ELEMENT_FROM_POINT]: handleElementFromPoint,
  [WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS]: handleInteractiveElements,
  [WolffishCommands.BROWSER_TAKE_SNAPSHOT]: handleTakeSnapshot,
  [WolffishCommands.BROWSER_RESOLVE_UID]: handleResolveUid,
  [WolffishCommands.BROWSER_FIND]: handleFind,
  [WolffishCommands.BROWSER_FILL]: params => handleFill(params, resolveElement),
  [WolffishCommands.BROWSER_FILL_FORM]: params => handleFillForm(params, resolveElement),
};

const handleCommand = async (command: WolffishCommand): Promise<WolffishResponse> => {
  log('←', command.type, command.params);

  try {
    const handler = HANDLERS[command.type];
    if (!handler) {
      return { id: command.id, success: false, error: `Unknown content command: ${command.type}` };
    }
    const data = await handler(command.params as Record<string, unknown>);
    log('→', command.type, 'success');
    return { id: command.id, success: true, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log('→', command.type, 'error:', error);
    return { id: command.id, success: false, error };
  }
};

api.runtime.onMessage.addListener(
  (message: InternalMessage, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (message?.payload && 'type' in message.payload && message.payload.type === 'ping') {
      sendResponse({ type: 'pong' });
      return true;
    }

    // Overlay ops are fire-and-forget cosmetics; never let one throw into the
    // command path.
    if (message?.payload && 'type' in message.payload && message.payload.type === 'overlay') {
      try {
        handleOverlay(message.payload as OverlayPayload);
      } catch (err) {
        log('overlay error:', err instanceof Error ? err.message : String(err));
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message?.source === 'service-worker' && message?.target === 'content-script') {
      const command = message.payload as WolffishCommand;
      handleCommand(command)
        .then(sendResponse)
        .catch(err => {
          sendResponse({
            id: command.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }

    return false;
  },
);
