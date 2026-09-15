import {
  ACTION_DOM_QUIET_MAX_MS,
  ACTION_DOM_QUIET_MS,
  ACTION_NAV_SETTLE_MAX_MS,
  ACTION_NAV_START_MS,
} from '@extension/shared';
import type { ActionAftermath } from '@extension/shared';

const api = globalThis.chrome;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** What the page looked like just before an action, for the after/before comparison. */
interface ActionBefore {
  url: string;
  mutations: number;
}

/**
 * Did a top-frame navigation start within the grace window? Listens for the
 * commit and also reads the tab, because a click that navigates synchronously
 * may have committed before the listener was installed.
 */
const navigationStarted = async (tabId: number, beforeUrl: string): Promise<boolean> => {
  let started = false;
  const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
    if (d.tabId === tabId && d.frameId === 0) started = true;
  };
  api.webNavigation?.onCommitted?.addListener(onCommitted);
  try {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (tab && (tab.status === 'loading' || (beforeUrl && tab.url && tab.url !== beforeUrl))) return true;
    await sleep(ACTION_NAV_START_MS);
    if (started) return true;
    const after = await api.tabs.get(tabId).catch(() => null);
    return !!after && (after.status === 'loading' || (!!beforeUrl && !!after.url && after.url !== beforeUrl));
  } finally {
    api.webNavigation?.onCommitted?.removeListener(onCommitted);
  }
};

/** Poll until the tab reports `complete` (cap ACTION_NAV_SETTLE_MAX_MS); returns whatever it settled on. */
const settleNavigation = async (tabId: number): Promise<chrome.tabs.Tab | null> => {
  const deadline = Date.now() + ACTION_NAV_SETTLE_MAX_MS;
  let tab: chrome.tabs.Tab | null = null;
  while (Date.now() < deadline) {
    tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete') return tab;
    await sleep(100);
  }
  return tab;
};

/**
 * A page-resident mutation counter.
 *
 * Observing only *after* the action misses the common case entirely: a click
 * handler that appends a node runs synchronously, so by the time an observer
 * is installed the change has already happened and the page looks unchanged.
 * A counter installed once and read before and after catches those, and the
 * observer below still catches the late, asynchronous ones.
 */
const mutationCounterInPage = (): number => {
  const w = window as unknown as { __wfMutations?: number; __wfMutationObserver?: MutationObserver };
  if (w.__wfMutationObserver) return w.__wfMutations ?? 0;
  const root = document.body ?? document.documentElement;
  if (!root) return 0;
  w.__wfMutations = 0;
  const observer = new MutationObserver(records => {
    w.__wfMutations = (w.__wfMutations ?? 0) + records.length;
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  w.__wfMutationObserver = observer;
  return 0;
};

const readMutations = async (tabId: number): Promise<number> => {
  const results = await api.scripting
    .executeScript({ target: { tabId }, func: mutationCounterInPage, world: 'MAIN' })
    .catch(() => []);
  const value = results[0]?.result;
  return typeof value === 'number' ? value : 0;
};

/** Page-side quiet wait: resolves once mutations stop for `quietMs`, or after `maxMs`. */
const domQuietInPage = (quietMs: number, maxMs: number): Promise<boolean> =>
  new Promise<boolean>(resolve => {
    const root = document.body ?? document.documentElement;
    if (!root) return resolve(false);
    let changed = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      observer.disconnect();
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(capTimer);
      resolve(changed);
    };
    const armQuiet = (): void => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const observer = new MutationObserver(() => {
      changed = true;
      armQuiet();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    const capTimer = setTimeout(finish, maxMs);
    armQuiet();
  });

const domSettled = async (tabId: number): Promise<boolean> => {
  const results = await api.scripting
    .executeScript({
      target: { tabId },
      func: domQuietInPage,
      args: [ACTION_DOM_QUIET_MS, ACTION_DOM_QUIET_MAX_MS],
    })
    .catch(() => []);
  return results[0]?.result === true;
};

/**
 * Snapshot the page's state before an input command. Cheap by construction:
 * one scripting call that installs the counter on first use and reads it
 * every time. Never throws — the aftermath is a courtesy, not a contract.
 */
const captureBefore = async (tabId: number): Promise<ActionBefore> => {
  try {
    const tab = await api.tabs.get(tabId).catch(() => null);
    return { url: tab?.url ?? '', mutations: await readMutations(tabId) };
  } catch {
    return { url: '', mutations: 0 };
  }
};

/**
 * Post-action wait for INPUT commands. Reports a navigation the action caused
 * (settled, so the URL and title are the destination's) or whether the DOM
 * actually moved. Never throws: an aftermath failure must not fail the action
 * that succeeded.
 */
const waitAfterAction = async (tabId: number, before?: ActionBefore): Promise<ActionAftermath> => {
  try {
    if (await navigationStarted(tabId, before?.url ?? '')) {
      const tab = await settleNavigation(tabId);
      if (!tab) return {};
      return { navigated: { url: tab.url ?? '', title: tab.title ?? '' } };
    }
    // Wait for the page to go quiet, then compare counters. The late observer
    // catches async work; the counter catches what already happened.
    const lateChange = await domSettled(tabId);
    const after = await readMutations(tabId);
    const changed = lateChange || (before !== undefined && after > before.mutations);
    return { domChanged: changed };
  } catch {
    return {};
  }
};

export type { ActionBefore };
export { captureBefore, waitAfterAction };
