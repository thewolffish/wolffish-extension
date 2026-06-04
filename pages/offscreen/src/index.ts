import { DEFAULT_PORT, RECONNECT, HEARTBEAT_INTERVAL_MS, LOG_PREFIX } from '@extension/shared';
import { wolffishConnectionStorage } from '@extension/storage';
import type {
  WolffishCommand,
  WolffishResponse,
  WolffishEvent,
  InternalMessage,
  ConnectionStatus,
  ConnectionStatusPayload,
  ConnectionStatusResponse,
} from '@extension/shared';

const api = globalThis.chrome ?? (globalThis as Record<string, unknown>).browser;

let status: ConnectionStatus = 'disconnected';
let ws: WebSocket | null = null;
let reconnectDelay: number = RECONNECT.INITIAL_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let currentPort = DEFAULT_PORT;

const broadcastStatus = (connectionStatus: ConnectionStatus, port: number): void => {
  const payload: ConnectionStatusPayload = {
    type: 'connection_status',
    status: connectionStatus,
    port,
  };

  const message: InternalMessage = {
    source: 'offscreen',
    target: 'service-worker',
    payload,
  };

  api.runtime.sendMessage(message).catch(() => {
    // Service worker may not be listening yet
  });
};

const stopHeartbeat = (): void => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const startHeartbeat = (): void => {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
};

const scheduleReconnect = (port: number): void => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
  }

  console.log(`${LOG_PREFIX} Reconnecting in ${reconnectDelay}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(port);
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * RECONNECT.BACKOFF_MULTIPLIER, RECONNECT.MAX_DELAY_MS);
};

const connect = (port: number): void => {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }

  currentPort = port;
  status = 'connecting';
  broadcastStatus(status, port);
  console.log(`${LOG_PREFIX} Connecting to ws://localhost:${port}`);

  ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => {
    status = 'connected';
    broadcastStatus(status, port);
    reconnectDelay = RECONNECT.INITIAL_DELAY_MS;
    startHeartbeat();
    console.log(`${LOG_PREFIX} Connected`);

    const manifest = api.runtime.getManifest();
    ws!.send(JSON.stringify({ type: 'extension_info', version: manifest.version }));
  };

  ws.onclose = () => {
    status = 'disconnected';
    broadcastStatus(status, port);
    stopHeartbeat();
    console.log(`${LOG_PREFIX} Disconnected`);
    scheduleReconnect(port);
  };

  ws.onerror = (event: Event) => {
    console.error(`${LOG_PREFIX} WebSocket error`, event);
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as WolffishCommand | WolffishEvent;
      const message: InternalMessage = {
        source: 'offscreen',
        target: 'service-worker',
        payload: data as InternalMessage['payload'],
      };
      api.runtime.sendMessage(message).catch(() => {
        // Service worker may not be listening
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to parse message`, err);
    }
  };
};

api.runtime.onMessage.addListener(
  (message: InternalMessage | { type: string }, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if ('type' in message && message.type === 'get_connection_status') {
      const response: ConnectionStatusResponse = { status, port: currentPort };
      sendResponse(response);
      return true;
    }

    const internal = message as InternalMessage;
    if (internal.source && internal.target === 'offscreen') {
      const payload = internal.payload as WolffishResponse | WolffishCommand;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }

    return false;
  },
);

const init = async (): Promise<void> => {
  const config = await wolffishConnectionStorage.get();
  currentPort = config.port;
  console.log(`${LOG_PREFIX} Initializing with port ${currentPort}`);
  connect(currentPort);

  wolffishConnectionStorage.subscribe(() => {
    const snapshot = wolffishConnectionStorage.getSnapshot();
    if (snapshot && snapshot.port !== currentPort) {
      console.log(`${LOG_PREFIX} Port changed to ${snapshot.port}`);

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelay = RECONNECT.INITIAL_DELAY_MS;

      connect(snapshot.port);
    }
  });
};

init();
