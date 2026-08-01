/**
 * Browser identity for the multi-browser handshake.
 *
 * The same unpacked extension folder produces the SAME extension id in every
 * Chromium browser (unpacked ids derive from the absolute path), so
 * chrome.runtime.id cannot tell Chrome from Edge from Brave. Identity is
 * therefore detected from the environment and paired with a stable, randomly
 * generated instance id persisted in chrome.storage.local — the Wolffish app
 * uses it to recognise a reconnecting browser and replace its stale socket
 * instead of listing the same browser twice.
 */

const api = globalThis.chrome;

const INSTANCE_ID_KEY = 'wf:instance-id';

interface BrowserIdentity {
  instanceId: string;
  browser: string;
  browserName: string;
  browserVersion: string;
  os: string;
  /** Signed-in profile email — the only profile identity extensions can read. Empty when signed out. */
  profileEmail: string;
}

type UABrand = { brand: string; version: string };
type UANavigator = Navigator & {
  userAgentData?: { brands?: UABrand[]; platform?: string };
  brave?: { isBrave?: () => Promise<boolean> };
};

const detectOS = (nav: UANavigator, ua: string): string => {
  const platform = nav.userAgentData?.platform ?? '';
  if (/mac/i.test(platform) || /Mac OS X/.test(ua)) return 'macOS';
  if (/win/i.test(platform) || /Windows NT/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/android/i.test(platform) || /Android/.test(ua)) return 'Android';
  if (/linux/i.test(platform) || /Linux/.test(ua)) return 'Linux';
  return platform || '';
};

const uaVersion = (ua: string, token: string): string => {
  const match = ua.match(new RegExp(`${token}/([\\d.]+)`));
  return match?.[1] ?? '';
};

/**
 * Conservative detection: only browsers that positively identify themselves
 * get a specific slug; everything else reports as plain chromium/browser.
 * (Arc and Vivaldi deliberately masquerade as Chrome — they will show as
 * Chrome, which is the honest ceiling of what the environment exposes.)
 */
const detectBrand = async (
  nav: UANavigator,
  ua: string,
): Promise<Omit<BrowserIdentity, 'instanceId' | 'os' | 'profileEmail'>> => {
  // Firefox is the one browser with a first-party identity API.
  try {
    const gecko = (globalThis as Record<string, unknown>).browser as
      | { runtime?: { getBrowserInfo?: () => Promise<{ name: string; version: string }> } }
      | undefined;
    const info = await gecko?.runtime?.getBrowserInfo?.();
    if (info?.name) {
      return { browser: info.name.toLowerCase(), browserName: info.name, browserVersion: info.version };
    }
  } catch {
    // not Firefox
  }

  const brands = nav.userAgentData?.brands ?? [];
  const brand = (needle: string): UABrand | undefined => brands.find(b => b.brand.toLowerCase().includes(needle));

  const KNOWN: Array<{ needle: string; slug: string; name: string }> = [
    { needle: 'microsoft edge', slug: 'edge', name: 'Microsoft Edge' },
    { needle: 'opera', slug: 'opera', name: 'Opera' },
    { needle: 'brave', slug: 'brave', name: 'Brave' },
    { needle: 'vivaldi', slug: 'vivaldi', name: 'Vivaldi' },
    { needle: 'google chrome', slug: 'chrome', name: 'Google Chrome' },
  ];
  for (const { needle, slug, name } of KNOWN) {
    const hit = brand(needle);
    if (hit) return { browser: slug, browserName: name, browserVersion: hit.version || uaVersion(ua, 'Chrome') };
  }

  // Brave hides itself from some contexts' brands but exposes navigator.brave.
  try {
    if (await nav.brave?.isBrave?.()) {
      return { browser: 'brave', browserName: 'Brave', browserVersion: uaVersion(ua, 'Chrome') };
    }
  } catch {
    // not Brave
  }

  if (/Edg\//.test(ua)) return { browser: 'edge', browserName: 'Microsoft Edge', browserVersion: uaVersion(ua, 'Edg') };
  if (/OPR\//.test(ua)) return { browser: 'opera', browserName: 'Opera', browserVersion: uaVersion(ua, 'OPR') };
  if (/Firefox\//.test(ua))
    return { browser: 'firefox', browserName: 'Firefox', browserVersion: uaVersion(ua, 'Firefox') };
  if (brand('chromium') || /Chrome\//.test(ua))
    return { browser: 'chromium', browserName: 'Chromium', browserVersion: uaVersion(ua, 'Chrome') };
  return { browser: 'browser', browserName: 'Browser', browserVersion: '' };
};

/**
 * Distinguishes Chrome profiles: each profile is a separate connection with
 * an otherwise identical label. Chrome-only API (Firefox lacks
 * getProfileUserInfo); returns '' when signed out or unsupported.
 */
const getProfileEmail = async (): Promise<string> => {
  try {
    const identity = api?.identity as
      | { getProfileUserInfo?: (details: { accountStatus: string }) => Promise<{ email?: string }> }
      | undefined;
    const info = await identity?.getProfileUserInfo?.({ accountStatus: 'ANY' });
    return info?.email ?? '';
  } catch {
    return '';
  }
};

const getInstanceId = async (): Promise<string> => {
  try {
    const data = await api.storage.local.get([INSTANCE_ID_KEY]);
    const existing = data[INSTANCE_ID_KEY];
    if (typeof existing === 'string' && existing) return existing;
  } catch {
    // fall through to a fresh id
  }
  const id = crypto.randomUUID();
  try {
    await api.storage.local.set({ [INSTANCE_ID_KEY]: id });
  } catch {
    // ephemeral id is still better than none
  }
  return id;
};

let cached: BrowserIdentity | null = null;

const getBrowserIdentity = async (): Promise<BrowserIdentity> => {
  if (cached) return cached;
  const nav = navigator as UANavigator;
  const ua = nav.userAgent ?? '';
  const [instanceId, brand, profileEmail] = await Promise.all([
    getInstanceId(),
    detectBrand(nav, ua),
    getProfileEmail(),
  ]);
  cached = { instanceId, ...brand, os: detectOS(nav, ua), profileEmail };
  return cached;
};

export { getBrowserIdentity };
export type { BrowserIdentity };
