import type { BrowserTakeSnapshotResult, FoundElement } from '@extension/shared';
import { nextSnapshotId, sendCDP } from './cdp-session';
import type { Session, SnapshotNode, UidRef } from './cdp-session';
import { center, nodeRect } from './cdp-dom';

const api = globalThis.chrome;

// ─── CDP shapes (only the fields we read) ────────────────────────────────────

interface AXValue {
  type: string;
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
  templateContent?: DomNode;
  frameId?: string;
}

interface DomInfo {
  tag: string;
  attrs: Record<string, string>;
  hasContentDocument: boolean;
  frameId?: string;
}

// ─── Role sets (contract §1) ─────────────────────────────────────────────────

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

const OVERLAY_TAG = 'WOLFFISH-OVERLAY';

// ─── DOM index ───────────────────────────────────────────────────────────────

/**
 * backendNodeId → tag/attributes for the whole page (iframes and shadow roots
 * pierced). The AX tree carries roles and names; hrefs, srcs, placeholders and
 * ids only live here. Nodes under the Wolffish overlay host are collected so
 * the walker can drop them — the agent must never see its own cursor.
 */
const indexDom = (root: DomNode): { dom: Map<number, DomInfo>; overlay: Set<number> } => {
  const dom = new Map<number, DomInfo>();
  const overlay = new Set<number>();
  const stack: { node: DomNode; inOverlay: boolean }[] = [{ node: root, inOverlay: false }];
  while (stack.length > 0) {
    const { node, inOverlay } = stack.pop()!;
    const attrs: Record<string, string> = {};
    const flat = node.attributes ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]] = flat[i + 1];
    const hidden = inOverlay || node.nodeName === OVERLAY_TAG;
    if (hidden) overlay.add(node.backendNodeId);
    dom.set(node.backendNodeId, {
      tag: node.nodeName.toLowerCase(),
      attrs,
      hasContentDocument: node.contentDocument !== undefined,
      frameId: node.frameId,
    });
    const kids = [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
      ...(node.templateContent ? [node.templateContent] : []),
    ];
    for (const kid of kids) stack.push({ node: kid, inOverlay: hidden });
  }
  return { dom, overlay };
};

// ─── AX tree assembly ────────────────────────────────────────────────────────

const fetchAXNodes = async (tabId: number, frameId?: string): Promise<AXNode[]> => {
  const res = (await sendCDP(tabId, 'Accessibility.getFullAXTree', frameId ? { frameId } : {})) as {
    nodes?: AXNode[];
  };
  return res.nodes ?? [];
};

/**
 * Accessibility roles, lowercased — except the document root, which every
 * DevTools-style snapshot spells `RootWebArea`. The DOM fallback emits the
 * same spelling, so a model never sees two vocabularies for one page.
 */
const roleOf = (node: AXNode): string => {
  const raw = String(node.role?.value ?? 'generic');
  return raw.toLowerCase() === 'rootwebarea' ? 'RootWebArea' : raw.toLowerCase();
};

/**
 * Roles that exist only inside the accessibility tree's own text machinery.
 * Chrome emits one `inlinetextbox` per rendered line of a text node, so a
 * paragraph that wraps five times becomes five nodes with no element behind
 * them — pure noise that also collides with real role names when the model
 * searches the tree ("textbox" matches "inlinetextbox").
 */
const NOISE_ROLES = new Set(['inlinetextbox', 'linebreak']);

/**
 * Same-process child frames sometimes arrive inline in the main tree and
 * sometimes not (it depends on the Chrome build). When an iframe node has no
 * children but the DOM shows a content document, fetch that frame's tree and
 * graft it under the iframe node, namespacing ids so the two trees cannot
 * collide.
 */
const graftChildFrames = async (tabId: number, byId: Map<string, AXNode>, dom: Map<number, DomInfo>): Promise<void> => {
  const iframes = [...byId.values()].filter(n => roleOf(n) === 'iframe' && !(n.childIds && n.childIds.length > 0));
  for (const iframe of iframes) {
    const info = iframe.backendDOMNodeId !== undefined ? dom.get(iframe.backendDOMNodeId) : undefined;
    const frameId = info?.frameId ?? iframe.frameId;
    if (!info?.hasContentDocument || !frameId) continue;
    let nodes: AXNode[];
    try {
      nodes = await fetchAXNodes(tabId, frameId);
    } catch {
      continue;
    }
    const prefix = `${frameId}:`;
    const roots: string[] = [];
    for (const n of nodes) {
      const id = prefix + n.nodeId;
      const grafted: AXNode = {
        ...n,
        nodeId: id,
        parentId: n.parentId ? prefix + n.parentId : iframe.nodeId,
        childIds: (n.childIds ?? []).map(c => prefix + c),
      };
      if (!n.parentId) roots.push(id);
      byId.set(id, grafted);
    }
    iframe.childIds = roots;
  }
};

// ─── Line rendering ──────────────────────────────────────────────────────────

const escapeText = (s: string): string => s.replace(/\s+/g, ' ').replace(/"/g, '\\"');

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

const boolProp = (props: Map<string, unknown>, name: string): boolean => props.get(name) === true;

/** Tri-state props (`true` / `false` / `mixed`): a flag for true, `name=mixed` for mixed. */
const triProp = (props: Map<string, unknown>, name: string): string | null => {
  const v = props.get(name);
  if (v === true || v === 'true') return name;
  if (v === 'mixed') return `${name}=mixed`;
  return null;
};

const attributesFor = (node: AXNode, role: string, info: DomInfo | undefined): string => {
  const props = new Map<string, unknown>((node.properties ?? []).map(p => [p.name, p.value.value]));
  const parts: string[] = [];
  const checked = triProp(props, 'checked');
  if (checked) parts.push(checked);
  if (boolProp(props, 'disabled')) parts.push('disabled');
  if (boolProp(props, 'expanded')) parts.push('expanded');
  if (boolProp(props, 'selected')) parts.push('selected');
  const pressed = triProp(props, 'pressed');
  if (pressed) parts.push(pressed);
  if (boolProp(props, 'focused')) parts.push('focused');
  if (boolProp(props, 'focusable')) parts.push('focusable');
  if (boolProp(props, 'required')) parts.push('required');
  if (boolProp(props, 'readonly')) parts.push('readonly');
  const level = props.get('level');
  if (typeof level === 'number') parts.push(`level=${level}`);
  const axValue = node.value?.value;
  const value = axValue !== undefined && axValue !== '' ? String(axValue) : (info?.attrs.value ?? '');
  if (value) parts.push(`value="${escapeText(value)}"`);
  const placeholder = info?.attrs.placeholder ?? '';
  if (placeholder) parts.push(`placeholder="${escapeText(placeholder)}"`);
  if (role === 'link' && info?.attrs.href) parts.push(`href="${escapeText(clip(info.attrs.href, 200))}"`);
  if ((role === 'image' || role === 'img') && info?.attrs.src)
    parts.push(`url="${escapeText(clip(info.attrs.src, 120))}"`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

const hostOf = (src: string): string => {
  try {
    return new URL(src).host || src;
  } catch {
    return src;
  }
};

// ─── Snapshot ────────────────────────────────────────────────────────────────

interface BuildContext {
  session: Session;
  verbose: boolean;
  snapshotId: number;
  byId: Map<string, AXNode>;
  dom: Map<number, DomInfo>;
  overlay: Set<number>;
  lines: string[];
  nextUidMap: Map<string, UidRef>;
  nextUidByNode: Map<string, string>;
  nodes: SnapshotNode[];
  counter: number;
  /** Whether this document was snapshotted before — gates the `*` new marker. */
  hadSnapshot: boolean;
}

/** Keep the old uid for a node the previous snapshot of this document already had. */
const assignUid = (ctx: BuildContext, node: AXNode): { uid: string; isNew: boolean } => {
  const key =
    node.backendDOMNodeId !== undefined ? `${ctx.session.loaderId}:${node.backendDOMNodeId}` : `ax:${node.nodeId}`;
  const previous = ctx.session.uidByNode.get(key);
  const uid = previous ?? `${ctx.snapshotId}_${ctx.counter++}`;
  // The first snapshot of a document has no predecessor, so marking every
  // node new says nothing; `*` only means "appeared since you last looked".
  ctx.nextUidByNode.set(key, uid);
  if (node.backendDOMNodeId !== undefined) {
    ctx.nextUidMap.set(uid, {
      backendNodeId: node.backendDOMNodeId,
      loaderId: ctx.session.loaderId,
      frameId: node.frameId,
    });
  }
  return { uid, isNew: ctx.hadSnapshot && previous === undefined };
};

const isInteresting = (role: string, name: string): boolean =>
  INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role) || name.trim() !== '';

const emit = (ctx: BuildContext, node: AXNode, depth: number, text: string): string => {
  const { uid, isNew } = assignUid(ctx, node);
  ctx.lines.push(`${'  '.repeat(depth)}${isNew ? '*' : ''}uid=${uid} ${text}`);
  return uid;
};

const walk = (ctx: BuildContext, node: AXNode, depth: number, ancestorNames: string[]): void => {
  if (node.backendDOMNodeId !== undefined && ctx.overlay.has(node.backendDOMNodeId)) return;
  const children = (node.childIds ?? []).map(id => ctx.byId.get(id)).filter((n): n is AXNode => n !== undefined);

  if (node.ignored) {
    for (const child of children) walk(ctx, child, depth, ancestorNames);
    return;
  }

  let role = roleOf(node);
  if (NOISE_ROLES.has(role) && !ctx.verbose) {
    for (const child of children) walk(ctx, child, depth, ancestorNames);
    return;
  }
  // Accessible names arrive with the source's whitespace ("\n  I agree").
  const name = String(node.name?.value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const info = node.backendDOMNodeId !== undefined ? ctx.dom.get(node.backendDOMNodeId) : undefined;
  const editable = info?.attrs.contenteditable;
  if (role === 'generic' && editable !== undefined && editable !== 'false') role = 'textbox';

  // A cross-origin frame is a wall: one line saying so, nothing behind it.
  if (role === 'iframe' && info && !info.hasContentDocument && children.length === 0) {
    emit(ctx, node, depth, `iframe "${escapeText(hostOf(info.attrs.src ?? ''))}" (cross-origin)`);
    return;
  }

  let keep = ctx.verbose || isInteresting(role, name);
  // `button "Save"` already says what its `statictext "Save"` child would.
  if (keep && !ctx.verbose && role === 'statictext' && ancestorNames.includes(name.trim().toLowerCase())) keep = false;

  if (!keep) {
    for (const child of children) walk(ctx, child, depth, ancestorNames);
    return;
  }

  const label = name ? ` "${escapeText(name)}"` : '';
  const uid = emit(ctx, node, depth, `${role}${label}${attributesFor(node, role, info)}`);
  if (node.backendDOMNodeId !== undefined) {
    ctx.nodes.push({
      uid,
      role,
      name,
      tag: info?.tag ?? '',
      backendNodeId: node.backendDOMNodeId,
      id: info?.attrs.id ?? '',
      ariaLabel: info?.attrs['aria-label'] ?? '',
    });
  }
  const next = name.trim() ? [...ancestorNames, name.trim().toLowerCase()] : ancestorNames;
  for (const child of children) walk(ctx, child, depth + 1, next);
};

const takeSnapshot = async (session: Session, verbose: boolean): Promise<BrowserTakeSnapshotResult> => {
  const tabId = session.tabId;
  const [axNodes, doc, tab] = await Promise.all([
    fetchAXNodes(tabId),
    sendCDP(tabId, 'DOM.getDocument', { depth: -1, pierce: true }) as Promise<{ root: DomNode }>,
    api.tabs.get(tabId).catch(() => null),
  ]);
  const { dom, overlay } = indexDom(doc.root);
  const byId = new Map<string, AXNode>(axNodes.map(n => [n.nodeId, n]));
  await graftChildFrames(tabId, byId, dom);

  const snapshotId = await nextSnapshotId(session);
  const ctx: BuildContext = {
    session,
    verbose,
    snapshotId,
    byId,
    dom,
    overlay,
    lines: [],
    nextUidMap: new Map(),
    nextUidByNode: new Map(),
    nodes: [],
    counter: 0,
    hadSnapshot: session.hasSnapshot,
  };
  const roots = axNodes.filter(n => !n.parentId || !byId.has(n.parentId));
  for (const root of roots) walk(ctx, root, 0, []);

  // Every snapshot replaces the live uid map; nodes not seen this pass are evicted.
  session.uidMap = ctx.nextUidMap;
  session.uidByNode = ctx.nextUidByNode;
  session.snapshotNodes = ctx.nodes;
  session.hasSnapshot = true;

  return {
    snapshot: ctx.lines.join('\n'),
    url: tab?.url ?? '',
    title: tab?.title ?? '',
    nodeCount: ctx.lines.length,
    source: 'cdp',
    snapshotId,
  };
};

// ─── uid lookup ──────────────────────────────────────────────────────────────

const NO_SNAPSHOT_ERROR = 'No snapshot for this tab. Call ext_take_snapshot first.';

const uidNotFoundError = (uid: string): string =>
  `Element uid "${uid}" not found in the latest snapshot. Take a new snapshot with ext_take_snapshot.`;

const uidDetachedError = (uid: string): string =>
  `Element uid "${uid}" was detached or no longer exists on the page. Take a new snapshot with ext_take_snapshot.`;

const lookupUid = (session: Session, uid: string): UidRef => {
  if (!session.hasSnapshot) throw new Error(NO_SNAPSHOT_ERROR);
  const ref = session.uidMap.get(uid);
  if (!ref || ref.loaderId !== session.loaderId) throw new Error(uidNotFoundError(uid));
  return ref;
};

/** Run a CDP operation on a uid's node, translating "node is gone" into the contract's detached phrase. */
const withUidErrors = async <T>(uid: string, op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no node|not found|could not find|detached|does not have a layout object|invalid/i.test(message)) {
      throw new Error(uidDetachedError(uid));
    }
    throw err;
  }
};

// ─── Find ────────────────────────────────────────────────────────────────────

const scoreNode = (node: SnapshotNode, words: string[]): number => {
  const name = node.name.toLowerCase();
  const nameWords = new Set(name.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const id = node.id.toLowerCase();
  const aria = node.ariaLabel.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (nameWords.has(w)) score += 10;
    if (node.role === w || node.tag === w) score += 5;
    if ((id && id.includes(w)) || (aria && aria.includes(w))) score += 3;
    if (name.includes(w)) score += 2;
  }
  return score;
};

const findInSnapshot = async (session: Session, query: string, limit: number): Promise<FoundElement[]> => {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return [];
  const ranked = session.snapshotNodes
    .map(node => ({ node, score: scoreNode(node, words) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
  const out: FoundElement[] = [];
  for (const { node, score } of ranked) {
    try {
      const rect = await nodeRect(session.tabId, node.backendNodeId);
      out.push({ uid: node.uid, tag: node.tag, role: node.role, text: node.name, score, center: center(rect), rect });
    } catch {
      // The node went away since the snapshot; the rest of the ranking still stands.
    }
  }
  return out;
};

export {
  NO_SNAPSHOT_ERROR,
  findInSnapshot,
  lookupUid,
  takeSnapshot,
  uidDetachedError,
  uidNotFoundError,
  withUidErrors,
};
