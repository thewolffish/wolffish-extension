import './Options.css';
import { t } from '@extension/i18n';
import { ErrorDisplay, LoadingSpinner } from '@extension/ui';
import { STORAGE_KEY_OVERLAY_ENABLED, withErrorBoundary, withSuspense } from '@extension/shared';
import { useCallback, useEffect, useState } from 'react';

const useTheme = (): 'light' | 'dark' => {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return theme;
};

/**
 * Everything the browser side of Wolffish can be set to: the overlay switch
 * (a plain storage flag the service worker honours, read live so the side
 * panel and this page never disagree) and site access, the one setting a page
 * can fix for the user — `permissions.request` needs a user gesture, and a
 * click in extension UI is one.
 */
const useSettings = () => {
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [allUrls, setAllUrls] = useState<boolean | null>(null);

  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY_OVERLAY_ENABLED]).then(bag => {
      setOverlayEnabled(bag[STORAGE_KEY_OVERLAY_ENABLED] !== false);
    });
    chrome.permissions
      ?.contains({ origins: ['<all_urls>'] })
      .then(setAllUrls)
      .catch(() => setAllUrls(null));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && STORAGE_KEY_OVERLAY_ENABLED in changes) {
        setOverlayEnabled(changes[STORAGE_KEY_OVERLAY_ENABLED].newValue !== false);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const toggleOverlay = useCallback((enabled: boolean) => {
    setOverlayEnabled(enabled);
    chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_ENABLED]: enabled }).catch(() => {});
  }, []);

  const requestAllUrls = useCallback(async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      setAllUrls(granted);
    } catch {
      setAllUrls(false);
    }
  }, []);

  const openDetails = useCallback(() => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch(() => {});
  }, []);

  return { overlayEnabled, allUrls, toggleOverlay, requestAllUrls, openDetails };
};

interface SwitchProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

const Switch = ({ checked, label, onChange }: SwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={`switch ${checked ? 'on' : ''}`}
    onClick={() => onChange(!checked)}>
    <span className="switch-knob" />
  </button>
);

const Options = () => {
  const theme = useTheme();
  const dir = t('bidiDir') || 'ltr';
  const settings = useSettings();
  const logoUrl = chrome.runtime.getURL('side-panel/wolffish-logo.png');
  // `null` means the browser would not answer (Firefox, a policy-managed
  // profile): say nothing rather than accuse it of being misconfigured.
  const accessKnown = settings.allUrls !== null;

  return (
    <div className={`settings ${theme}`} dir={dir}>
      <div className="shell">
        <header className="head">
          <img src={logoUrl} alt="" className="head-logo" />
          <div className="head-text">
            <h1 className="head-title">{t('settingsTitle')}</h1>
            <p className="head-sub">{t('settingsSubtitle')}</p>
          </div>
          <code className="head-version">v{chrome.runtime.getManifest().version}</code>
        </header>

        <section className="card">
          <h2 className="card-title">{t('sectionOnPage')}</h2>
          <div className="row">
            <div className="row-text">
              <span className="row-label">{t('overlayToggle')}</span>
              <span className="row-hint">{t('overlayHint')}</span>
            </div>
            <Switch checked={settings.overlayEnabled} label={t('overlayToggle')} onChange={settings.toggleOverlay} />
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">{t('sectionAccess')}</h2>
          {accessKnown && (
            <div className="row">
              <div className="row-text">
                <span className="row-label">
                  <span className={`status-dot ${settings.allUrls ? 'ok' : 'warn'}`} />
                  {settings.allUrls ? t('siteAccessOk') : t('siteAccessMissing')}
                </span>
                <span className="row-hint">{t('siteAccessHint')}</span>
              </div>
              {!settings.allUrls && (
                <button type="button" className="btn primary" onClick={() => void settings.requestAllUrls()}>
                  {t('siteAccessFix')}
                </button>
              )}
            </div>
          )}
          <div className="row">
            <div className="row-text">
              <span className="row-label">{t('openDetails')}</span>
              <span className="row-hint">{t('detailsHint')}</span>
            </div>
            <button type="button" className="btn" onClick={settings.openDetails}>
              {t('openAction')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <LoadingSpinner />), ErrorDisplay);
