import type { OverlayPayload } from '@extension/shared';

/**
 * On-page presence overlay: a top-centre pill ("Wolffish is working in this
 * tab") plus a shadow cursor that glides to wherever the service worker is
 * acting. Plain DOM inside a closed shadow root so page CSS cannot restyle it
 * and page scripts cannot reach in. Visuals are copied from the desktop
 * computer-use overlay so the two surfaces read as one product.
 *
 * The host lives on `document.documentElement`, not body: SPA frameworks
 * replace body wholesale, and a MutationObserver re-appends the host when a
 * page removes it.
 */

const HOST_TAG = 'wolffish-overlay';
const TARGET_RING_MS = 600;
const LABEL_MAX_CHARS = 80;

const COPY = {
  en: { reading: 'Wolffish is reading this tab', working: 'Wolffish is working in this tab', dir: 'ltr' },
  ar: { reading: 'وولفيش يقرأ هذا التبويب', working: 'وولفيش يعمل في هذا التبويب', dir: 'rtl' },
} as const;

// Cursor SVGs and CSS values: verbatim from the desktop overlay (overlay.mjs).
const ARROW_SVG =
  '<svg id="arrow" width="28" height="36" viewBox="0 0 28 36"><path d="M2 2 L2 28 L9 21 L14 33 L19 31 L14 19 L24 19 Z" fill="#FFFFFF" stroke="#0B1A3A" stroke-width="2" stroke-linejoin="round"/></svg>';
const KBD_SVG =
  '<svg id="kbd" width="30" height="20" viewBox="0 0 30 20"><rect x="1" y="1" width="28" height="18" rx="4" fill="#FFFFFF" stroke="#0B1A3A" stroke-width="2"/><rect x="5" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="11" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="17" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="7" y="11" width="16" height="3" fill="#0B1A3A"/></svg>';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";

const STYLE =
  ':host{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block}' +
  '#chip{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:8px;' +
  'padding:7px 16px;border-radius:999px;background:rgba(8,15,33,.42);' +
  'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
  'border:1px solid rgba(96,165,250,.3);color:rgba(226,236,255,.62);' +
  `font:500 13px/1.2 ${FONT};letter-spacing:.2px;white-space:nowrap;max-width:calc(100vw - 40px);` +
  'overflow:hidden;text-overflow:ellipsis;opacity:0}' +
  '#chip.show{display:flex;animation:fi .45s ease-out forwards}' +
  '#dot{flex:none;width:7px;height:7px;border-radius:50%;background:#60A5FA;box-shadow:0 0 8px 2px rgba(96,165,250,.55);' +
  'animation:db 2.4s ease-in-out infinite}' +
  // Shadow cursor. #cur is translated so its (0,0) is the hotspot: the arrow
  // tip sits at the container origin; halo, ring and badge are centred on it;
  // the label hangs below.
  '#cur{position:fixed;left:0;top:0;width:0;height:0;transform:translate(-100px,-100px);will-change:transform;display:none}' +
  '#cur.show{display:block}' +
  '#halo{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(59,130,246,.28);' +
  'box-shadow:0 0 14px 4px rgba(59,130,246,.35)}' +
  '#arrow{position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
  '#kbd{position:absolute;left:-15px;top:-10px;display:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
  '#blob{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;background:rgba(59,130,246,.35);' +
  'border:2px dashed rgba(255,255,255,.85);display:none}' +
  '#cur.kind-keyboard #arrow{display:none}#cur.kind-keyboard #kbd{display:block}' +
  '#cur.kind-approximate #arrow{display:none}#cur.kind-approximate #blob{display:block}' +
  '#ring{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:3px solid #60A5FA;opacity:0}' +
  '#ring.on{animation:rg .55s ease-out}' +
  '#lbl{position:absolute;left:14px;top:30px;white-space:nowrap;padding:3px 8px;border-radius:6px;background:rgba(8,15,33,.7);' +
  `color:#E4ECFF;font:500 11px/1.2 ${FONT};max-width:260px;overflow:hidden;text-overflow:ellipsis}` +
  '#lbl:empty{display:none}' +
  '#target{position:fixed;left:0;top:0;width:0;height:0;border:2px solid rgba(59,130,246,.95);border-radius:4px;' +
  'box-sizing:border-box;display:none;opacity:0}' +
  '#target.on{display:block;animation:tg .6s ease-out forwards}' +
  '@keyframes fi{to{opacity:1}}' +
  '@keyframes db{0%,100%{opacity:.45}50%{opacity:1}}' +
  '@keyframes rg{0%{opacity:.9;transform:scale(.5)}100%{opacity:0;transform:scale(1.8)}}' +
  '@keyframes tg{0%{opacity:1}70%{opacity:1}100%{opacity:0}}' +
  '@media (prefers-reduced-motion:reduce){#chip.show{opacity:1}#target.on{opacity:1}' +
  '#chip,#dot,#cur,#ring,#target{animation:none!important;transition:none!important}}';

interface CursorState {
  x: number;
  y: number;
  kind: 'pointer' | 'keyboard' | 'approximate';
  label: string;
}

interface PillState {
  mode: 'working' | 'reading';
  text?: string;
}

/** Survives a body swap: re-mounting replays the last pill and cursor. */
const overlayState: { pill: PillState | null; cursor: CursorState | null; captureHidden: boolean } = {
  pill: null,
  cursor: null,
  captureHidden: false,
};

interface Mounted {
  host: HTMLElement;
  chip: HTMLElement;
  chipText: HTMLElement;
  cur: HTMLElement;
  ring: HTMLElement;
  lbl: HTMLElement;
  target: HTMLElement;
}

let mounted: Mounted | null = null;
let targetTimer: ReturnType<typeof setTimeout> | null = null;
let reappendObserver: MutationObserver | null = null;

const uiLanguage = (): keyof typeof COPY => {
  try {
    return globalThis.chrome?.i18n?.getUILanguage?.().startsWith('ar') ? 'ar' : 'en';
  } catch {
    return 'en';
  }
};

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

const isOverlayNode = (node: Node | null | undefined): boolean => {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return false;
  if (el.tagName.toLowerCase() === HOST_TAG) return true;
  // Shadow content: the closed root's host is what closest() lands on.
  const root = el.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : null;
  if (host && host.tagName.toLowerCase() === HOST_TAG) return true;
  return el.closest(HOST_TAG) !== null;
};

const mount = (): Mounted => {
  if (mounted && mounted.host.isConnected) return mounted;
  if (mounted) {
    document.documentElement.appendChild(mounted.host);
    return mounted;
  }

  const host = document.createElement(HOST_TAG);
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('inert', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  const chip = document.createElement('div');
  chip.id = 'chip';
  const dot = document.createElement('div');
  dot.id = 'dot';
  const chipText = document.createElement('span');
  chip.append(dot, chipText);

  const cur = document.createElement('div');
  cur.id = 'cur';
  const halo = document.createElement('div');
  halo.id = 'halo';
  const ring = document.createElement('div');
  ring.id = 'ring';
  const blob = document.createElement('div');
  blob.id = 'blob';
  const lbl = document.createElement('div');
  lbl.id = 'lbl';
  const svgs = document.createElement('template');
  svgs.innerHTML = ARROW_SVG + KBD_SVG;
  cur.append(halo, ring, svgs.content, blob, lbl);

  const target = document.createElement('div');
  target.id = 'target';

  shadow.append(chip, cur, target);
  document.documentElement.appendChild(host);

  mounted = { host, chip, chipText, cur, ring, lbl, target };

  // Pages that prune unknown children of <html> (or swap it) take the host
  // with them; put it back and replay state.
  reappendObserver = new MutationObserver(() => {
    if (mounted && !mounted.host.isConnected && document.documentElement) {
      document.documentElement.appendChild(mounted.host);
      restore();
    }
  });
  reappendObserver.observe(document.documentElement, { childList: true });

  return mounted;
};

const applyPill = (m: Mounted, pill: PillState) => {
  const lang = uiLanguage();
  const t = COPY[lang];
  m.chip.dir = t.dir;
  m.chipText.textContent = pill.mode === 'reading' ? t.reading : pill.text || t.working;
  m.chip.classList.add('show');
};

const applyCursor = (m: Mounted, c: CursorState, animate: boolean) => {
  const prev = overlayState.cursor;
  const wasShown = m.cur.classList.contains('show');
  m.cur.className = `show kind-${c.kind}`;
  m.lbl.textContent = c.label;

  let ms = 0;
  if (animate && wasShown && prev && !reducedMotion()) {
    // Glide time scales with distance so short hops feel snappy and long
    // ones stay followable.
    const d = Math.hypot(c.x - prev.x, c.y - prev.y);
    ms = Math.min(340, Math.max(140, 140 + d * 0.25));
  }
  m.cur.style.transition = ms > 0 ? `transform ${ms}ms cubic-bezier(.3,.9,.35,1)` : 'none';
  void m.cur.offsetWidth;
  m.cur.style.transform = `translate(${c.x}px,${c.y}px)`;
};

const restore = () => {
  if (!mounted) return;
  if (overlayState.pill) applyPill(mounted, overlayState.pill);
  if (overlayState.cursor) applyCursor(mounted, overlayState.cursor, false);
  mounted.host.style.visibility = overlayState.captureHidden ? 'hidden' : '';
};

const showTarget = (m: Mounted, rect: { x: number; y: number; width: number; height: number }) => {
  if (targetTimer) clearTimeout(targetTimer);
  const t = m.target;
  t.style.left = `${rect.x - 2}px`;
  t.style.top = `${rect.y - 2}px`;
  t.style.width = `${rect.width + 4}px`;
  t.style.height = `${rect.height + 4}px`;
  t.classList.remove('on');
  void t.offsetWidth;
  t.classList.add('on');
  targetTimer = setTimeout(() => {
    t.classList.remove('on');
    targetTimer = null;
  }, TARGET_RING_MS);
};

const handleOverlay = (payload: OverlayPayload): void => {
  switch (payload.op) {
    case 'pill': {
      const pill: PillState = { mode: payload.mode === 'reading' ? 'reading' : 'working', text: payload.text };
      overlayState.pill = pill;
      applyPill(mount(), pill);
      break;
    }
    case 'cursor': {
      if (typeof payload.x !== 'number' || typeof payload.y !== 'number') return;
      const kind = payload.kind === 'keyboard' || payload.kind === 'approximate' ? payload.kind : 'pointer';
      const cursor: CursorState = {
        x: payload.x,
        y: payload.y,
        kind,
        label: (payload.label ?? '').slice(0, LABEL_MAX_CHARS),
      };
      applyCursor(mount(), cursor, payload.animate !== false);
      overlayState.cursor = cursor;
      break;
    }
    case 'pulse': {
      const m = mount();
      m.ring.classList.remove('on');
      void m.ring.offsetWidth;
      m.ring.classList.add('on');
      break;
    }
    case 'target': {
      if (!payload.rect) return;
      showTarget(mount(), payload.rect);
      break;
    }
    case 'hide': {
      overlayState.pill = null;
      overlayState.cursor = null;
      if (!mounted) return;
      mounted.chip.classList.remove('show');
      mounted.cur.className = '';
      mounted.target.classList.remove('on');
      break;
    }
    case 'capture_hide': {
      overlayState.captureHidden = true;
      if (mounted) mounted.host.style.visibility = 'hidden';
      break;
    }
    case 'capture_show': {
      overlayState.captureHidden = false;
      if (mounted) mounted.host.style.visibility = '';
      break;
    }
  }
};

export { HOST_TAG as OVERLAY_HOST_TAG, handleOverlay, isOverlayNode };
