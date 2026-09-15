import { isOverlayNode } from '@src/overlay';
import type { BrowserResolveUidResult, FoundElement } from '@extension/shared';

/**
 * DOM-side accessibility snapshot — the fallback when the tab has no CDP
 * session (Firefox, restricted pages). Produces the same line format and uid
 * contract as the CDP walker in the service worker so the model never has to
 * know which path answered.
 */

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
]);

const STRUCTURAL_ROLES = new Set([
  'heading',
  'dialog',
  'alertdialog',
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'form',
  'region',
  'search',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'list',
  'listitem',
  'img',
  'image',
  'figure',
  'article',
  'tabpanel',
  'tablist',
  'menu',
  'menubar',
  'toolbar',
  'status',
  'alert',
  'progressbar',
]);

/** Landmarks are reported even when they measure 0×0 (sticky/collapsed shells). */
const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'form', 'region', 'search', 'dialog']);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);

const TEXTBOX_INPUT_TYPES = new Set([
  'text',
  'email',
  'url',
  'tel',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color',
]);

const NAME_MAX = 120;
const TEXT_MAX = 200;
const HREF_MAX = 200;
const IMG_URL_MAX = 120;
const VALUE_MAX = 200;

interface SnapshotRecord {
  node: Node;
  role: string;
  name: string;
}

interface WalkNode {
  uid: string;
  role: string;
  name: string;
  attrs: string;
  suffix: string;
  isNew: boolean;
  depth: number;
}

// uid maps live for the document: same Element identity keeps its uid across
// snapshots; a new document (navigation, reload) invalidates everything.
let nodeToUid = new Map<Node, string>();
let uidToRecord = new Map<string, SnapshotRecord>();
let lastDocument: Document | null = null;
let lastTimeOrigin = 0;
let hasPrevious = false;
let lastSnapshotId = 0;
let localCounter = 0;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const resetIfNewDocument = () => {
  const origin = performance.timeOrigin;
  if (lastDocument !== document || lastTimeOrigin !== origin) {
    nodeToUid = new Map();
    uidToRecord = new Map();
    hasPrevious = false;
    lastDocument = document;
    lastTimeOrigin = origin;
  }
};

const viewOf = (el: Element): Window => el.ownerDocument.defaultView ?? window;

const isElementHidden = (el: Element): boolean => {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).hidden) return true;
  const maybe = el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean };
  if (typeof maybe.checkVisibility === 'function') {
    return !maybe.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  }
  const style = viewOf(el).getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
};

const isZeroRect = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0;
};

const displayContents = (el: Element): boolean => {
  try {
    return viewOf(el).getComputedStyle(el).display === 'contents';
  } catch {
    return false;
  }
};

const inputType = (el: HTMLInputElement): string => (el.getAttribute('type') ?? 'text').toLowerCase();

/** Native-semantics role; an explicit `role=` attribute wins. */
const computeRole = (el: Element): string => {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const first = explicit.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) return first === 'presentation' ? 'none' : first;
  }
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
    case 'summary':
      return 'button';
    case 'input': {
      const type = inputType(el as HTMLInputElement);
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') {
        return 'button';
      }
      if (type === 'search') return 'searchbox';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'hidden') return 'ignored';
      if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
      return 'textbox';
    }
    case 'textarea':
      return 'textbox';
    case 'select': {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    case 'option':
      return 'option';
    case 'img':
      return el.getAttribute('alt') === '' ? 'none' : 'image';
    case 'svg':
      return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'image' : 'generic';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'form':
      return 'form';
    case 'section':
    case 'aside':
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic';
    case 'article':
      return 'article';
    case 'figure':
      return 'figure';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'li':
      return 'listitem';
    case 'dialog':
      return 'dialog';
    case 'details':
      return 'group';
    case 'label':
      return 'label';
    case 'progress':
      return 'progressbar';
    case 'iframe':
    case 'frame':
      return 'iframe';
    default:
      return (el as HTMLElement).isContentEditable && !el.closest('[contenteditable="true"] [contenteditable="true"]')
        ? 'textbox'
        : 'generic';
  }
};

const visibleText = (el: Element): string => {
  const text = el instanceof HTMLElement ? el.innerText : (el.textContent ?? '');
  return collapse(text);
};

const labelledByText = (el: Element): string => {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const doc = el.ownerDocument;
  return collapse(
    ids
      .split(/\s+/)
      .map(id => doc.getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map(n => n.getAttribute('aria-label') || visibleText(n))
      .join(' '),
  );
};

const associatedLabel = (el: Element): string => {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    return collapse(
      Array.from(labels)
        .map(l => visibleText(l))
        .join(' '),
    );
  }
  const wrapping = el.closest('label');
  return wrapping ? visibleText(wrapping) : '';
};

const takesTextName = (role: string): boolean =>
  INTERACTIVE_ROLES.has(role) || role === 'heading' || role === 'label' || role === 'iframe';

/** Accessible name: aria-label → aria-labelledby → <label> → alt/title/placeholder → own text. */
const computeName = (el: Element, role: string): string => {
  const ariaLabel = collapse(el.getAttribute('aria-label') ?? '');
  if (ariaLabel) return ariaLabel.slice(0, NAME_MAX);
  const byRef = labelledByText(el);
  if (byRef) return byRef.slice(0, NAME_MAX);

  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'meter' || tag === 'progress') {
    const label = associatedLabel(el);
    if (label) return label.slice(0, NAME_MAX);
    if (tag === 'input') {
      const type = inputType(el as HTMLInputElement);
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = collapse((el as HTMLInputElement).value);
        if (v) return v.slice(0, NAME_MAX);
        return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
      }
      if (type === 'image') return collapse(el.getAttribute('alt') ?? '').slice(0, NAME_MAX);
    }
  }

  const alt = el.getAttribute('alt');
  if (alt && (tag === 'img' || tag === 'area')) return collapse(alt).slice(0, NAME_MAX);
  if (tag === 'svg') {
    const title = el.querySelector(':scope > title');
    if (title) return collapse(title.textContent ?? '').slice(0, NAME_MAX);
  }
  if (tag === 'iframe' || tag === 'frame') {
    return collapse(el.getAttribute('title') ?? el.getAttribute('name') ?? '').slice(0, NAME_MAX);
  }

  // Own text names a control — except <select>, whose text is its option list.
  if (takesTextName(role) && tag !== 'select') {
    const own = visibleText(el);
    if (own) return own.slice(0, NAME_MAX);
  }

  const title = collapse(el.getAttribute('title') ?? '');
  if (title) return title.slice(0, NAME_MAX);
  const placeholder = collapse(el.getAttribute('placeholder') ?? '');
  if (placeholder && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) {
    return placeholder.slice(0, NAME_MAX);
  }
  return '';
};

const isFocusable = (el: Element, role: string): boolean => {
  if ((el as HTMLInputElement).disabled) return false;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  if (INTERACTIVE_ROLES.has(role)) return role !== 'option';
  return (el as HTMLElement).isContentEditable;
};

const currentValue = (el: Element): string | null => {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = inputType(input);
    if (type === 'password' || type === 'checkbox' || type === 'radio' || type === 'file' || type === 'hidden') {
      return null;
    }
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return null;
    return input.value;
  }
  if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
  if (tag === 'select') {
    const s = el as HTMLSelectElement;
    const opt = s.selectedOptions[0];
    return opt ? collapse(opt.textContent ?? opt.value) : '';
  }
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'slider') {
    return el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow');
  }
  return null;
};

/** Attribute tokens in the contract's fixed order. */
const computeAttrs = (el: Element, role: string): string => {
  const out: string[] = [];
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const aria = (n: string) => el.getAttribute(n);

  if (
    (tag === 'input' && (inputType(input) === 'checkbox' || inputType(input) === 'radio') && input.checked) ||
    aria('aria-checked') === 'true'
  ) {
    out.push('checked');
  }
  if (input.disabled === true || aria('aria-disabled') === 'true') out.push('disabled');
  if (aria('aria-expanded') === 'true' || (tag === 'details' && (el as HTMLDetailsElement).open)) {
    out.push('expanded');
  }
  if ((tag === 'option' && (el as HTMLOptionElement).selected) || aria('aria-selected') === 'true') {
    out.push('selected');
  }
  if (aria('aria-pressed') === 'true') out.push('pressed');
  if (el.ownerDocument.activeElement === el) out.push('focused');
  if (isFocusable(el, role)) out.push('focusable');
  if (input.required === true || aria('aria-required') === 'true') out.push('required');
  if (input.readOnly === true || aria('aria-readonly') === 'true') out.push('readonly');

  if (role === 'heading') {
    const level = aria('aria-level') ?? (/^h[1-6]$/.test(tag) ? tag[1] : '');
    if (level) out.push(`level=${level}`);
  }

  const value = currentValue(el);
  if (value !== null && value !== '') out.push(`value=${quote(collapse(value).slice(0, VALUE_MAX))}`);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) out.push(`placeholder=${quote(collapse(placeholder))}`);

  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href) out.push(`href=${quote(href.slice(0, HREF_MAX))}`);
  }
  if (role === 'image' || role === 'img') {
    const src = el.getAttribute('src');
    if (src) out.push(`url=${quote(src.slice(0, IMG_URL_MAX))}`);
  }
  return out.join(' ');
};

const iframeHost = (el: Element): string => {
  const src = el.getAttribute('src') ?? '';
  try {
    return new URL(src, el.ownerDocument.location.href).host || src;
  } catch {
    return src;
  }
};

const sameOriginDocument = (el: Element): Document | null => {
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    if (!doc) return null;
    // Touching location throws across origins even when contentDocument is set.
    void doc.location.href;
    return doc;
  } catch {
    return null;
  }
};

/** Composed children: shadow root content and slot assignments over light DOM. */
const childrenOf = (el: Element): Node[] => {
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  if (el.tagName.toLowerCase() === 'slot') {
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    if (assigned.length > 0) return assigned;
  }
  return Array.from(el.childNodes);
};

interface WalkContext {
  verbose: boolean;
  snapshotId: number;
  seq: number;
  nextNodeToUid: Map<Node, string>;
  nextUidToRecord: Map<string, SnapshotRecord>;
  lines: WalkNode[];
}

const assignUid = (ctx: WalkContext, node: Node, role: string, name: string): { uid: string; isNew: boolean } => {
  const existing = nodeToUid.get(node);
  const uid = existing ?? `${ctx.snapshotId}_${ctx.seq++}`;
  ctx.nextNodeToUid.set(node, uid);
  ctx.nextUidToRecord.set(uid, { node, role, name });
  return { uid, isNew: hasPrevious && existing === undefined };
};

const walkText = (ctx: WalkContext, text: Text, depth: number, ancestorNames: string[]) => {
  const raw = collapse(text.data);
  if (!raw) return;
  const name = raw.slice(0, TEXT_MAX);
  if (!ctx.verbose && ancestorNames.some(n => n === name || n === raw)) return;
  const { uid, isNew } = assignUid(ctx, text, 'statictext', name);
  ctx.lines.push({ uid, role: 'statictext', name, attrs: '', suffix: '', isNew, depth });
};

const walkElement = (ctx: WalkContext, el: Element, depth: number, ancestorNames: string[]) => {
  if (SKIP_TAGS.has(el.tagName)) return;
  if (isOverlayNode(el)) return;
  if (isElementHidden(el)) return;

  const role = computeRole(el);
  if (role === 'ignored') return;

  if (role === 'iframe') {
    const doc = sameOriginDocument(el);
    if (!doc) {
      const name = iframeHost(el);
      const { uid, isNew } = assignUid(ctx, el, 'iframe', name);
      ctx.lines.push({ uid, role: 'iframe', name, attrs: '', suffix: ' (cross-origin)', isNew, depth });
      return;
    }
    const name = computeName(el, role);
    const keep = ctx.verbose || name !== '';
    let childDepth = depth;
    if (keep) {
      const { uid, isNew } = assignUid(ctx, el, role, name);
      ctx.lines.push({ uid, role, name, attrs: '', suffix: '', isNew, depth });
      childDepth = depth + 1;
    }
    if (doc.body) {
      for (const child of Array.from(doc.body.childNodes)) walkNode(ctx, child, childDepth, ancestorNames);
    }
    return;
  }

  // Zero-size non-landmark boxes are wrappers, not things; their children may
  // still overflow into view, so only the box itself is dropped.
  const zero = !LANDMARK_ROLES.has(role) && isZeroRect(el) && !displayContents(el);
  const name = zero ? '' : computeName(el, role);
  const droppable = role === 'generic' || role === 'none' || role === 'label' || role === 'group';
  const interesting = INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role) || name !== '';
  const keep = !zero && (ctx.verbose ? true : interesting && !(droppable && name === ''));

  let childDepth = depth;
  let names = ancestorNames;
  if (keep) {
    const { uid, isNew } = assignUid(ctx, el, role, name);
    ctx.lines.push({ uid, role, name, attrs: computeAttrs(el, role), suffix: '', isNew, depth });
    childDepth = depth + 1;
    if (name) names = [...ancestorNames, name];
  }

  // Native controls render their value/options themselves; descending into
  // <select> would list every option as a node.
  const tag = el.tagName.toLowerCase();
  if (tag === 'select' && !ctx.verbose) return;
  if (tag === 'textarea' || tag === 'input' || tag === 'svg' || tag === 'canvas' || tag === 'video') return;

  for (const child of childrenOf(el)) walkNode(ctx, child, childDepth, names);
};

const walkNode = (ctx: WalkContext, node: Node, depth: number, ancestorNames: string[]) => {
  if (node.nodeType === Node.TEXT_NODE) walkText(ctx, node as Text, depth, ancestorNames);
  else if (node.nodeType === Node.ELEMENT_NODE) walkElement(ctx, node as Element, depth, ancestorNames);
};

const formatLine = (n: WalkNode): string => {
  const indent = '  '.repeat(n.depth);
  const star = n.isNew ? '*' : '';
  const parts = [`${star}uid=${n.uid}`, n.role];
  if (n.name !== '' || n.role === 'RootWebArea') parts.push(quote(n.name));
  if (n.attrs) parts.push(n.attrs);
  return `${indent}${parts.join(' ')}${n.suffix}`;
};

interface TakeSnapshotOptions {
  verbose?: boolean;
  snapshotId?: number;
}

interface SnapshotOutput {
  snapshot: string;
  url: string;
  title: string;
  nodeCount: number;
  source: 'dom';
  snapshotId: number;
}

const takeSnapshot = (opts: TakeSnapshotOptions = {}): SnapshotOutput => {
  resetIfNewDocument();
  const snapshotId = typeof opts.snapshotId === 'number' ? opts.snapshotId : ++localCounter;
  const ctx: WalkContext = {
    verbose: opts.verbose === true,
    snapshotId,
    seq: 0,
    nextNodeToUid: new Map(),
    nextUidToRecord: new Map(),
    lines: [],
  };

  const title = collapse(document.title);
  const root = assignUid(ctx, document, 'RootWebArea', title);
  ctx.lines.push({
    uid: root.uid,
    role: 'RootWebArea',
    name: title,
    attrs: '',
    suffix: '',
    isNew: root.isNew,
    depth: 0,
  });

  if (document.body) {
    for (const child of Array.from(document.body.childNodes)) walkNode(ctx, child, 1, title ? [title] : []);
  }

  nodeToUid = ctx.nextNodeToUid;
  uidToRecord = ctx.nextUidToRecord;
  hasPrevious = true;
  lastSnapshotId = snapshotId;

  return {
    snapshot: ctx.lines.map(formatLine).join('\n'),
    url: location.href,
    title: document.title,
    nodeCount: ctx.lines.length,
    source: 'dom',
    snapshotId,
  };
};

const hasSnapshot = (): boolean => {
  resetIfNewDocument();
  return uidToRecord.size > 0;
};

const uidErrors = {
  none: 'No snapshot for this tab. Call ext_take_snapshot first.',
  missing: (uid: string) =>
    `Element uid "${uid}" not found in the latest snapshot. Take a new snapshot with ext_take_snapshot.`,
  detached: (uid: string) =>
    `Element uid "${uid}" was detached or no longer exists on the page. Take a new snapshot with ext_take_snapshot.`,
};

/** The live element behind a uid, with the contract's verbatim errors. */
const resolveUidElement = (uid: string): { el: HTMLElement; record: SnapshotRecord } => {
  resetIfNewDocument();
  if (uidToRecord.size === 0) throw new Error(uidErrors.none);
  const record = uidToRecord.get(uid);
  if (!record) throw new Error(uidErrors.missing(uid));
  const { node } = record;
  const el: Element | null =
    node.nodeType === Node.DOCUMENT_NODE
      ? (node as Document).documentElement
      : node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
  if (!el || !node.isConnected) throw new Error(uidErrors.detached(uid));
  return { el: el as HTMLElement, record };
};

/** Rect in top-frame CSS viewport pixels (adds each ancestor frame's offset). */
const topFrameRect = (el: Element): { x: number; y: number; width: number; height: number } => {
  const r = el.getBoundingClientRect();
  let x = r.x;
  let y = r.y;
  let win: Window | null = el.ownerDocument.defaultView;
  while (win && win !== win.parent) {
    let frame: Element | null = null;
    try {
      frame = win.frameElement;
    } catch {
      frame = null;
    }
    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    x += fr.x + frame.clientLeft;
    y += fr.y + frame.clientTop;
    win = frame.ownerDocument.defaultView;
  }
  return { x, y, width: r.width, height: r.height };
};

const describe = (el: Element, record: SnapshotRecord) => {
  const rect = topFrameRect(el);
  return {
    center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
    rect,
    tag: el.tagName.toLowerCase(),
    role: record.role,
    name: record.name,
  };
};

const resolveUid = (uid: string): BrowserResolveUidResult => {
  const { el, record } = resolveUidElement(uid);
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  return { found: true, ...describe(el, record) };
};

/** Keyword scoring over the current uid map (contract §1 Finding). */
const findInSnapshot = (query: string, limit: number): FoundElement[] => {
  resetIfNewDocument();
  const q = collapse(query).toLowerCase();
  const words = q.split(' ').filter(Boolean);
  if (!q) return [];

  const scored: FoundElement[] = [];
  for (const [uid, record] of uidToRecord) {
    if (record.role === 'RootWebArea') continue;
    const node = record.node;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || !node.isConnected) continue;

    const name = record.name.toLowerCase();
    const id = (el.getAttribute('id') ?? '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase();
    const ownText = name ? '' : collapse(el.textContent ?? '').toLowerCase();
    // A nameless container's text is the whole region under it; a substring
    // hit there says nothing about which element the model wants.
    const text = name || (ownText.length <= TEXT_MAX ? ownText : '');

    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 10;
      if (record.role === w) score += 5;
      if (id.includes(w) || ariaLabel.includes(w)) score += 3;
    }
    if (text && text.includes(q)) score += 2;
    if (score === 0) continue;

    const d = describe(el, record);
    scored.push({ uid, tag: d.tag, role: d.role, text: record.name || text, score, center: d.center, rect: d.rect });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
};

const currentSnapshotId = (): number => lastSnapshotId;

export {
  takeSnapshot,
  hasSnapshot,
  resolveUid,
  resolveUidElement,
  findInSnapshot,
  currentSnapshotId,
  computeRole,
  computeName,
};
