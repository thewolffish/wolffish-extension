import { log } from '@extension/shared';

const api = globalThis.chrome;

/**
 * Wolffish never drives tabs the user opened. Everything it touches lives in a
 * tab group it creates and owns, which is both a safety boundary (a command can
 * never land on the page the user was reading) and the status surface: the
 * group's title is where the model says what it is doing right now.
 *
 * Nothing here is required for the extension to work — a browser without the
 * `tabGroups` API (Firefox, older Chromium) still gets its own dedicated tab,
 * just not the coloured group around it.
 */
const WOLFFISH_GROUP_TITLE = 'Wolffish';

/**
 * chrome.tabGroups accepts only a fixed colour enum, so the Wolffish primary
 * (#1b365d) maps to its nearest member.
 */
const WOLFFISH_GROUP_COLOR: `${chrome.tabGroups.Color}` = 'blue';

const KEY_GROUP_ID = 'wf:group-id';
const KEY_TAB_ID = 'wf:tab-id';
const KEY_LABEL = 'wf:group-label';

interface ActivityLabel {
  emoji?: string;
  text?: string;
}

/**
 * MV3 service workers are torn down between commands, so which tab/group is
 * ours cannot live in module scope. `storage.session` has exactly the right
 * lifetime — it dies with the browser session, and so do tab groups.
 */
const stateArea = (): chrome.storage.StorageArea => api.storage.session ?? api.storage.local;

const readState = async <T>(key: string): Promise<T | null> => {
  try {
    const bag = await stateArea().get(key);
    return (bag?.[key] as T) ?? null;
  } catch {
    return null;
  }
};

const writeState = async (key: string, value: unknown): Promise<void> => {
  try {
    await stateArea().set({ [key]: value });
  } catch {
    // Storage is best-effort: losing it costs a fresh tab, never a failed command.
  }
};

const clearState = async (key: string): Promise<void> => {
  try {
    await stateArea().remove(key);
  } catch {
    // See writeState.
  }
};

const formatLabel = (label: ActivityLabel | null): string => {
  const emoji = (label?.emoji ?? '').trim();
  const text = (label?.text ?? '').trim();
  if (emoji && text) return `${emoji} ${text}`;
  return emoji || text || WOLFFISH_GROUP_TITLE;
};

/** The remembered group id, or null once the user has closed that group. */
const liveGroupId = async (): Promise<number | null> => {
  if (!api.tabGroups) return null;
  const groupId = await readState<number>(KEY_GROUP_ID);
  if (typeof groupId !== 'number') return null;
  const alive = await api.tabGroups
    .get(groupId)
    .then(() => true)
    .catch(() => false);
  if (!alive) {
    await clearState(KEY_GROUP_ID);
    return null;
  }
  return groupId;
};

const paintGroup = async (groupId: number): Promise<void> => {
  if (!api.tabGroups) return;
  const label = await readState<ActivityLabel>(KEY_LABEL);
  try {
    await api.tabGroups.update(groupId, { title: formatLabel(label), color: WOLFFISH_GROUP_COLOR });
  } catch {
    // The group can vanish between the check and the paint.
  }
};

/** Put a tab into the Wolffish group, creating the group on first use. */
const groupTab = async (tabId: number): Promise<number | null> => {
  if (!api.tabGroups || !api.tabs.group) return null;

  const existing = await liveGroupId();
  if (existing !== null) {
    try {
      await api.tabs.group({ groupId: existing, tabIds: [tabId] });
      await paintGroup(existing);
      return existing;
    } catch {
      await clearState(KEY_GROUP_ID);
    }
  }

  try {
    const tab = await api.tabs.get(tabId);
    const groupId = await api.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await writeState(KEY_GROUP_ID, groupId);
    await paintGroup(groupId);
    return groupId;
  } catch (err) {
    log('tab groups unavailable:', err instanceof Error ? err.message : String(err));
    return null;
  }
};

/** The Wolffish group, or null before it exists / after the user closes it. */
const getWorkspaceGroupId = (): Promise<number | null> => liveGroupId();

/** Is this tab one of ours? Used to keep user tabs out of Wolffish's hands. */
const isWorkspaceTab = async (tab: chrome.tabs.Tab): Promise<boolean> => {
  const groupId = await liveGroupId();
  return groupId !== null && tab.groupId === groupId;
};

/** The current Wolffish tab, or null when it has been closed. */
const getWorkspaceTabId = async (): Promise<number | null> => {
  const tabId = await readState<number>(KEY_TAB_ID);
  if (typeof tabId !== 'number') return null;
  const alive = await api.tabs
    .get(tabId)
    .then(() => true)
    .catch(() => false);
  if (!alive) {
    await clearState(KEY_TAB_ID);
    return null;
  }
  return tabId;
};

/** Take ownership of a tab Wolffish created — into the group, and made current. */
const adoptTab = async (tabId: number): Promise<void> => {
  await writeState(KEY_TAB_ID, tabId);
  await groupTab(tabId);
};

/** Open a brand-new tab inside the Wolffish group and make it the current one. */
const openWorkspaceTab = async (url?: string, active = true): Promise<number> => {
  const tab = await api.tabs.create({ url: url || 'about:blank', active });
  const tabId = tab.id!;
  await adoptTab(tabId);
  return tabId;
};

/**
 * The tab every command falls back to. This is what replaces "whatever the user
 * happens to be looking at" as the default target.
 */
const ensureWorkspaceTab = async (): Promise<number> => {
  const existing = await getWorkspaceTabId();
  if (existing !== null) return existing;
  return openWorkspaceTab();
};

/**
 * Follow a tab switch, but only into a tab we own — switching to one of the
 * user's tabs must not make it the default target for later commands.
 */
const rememberWorkspaceTab = async (tabId: number): Promise<boolean> => {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || !(await isWorkspaceTab(tab))) return false;
  await writeState(KEY_TAB_ID, tabId);
  return true;
};

/** Model-set status shown on the tab group. No arguments resets it to "Wolffish". */
const setActivity = async (label: ActivityLabel): Promise<{ title: string; applied: boolean }> => {
  const next: ActivityLabel = { emoji: label.emoji?.trim() || undefined, text: label.text?.trim() || undefined };
  await writeState(KEY_LABEL, next);

  const groupId = await liveGroupId();
  if (groupId !== null) await paintGroup(groupId);

  return { title: formatLabel(next), applied: groupId !== null };
};

export type { ActivityLabel };

export {
  WOLFFISH_GROUP_TITLE,
  adoptTab,
  ensureWorkspaceTab,
  getWorkspaceGroupId,
  isWorkspaceTab,
  openWorkspaceTab,
  rememberWorkspaceTab,
  setActivity,
};
