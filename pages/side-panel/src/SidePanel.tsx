import './SidePanel.css';
import { t } from '@extension/i18n';
import { ErrorDisplay, LoadingSpinner } from '@extension/ui';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ConnectionStatus } from '@extension/shared';

const STATUS_COLORS = {
  connected: '#57CE51',
  connecting: '#FFB640',
  disconnected: '#FFB640',
} as const;

const STATUS_KEYS = {
  connected: 'statusConnected',
  connecting: 'statusConnecting',
  disconnected: 'statusDisconnected',
} as const;

// Motion reads the state before the label does: the icon spins while
// connecting, pulses while waiting for the app, and holds still when connected.
const STATUS_FX = {
  connected: '',
  connecting: 'spin',
  disconnected: 'pulse',
} as const;

// The status colour again at a given opacity — the alert's fill and border
// follow the same palette as its text, from the one set of constants.
const withAlpha = (hex: string, alpha: number): string => {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

const EVENT_TYPE_KEYS = {
  navigate: { key: 'eventTypeNav', color: '#3B82F6' },
  click: { key: 'eventTypeClick', color: '#8B5CF6' },
  type: { key: 'eventTypeType', color: '#EC4899' },
  read: { key: 'eventTypeRead', color: '#10B981' },
  tab: { key: 'eventTypeTab', color: '#F59E0B' },
  script: { key: 'eventTypeJs', color: '#EF4444' },
  cookie: { key: 'eventTypeCookie', color: '#6366F1' },
  wait: { key: 'eventTypeWait', color: '#14B8A6' },
  screenshot: { key: 'eventTypeSnap', color: '#F97316' },
  scroll: { key: 'eventTypeScroll', color: '#A78BFA' },
  download: { key: 'eventTypeDl', color: '#06B6D4' },
  debugger: { key: 'eventTypeDebug', color: '#DC2626' },
  move: { key: 'eventTypeMove', color: '#84CC16' },
  unknown: { key: 'eventTypeUnknown', color: '#6B7280' },
} as const;

type EventType = keyof typeof EVENT_TYPE_KEYS;

interface EventEntry {
  id: string;
  type: EventType;
  title: string;
  timestamp: number;
}

interface ConversationSummary {
  conversationId: string;
  title: string;
  eventCount: number;
  lastTimestamp: number;
}

type View = 'events' | 'conversations';

const GEAR_TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

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

const locale = t('locale') || chrome.i18n.getUILanguage();
const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });

const formatTime = (ts: number): string => {
  const diffSec = Math.round((ts - Date.now()) / 1000);
  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, 'second');
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, 'hour');
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
};

const formatRelative = (ts: number): string => {
  const diffMs = Date.now() - ts;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return t('justNow');
  if (diffMin < 60) return rtf.format(-diffMin, 'minute');
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, 'hour');
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return rtf.format(-diffDay, 'day');
  return new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
};

const SidePanel = () => {
  const theme = useTheme();
  const dir = t('bidiDir') || 'ltr';
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [port, setPort] = useState<number>(0);
  const [view, setView] = useState<View>('conversations');
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [, setPendingConversation] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [activeConversationTitle, setActiveConversationTitle] = useState<string | null>(null);
  const [viewingConversation, setViewingConversation] = useState<string | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: 'get_connection_status' },
      (response: { status?: ConnectionStatus; port?: number }) => {
        if (response?.status) setStatus(response.status);
        if (response?.port) setPort(response.port);
      },
    );

    chrome.runtime.sendMessage(
      { type: 'get_events' },
      (response: {
        events?: EventEntry[];
        conversations?: ConversationSummary[];
        activeConversation?: string | null;
        activeConversationTitle?: string | null;
      }) => {
        if (response?.events?.length) setEvents(response.events);
        if (response?.conversations?.length) setConversations(response.conversations);
        if (response?.activeConversation) {
          setActiveConversation(response.activeConversation);
          setActiveConversationTitle(response.activeConversationTitle ?? null);
        }
      },
    );

    const listener = (message: Record<string, unknown>) => {
      if (message.type === 'status_update' && message.status) {
        setStatus(message.status as ConnectionStatus);
        return;
      }

      const payload = message.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      if (payload.event === 'event_logged' && payload.data) {
        setEvents(prev => [payload.data as EventEntry, ...prev]);
        setView('events');
      }

      if (payload.event === 'events_sync' && payload.data) {
        const {
          conversationId,
          title,
          events: syncEvents,
        } = payload.data as {
          conversationId: string;
          title?: string;
          events: EventEntry[];
        };
        setActiveConversation(conversationId);
        setActiveConversationTitle(title ?? null);
        setViewingConversation(null);
        setView('events');
        if (syncEvents.length > 0) {
          setEvents(syncEvents.slice().reverse());
        }
      }

      if (payload.event === 'conversations_list' && payload.data) {
        const list = payload.data as ConversationSummary[];
        setConversations(list);
        if (list.length > 0) {
          setActiveConversation(prev => {
            if (!prev) setView('conversations');
            return prev;
          });
        }
      }

      if (payload.event === 'conversation_events' && payload.data) {
        const { conversationId, events: convEvents } = payload.data as {
          conversationId: string;
          events: EventEntry[];
        };
        // Only switch view if the user explicitly selected this conversation
        setPendingConversation(prev => {
          if (prev === conversationId) {
            setViewingConversation(conversationId);
            setEvents(convEvents.slice().reverse());
            setView('events');
            return null;
          }
          return prev;
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleOpenConversations = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'get_events' });
    setView('conversations');
  }, []);

  const handleSelectConversation = useCallback((conversationId: string) => {
    setPendingConversation(conversationId);
    chrome.runtime.sendMessage({ type: 'get_conversation_events', conversationId });
  }, []);

  const statusColor = STATUS_COLORS[status];
  const statusLabel = t(STATUS_KEYS[status]);
  const statusFx = STATUS_FX[status];
  const logoUrl = chrome.runtime.getURL('side-panel/wolffish-logo.png');

  const displayConversation = viewingConversation ?? activeConversation;
  const listTitle = conversations.find(c => c.conversationId === displayConversation)?.title;
  const rawTitle =
    (displayConversation === activeConversation && activeConversationTitle) ||
    (listTitle && listTitle !== 'Untitled' ? listTitle : null) ||
    activeConversationTitle ||
    displayConversation ||
    '';
  const displayTitle = t(rawTitle as never) || rawTitle;

  return (
    <div className={`panel ${theme}`} dir={dir}>
      <header className="panel-header">
        <div className="panel-header-row">
          <div className="panel-header-left">
            <img src={logoUrl} alt="Wolffish" className="panel-logo" />
            <span className="panel-title">{t('extensionName')}</span>
            <code className="panel-version">v{chrome.runtime.getManifest().version}</code>
            {port > 0 && <code className="panel-version">:{port}</code>}
          </div>
          <div className="panel-header-right">
            <button
              type="button"
              className="panel-gear"
              title={t('settingsTitle')}
              aria-label={t('settingsTitle')}
              onClick={() => chrome.runtime.openOptionsPage()}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
                <g fill="currentColor">
                  {GEAR_TEETH.map(angle => (
                    <rect
                      key={angle}
                      x="7"
                      y="0.9"
                      width="2"
                      height="3.4"
                      rx="0.7"
                      transform={`rotate(${angle} 8 8)`}
                    />
                  ))}
                  <path
                    fillRule="evenodd"
                    d="M8 2.8a5.2 5.2 0 1 0 0 10.4 5.2 5.2 0 0 0 0-10.4Zm0 3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z"
                  />
                </g>
              </svg>
            </button>
          </div>
        </div>
        <div
          className="panel-status-alert"
          role="status"
          style={{
            color: statusColor,
            backgroundColor: withAlpha(statusColor, 0.12),
            borderColor: withAlpha(statusColor, 0.4),
          }}>
          <span className={`panel-status-icon ${statusFx}`} aria-hidden="true">
            {status === 'connected' && (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path
                  d="M3.5 8.5 6.5 11.5 12.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {status === 'connecting' && (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path
                  d="M14 8a6 6 0 1 1 -4.15 -5.71"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {status === 'disconnected' && (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 14.7v-3.5" />
                  <path d="M6 5.4V1.8" />
                  <path d="M10 5.4V1.8" />
                  <path d="M12 5.4v3.2a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 8.6V5.4Z" />
                </g>
              </svg>
            )}
          </span>
          <span className="panel-status-text">{statusLabel}</span>
        </div>
      </header>

      {view === 'conversations' ? (
        <div className="panel-conversations">
          {conversations.length === 0 ? (
            <div className="panel-empty">{t('noConversations')}</div>
          ) : (
            conversations.map(conv => (
              <button
                key={conv.conversationId}
                className={`conversation-card ${conv.conversationId === activeConversation ? 'active' : ''}`}
                onClick={() => handleSelectConversation(conv.conversationId)}>
                <span className="conversation-name">{t(conv.title as never) || conv.title}</span>
                <span className="conversation-meta">
                  {t('eventsCount', String(conv.eventCount))} · {formatRelative(conv.lastTimestamp)}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <>
          {displayConversation && (
            <button className="conversation-bar" onClick={handleOpenConversations}>
              <span className="conversation-bar-chevron">{dir === 'rtl' ? '›' : '‹'}</span>
              <span className="conversation-bar-name">{displayTitle}</span>
            </button>
          )}
          <div className="panel-events">
            {events.length === 0 && (
              <div className={`panel-empty ${status === 'connected' ? '' : 'pulse'}`}>
                {status === 'connected' ? t('emptyConnected') : t('emptyDisconnected')}
              </div>
            )}
            {events.map(event => {
              const badge = EVENT_TYPE_KEYS[event.type];
              return (
                <div key={event.id} className="event-card">
                  <span className="event-badge" style={{ backgroundColor: badge.color }}>
                    {t(badge.key)}
                  </span>
                  <span className="event-title">{event.title}</span>
                  <span className="event-time">{formatTime(event.timestamp)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
