import { log, ELEMENT_SCROLL_SETTLE_MS } from '@extension/shared';
import { htmlToMarkdown } from '@src/html-to-markdown';
import { humanizedType, dispatchClick, sleep, randomDelay } from '@src/humanize';
import type { WolffishCommand, WolffishResponse, InternalMessage } from '@extension/shared';

const api = globalThis.chrome ?? (globalThis as Record<string, unknown>).browser;

log('Content script loaded');

// ─── Helpers ────────────────────────────────────────────────────────────────

const findElement = (selector: string): HTMLElement => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el as HTMLElement;
};

const isVisible = (el: HTMLElement): boolean => {
  if (el.offsetParent !== null) return true;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

// ─── Page Interaction Handlers ──────────────────────────────────────────────

const handleClick = async (params: Record<string, unknown>) => {
  const el = findElement(params.selector as string);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(ELEMENT_SCROLL_SETTLE_MS);
  await sleep(randomDelay(50, 150));
  await dispatchClick(el);
  return { success: true, elementFound: true };
};

const handleType = async (params: Record<string, unknown>) => {
  const el = findElement(params.selector as string);
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
  const el = findElement(params.selector as string) as HTMLSelectElement;
  if (el.tagName !== 'SELECT') throw new Error(`Element is not a <select>: ${params.selector}`);

  el.value = params.value as string;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
};

const handleHover = async (params: Record<string, unknown>) => {
  const el = findElement(params.selector as string);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(ELEMENT_SCROLL_SETTLE_MS);

  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  return { success: true };
};

const handleScroll = async (params: Record<string, unknown>) => {
  if (params.selector) {
    const el = findElement(params.selector as string);
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
  const el = findElement(params.selector as string);
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
  const input = findElement(params.selector as string) as HTMLInputElement;
  if (input.type !== 'file') throw new Error(`Element is not a file input: ${params.selector}`);

  const filesData = params.files as { name: string; content: string; mimeType: string }[];
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
  return { success: true };
};

// ─── Page Reading Handlers ──────────────────────────────────────────────────

const STRIP_SELECTORS = 'script, style, noscript, svg, template, iframe, [aria-hidden="true"], [hidden]';

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

  const nodes = document.querySelectorAll(selector);
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
  const el = findElement(params.selector as string);
  const attrNames = params.attributes as string[];
  const attributes: Record<string, string | null> = {};

  for (const name of attrNames) {
    attributes[name] = el.getAttribute(name);
  }

  return { attributes };
};

const handleGetValue = async (params: Record<string, unknown>) => {
  const el = findElement(params.selector as string) as HTMLInputElement;
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

const handleWaitFor = async (params: Record<string, unknown>) => {
  const selector = params.selector as string;
  const timeout = (params.timeout as number) ?? 10000;
  const requireVisible = (params.visible as boolean) ?? false;
  const start = Date.now();

  const check = (): boolean => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return false;
    if (requireVisible && !isVisible(el)) return false;
    return true;
  };

  if (check()) return { found: true, elapsed: Date.now() - start };

  return new Promise<{ found: boolean; elapsed: number }>(resolve => {
    let resolved = false;
    const cleanup = () => {
      resolved = true;
      observer.disconnect();
      clearInterval(pollId);
      clearTimeout(timeoutId);
    };

    const observer = new MutationObserver(() => {
      if (resolved) return;
      if (check()) {
        cleanup();
        resolve({ found: true, elapsed: Date.now() - start });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    const pollId = setInterval(() => {
      if (resolved) return;
      if (check()) {
        cleanup();
        resolve({ found: true, elapsed: Date.now() - start });
      }
    }, 200);

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

// ─── Command Dispatch ─────────────────────────────────────────────────────────

const HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
  browser_click: handleClick,
  browser_type: handleType,
  browser_select: handleSelect,
  browser_hover: handleHover,
  browser_scroll: handleScroll,
  browser_focus: handleFocus,
  browser_keypress: handleKeypress,
  browser_drag_drop: handleDragDrop,
  browser_file_upload: handleFileUpload,
  browser_read_page: handleReadPage,
  browser_query_selector: handleQuerySelector,
  browser_get_attribute: handleGetAttribute,
  browser_get_value: handleGetValue,
  browser_get_page_info: handleGetPageInfo,
  browser_storage_get: handleStorageGet,
  browser_storage_set: handleStorageSet,
  browser_clipboard_read: handleClipboardRead,
  browser_clipboard_write: handleClipboardWrite,
  browser_wait_for: handleWaitFor,
  browser_wait_for_network_idle: handleWaitForNetworkIdle,
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
