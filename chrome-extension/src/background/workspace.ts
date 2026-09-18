import { log } from '@extension/shared';

const api = globalThis.chrome;

/**
 * Wolffish never drives tabs the user opened. Everything it touches lives in a
 * tab group it creates and owns, which is both a safety boundary (a command can
 * never land on the page the user was reading) and the status surface: the
 * group's title is where the model says what it is doing right now.
 *
 * One group per *session* — a session being the conversation the command came
 * from. Two jobs running at once, or one straight after another, each get their
 * own group, their own tab, and their own title; "posting on X" can never be
 * left hanging over the job that posts on LinkedIn. A command with no session
 * (an older desktop build, the panel's own test run) uses one shared default.
 *
 * Nothing here is required for the extension to work — a browser without the
 * `tabGroups` API (Firefox, older Chromium) still gets a dedicated tab per
 * session, just not the coloured group around it.
 */
const WOLFFISH_GROUP_TITLE = 'Wolffish';

/**
 * chrome.tabGroups accepts only a fixed colour enum, so the Wolffish primary
 * (#1b365d) maps to its nearest member.
 */
const WOLFFISH_GROUP_COLOR: `${chrome.tabGroups.Color}` = 'blue';

const KEY_WORKSPACES = 'wf:workspaces';

/** Where commands that carry no session land. */
const DEFAULT_SESSION = '_';

/** Records past this many are dropped oldest-first, so storage cannot grow without bound. */
const MAX_SESSIONS = 32;

/** A record younger than this is never pruned, even with nothing open yet — a session that has only set its label still owns it. */
const PRUNE_GRACE_MS = 10 * 60_000;

interface ActivityLabel {
  emoji?: string;
  text?: string;
}

/** One session's workspace: the group it owns, the tab commands default to, the title it wrote. */
interface SessionWorkspace {
  groupId?: number;
  tabId?: number;
  label?: ActivityLabel;
  /** Last touched, in ms — orders pruning. */
  at: number;
}

type WorkspaceState = Record<string, SessionWorkspace>;

/**
 * MV3 service workers are torn down between commands, so which tab/group belongs
 * to whom cannot live in module scope. `storage.session` has exactly the right
 * lifetime — it dies with the browser session, and so do tab groups.
 */
const stateArea = (): chrome.storage.StorageArea => api.storage.session ?? api.storage.local;

const readAll = async (): Promise<WorkspaceState> => {
  try {
    const bag = await stateArea().get(KEY_WORKSPACES);
    const value = bag?.[KEY_WORKSPACES];
    return value && typeof value === 'object' ? (value as WorkspaceState) : {};
  } catch {
    return {};
  }
};

const writeAll = async (state: WorkspaceState): Promise<void> => {
  try {
    await stateArea().set({ [KEY_WORKSPACES]: state });
  } catch {
    // Storage is best-effort: losing it costs a fresh tab, never a failed command.
  }
};

/**
 * Every mutation is read-modify-write against one storage key, and two sessions
 * really do run at once — so they take turns. Without this, the second job's
 * `set` would carry a copy of the state it read before the first job's `set`
 * landed, and one of the two groups would be forgotten the moment it was made.
 */
let chain: Promise<unknown> = Promise.resolve();

const mutate = <T>(fn: (state: WorkspaceState) => Promise<T>): Promise<T> => {
  const run = async (): Promise<T> => {
    const state = await readAll();
    const result = await fn(state);
    await writeAll(state);
    return result;
  };
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const sessionKey = (session?: string | null): string => (session ?? '').trim() || DEFAULT_SESSION;

const groupAlive = async (groupId?: number): Promise<boolean> => {
  if (!api.tabGroups || typeof groupId !== 'number') return false;
  return api.tabGroups
    .get(groupId)
    .then(() => true)
    .catch(() => false);
};

const tabAlive = async (tabId?: number): Promise<boolean> => {
  if (typeof tabId !== 'number') return false;
  return api.tabs
    .get(tabId)
    .then(() => true)
    .catch(() => false);
};

/**
 * Drop records whose group and tab are both gone — the user closed that job's
 * work — and cap what is left. Only runs when a session is seen for the first
 * time, which is rare; every other command pays nothing for it.
 */
const prune = async (state: WorkspaceState): Promise<void> => {
  const now = Date.now();
  for (const [key, entry] of Object.entries(state)) {
    if (now - (entry.at ?? 0) < PRUNE_GRACE_MS) continue;
    if ((await groupAlive(entry.groupId)) || (await tabAlive(entry.tabId))) continue;
    delete state[key];
  }
  const keys = Object.keys(state);
  if (keys.length <= MAX_SESSIONS) return;
  keys
    .sort((a, b) => (state[a].at ?? 0) - (state[b].at ?? 0))
    .slice(0, keys.length - MAX_SESSIONS)
    .forEach(key => delete state[key]);
};

const entryFor = async (state: WorkspaceState, session?: string | null): Promise<SessionWorkspace> => {
  const key = sessionKey(session);
  if (!state[key]) {
    await prune(state);
    state[key] = { at: Date.now() };
  } else {
    state[key].at = Date.now();
  }
  return state[key];
};

const formatLabel = (label: ActivityLabel | null | undefined): string => {
  const emoji = (label?.emoji ?? '').trim();
  const text = (label?.text ?? '').trim();
  if (emoji && text) return `${emoji} ${text}`;
  return emoji || text || WOLFFISH_GROUP_TITLE;
};

const paintGroup = async (groupId: number, label?: ActivityLabel): Promise<void> => {
  if (!api.tabGroups) return;
  try {
    await api.tabGroups.update(groupId, { title: formatLabel(label), color: WOLFFISH_GROUP_COLOR });
  } catch {
    // The group can vanish between the check and the paint.
  }
};

/** Put a tab into this session's group, creating the group on first use. */
const groupTab = async (entry: SessionWorkspace, tabId: number): Promise<void> => {
  if (!api.tabGroups || !api.tabs.group) return;

  if (await groupAlive(entry.groupId)) {
    try {
      await api.tabs.group({ groupId: entry.groupId, tabIds: [tabId] });
      await paintGroup(entry.groupId!, entry.label);
      return;
    } catch {
      entry.groupId = undefined;
    }
  }

  try {
    const tab = await api.tabs.get(tabId);
    const groupId = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    entry.groupId = groupId;
    await paintGroup(groupId, entry.label);
  } catch (err) {
    entry.groupId = undefined;
    log('tab groups unavailable:', err instanceof Error ? err.message : String(err));
  }
};

/** Every live Wolffish group, across all sessions. */
const getWorkspaceGroupIds = async (): Promise<number[]> => {
  if (!api.tabGroups) return [];
  const state = await readAll();
  const ids = [...new Set(Object.values(state).map(e => e.groupId))];
  const live: number[] = [];
  for (const id of ids) {
    if (await groupAlive(id)) live.push(id!);
  }
  return live;
};

/** Is this tab one of ours — any session's? Used to keep the user's tabs out of Wolffish's hands. */
const isWorkspaceTab = async (tab: chrome.tabs.Tab): Promise<boolean> => {
  if (typeof tab.groupId !== 'number' || tab.groupId < 0) return false;
  const ids = await getWorkspaceGroupIds();
  return ids.includes(tab.groupId);
};

/** Take ownership of a tab Wolffish created — into this session's group, and made its current tab. */
const adoptTab = async (tabId: number, session?: string | null): Promise<void> =>
  mutate(async state => {
    const entry = await entryFor(state, session);
    entry.tabId = tabId;
    await groupTab(entry, tabId);
  });

interface OpenTabOptions {
  url?: string;
  active?: boolean;
  session?: string | null;
}

/** Open a brand-new tab inside this session's group and make it its current one. */
const openWorkspaceTab = async ({ url, active = true, session }: OpenTabOptions = {}): Promise<number> =>
  mutate(async state => {
    const entry = await entryFor(state, session);
    const tab = await api.tabs.create({ url: url || 'about:blank', active });
    const tabId = tab.id!;
    entry.tabId = tabId;
    await groupTab(entry, tabId);
    return tabId;
  });

/**
 * The tab every command falls back to. This is what replaces "whatever the user
 * happens to be looking at" as the default target — and it is per session, so a
 * second job never lands on the page the first one is in the middle of.
 */
const ensureWorkspaceTab = async (session?: string | null): Promise<number> =>
  mutate(async state => {
    const entry = await entryFor(state, session);
    if (await tabAlive(entry.tabId)) return entry.tabId!;
    const tab = await api.tabs.create({ url: 'about:blank', active: true });
    const tabId = tab.id!;
    entry.tabId = tabId;
    await groupTab(entry, tabId);
    return tabId;
  });

/**
 * Follow a tab switch, but only into a tab Wolffish owns — switching to one of
 * the user's tabs must not make it the default target for later commands.
 */
const rememberWorkspaceTab = async (tabId: number, session?: string | null): Promise<boolean> => {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !(await isWorkspaceTab(tab))) return false;
  await mutate(async state => {
    const entry = await entryFor(state, session);
    entry.tabId = tabId;
  });
  return true;
};

/**
 * The activity label for the on-page pill: what the job driving this tab says it
 * is doing. The session that sent the command wins — it is the one acting, even
 * on a tab it does not own — and with no session the tab's owner answers. Never
 * a global label: a pill must not announce what some other job is up to.
 */
const getActivityLabel = async (tabId: number, session?: string | null): Promise<ActivityLabel | null> => {
  const state = await readAll();
  if (session) {
    const own = state[sessionKey(session)];
    if (own?.label) return own.label;
  }
  const tab = await api.tabs.get(tabId).catch(() => null);
  const entries = Object.values(state);
  const byGroup =
    tab && typeof tab.groupId === 'number' && tab.groupId >= 0
      ? entries.find(e => e.groupId === tab.groupId)
      : undefined;
  const owner = byGroup ?? entries.find(e => e.tabId === tabId);
  return owner?.label ?? null;
};

/** Model-set status shown on this session's tab group. No arguments resets it to "Wolffish". */
const setActivity = async (
  label: ActivityLabel,
  session?: string | null,
): Promise<{ title: string; applied: boolean }> =>
  mutate(async state => {
    const entry = await entryFor(state, session);
    const next: ActivityLabel = { emoji: label.emoji?.trim() || undefined, text: label.text?.trim() || undefined };
    entry.label = next;

    const applied = await groupAlive(entry.groupId);
    if (applied) await paintGroup(entry.groupId!, next);

    return { title: formatLabel(next), applied };
  });

export type { ActivityLabel };

export {
  WOLFFISH_GROUP_TITLE,
  adoptTab,
  ensureWorkspaceTab,
  getActivityLabel,
  getWorkspaceGroupIds,
  isWorkspaceTab,
  openWorkspaceTab,
  rememberWorkspaceTab,
  setActivity,
};
