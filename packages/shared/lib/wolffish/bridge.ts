import { LOG_PREFIX, CONTENT_SCRIPT_PING_TIMEOUT_MS, COMMAND_TIMEOUT_MS } from './constants.js';
import type { InternalMessage, WolffishResponse } from './types.js';

const api = globalThis.chrome ?? (globalThis as Record<string, unknown>).browser;

const log = (...args: unknown[]): void => {
  console.log(LOG_PREFIX, ...args);
};

const logError = (...args: unknown[]): void => {
  console.error(LOG_PREFIX, ...args);
};

const isFirefox = (): boolean => typeof (globalThis as Record<string, unknown>).browser !== 'undefined';

const sendToServiceWorker = (message: InternalMessage): void => {
  api?.runtime?.sendMessage(message);
};

const sendToServiceWorkerAsync = async (message: InternalMessage): Promise<unknown> =>
  api?.runtime?.sendMessage(message);

const sendToContentScript = async (tabId: number, message: InternalMessage): Promise<unknown> =>
  api?.tabs?.sendMessage(tabId, message);

const pingContentScript = async (tabId: number): Promise<boolean> => {
  try {
    const msg: InternalMessage = {
      source: 'service-worker',
      target: 'content-script',
      payload: { type: 'ping' },
    };
    const response = await Promise.race([
      api?.tabs?.sendMessage(tabId, msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONTENT_SCRIPT_PING_TIMEOUT_MS)),
    ]);
    return response && (response as { type?: string }).type === 'pong';
  } catch {
    return false;
  }
};

const ensureContentScriptInjected = async (tabId: number): Promise<void> => {
  const alive = await pingContentScript(tabId);
  if (alive) return;

  await api?.scripting?.executeScript({
    target: { tabId },
    files: ['content/all.iife.js'],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Content script injection timed out')), 5000);
    const listener = (message: InternalMessage) => {
      if (
        message?.source === 'content-script' &&
        'type' in message.payload &&
        (message.payload as { type: string }).type === 'pong'
      ) {
        clearTimeout(timeout);
        api?.runtime?.onMessage?.removeListener(listener);
        resolve();
      }
    };
    api?.runtime?.onMessage?.addListener(listener);
  });
};

const resolveTabId = async (params: { tabId?: number }): Promise<number> => {
  if (params.tabId !== undefined) return params.tabId;
  const tabs = await api?.tabs?.query({ active: true, currentWindow: true });
  if (!tabs?.length) throw new Error('No active tab found');
  return tabs[0].id!;
};

const withTimeout = <T>(promise: Promise<T>, ms: number = COMMAND_TIMEOUT_MS): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: command did not complete within ${ms}ms`)), ms),
    ),
  ]);

const makeResponse = (id: string, data: unknown): WolffishResponse => ({ id, success: true, data });

const makeErrorResponse = (id: string, error: string): WolffishResponse => ({ id, success: false, error });

const generateId = (): string => crypto.randomUUID();

export {
  log,
  logError,
  isFirefox,
  sendToServiceWorker,
  sendToServiceWorkerAsync,
  sendToContentScript,
  pingContentScript,
  ensureContentScriptInjected,
  resolveTabId,
  withTimeout,
  makeResponse,
  makeErrorResponse,
  generateId,
};
