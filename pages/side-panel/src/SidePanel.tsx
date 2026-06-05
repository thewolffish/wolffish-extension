import './SidePanel.css';
import { t } from '@extension/i18n';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { ErrorDisplay, LoadingSpinner } from '@extension/ui';
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
  const [view, setView] = useState<View>('events');
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
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
      }) => {
        if (response?.events?.length) setEvents(response.events);
        if (response?.conversations?.length) setConversations(response.conversations);
        if (response?.activeConversation) {
          setActiveConversation(response.activeConversation);
        } else {
          setView('conversations');
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
      }

      if (payload.event === 'events_sync' && payload.data) {
        const { conversationId, events: syncEvents } = payload.data as {
          conversationId: string;
          events: EventEntry[];
        };
        setActiveConversation(conversationId);
        setViewingConversation(null);
        setView('events');
        setEvents(syncEvents.slice().reverse());
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
        setViewingConversation(conversationId);
        setEvents(convEvents.slice().reverse());
        setView('events');
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
    chrome.runtime.sendMessage({ type: 'get_conversation_events', conversationId });
  }, []);

  const statusColor = STATUS_COLORS[status];
  const statusLabel = t(STATUS_KEYS[status]);
  const logoUrl = chrome.runtime.getURL('side-panel/wolffish-logo.png');

  const displayConversation = viewingConversation ?? activeConversation;
  const rawTitle =
    conversations.find(c => c.conversationId === displayConversation)?.title ?? displayConversation ?? '';
  const displayTitle = t(rawTitle as never) || rawTitle;

  return (
    <div className={`panel ${theme}`} dir={dir}>
      <header className="panel-header">
        <div className="panel-header-left">
          <img src={logoUrl} alt="Wolffish" className="panel-logo" />
          <span className="panel-title">{t('extensionName')}</span>
          <code className="panel-version">v{chrome.runtime.getManifest().version}</code>
          {port > 0 && <code className="panel-version">:{port}</code>}
        </div>
        <div className={`panel-status ${status !== 'connected' ? 'pulse' : ''}`}>
          <span className="panel-dot" style={{ backgroundColor: statusColor }} />
          <span className="panel-status-text" style={{ color: statusColor }}>
            {statusLabel}
          </span>
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
