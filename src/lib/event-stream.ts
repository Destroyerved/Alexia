export type ConnectionState = 'Connected' | 'Reconnecting' | 'Offline';

export interface StreamEvent {
  event?: 'incident_update' | 'agent_activity' | 'approval_created' | 'approval_resolved' | 'scenario_tick' | 'ping';
  type?: string;
  data?: any;
  timestamp?: string;
  id?: string;
}

export class AlexiaEventStream {
  private eventSource: EventSource | null = null;
  private url: string;
  private sessionTokenGetter?: () => string | null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onEventCallback?: (event: StreamEvent) => void;
  private onStateChangeCallback?: (state: ConnectionState) => void;
  private onReconnectCallback?: () => void;
  private lastEventId: string | null = null;
  private hadConnectedOnce = false;
  private isDestroyed = false;

  constructor(url: string = '/api/v1/events', sessionTokenGetter?: () => string | null) {
    this.url = url;
    this.sessionTokenGetter = sessionTokenGetter;
  }

  public getLastEventId(): string | null {
    return this.lastEventId;
  }

  public connect(
    onEvent: (event: StreamEvent) => void,
    onStateChange: (state: ConnectionState) => void,
    onReconnect?: () => void
  ) {
    this.onEventCallback = onEvent;
    this.onStateChangeCallback = onStateChange;
    this.onReconnectCallback = onReconnect;
    this.isDestroyed = false;
    this.initiateConnection();
  }

  private buildStreamUrl(): string {
    const params = new URLSearchParams();
    if (this.lastEventId) {
      params.set('last_event_id', this.lastEventId);
    }
    const tok = this.sessionTokenGetter?.();
    if (tok) {
      params.set('session_token', tok);
    }
    const qs = params.toString();
    if (!qs) return this.url;
    return `${this.url}${this.url.includes('?') ? '&' : '?'}${qs}`;
  }

  private initiateConnection() {
    if (this.isDestroyed) return;
    if (typeof EventSource === 'undefined') {
      this.onStateChangeCallback?.('Offline');
      return;
    }

    this.onStateChangeCallback?.(this.reconnectAttempts > 0 ? 'Reconnecting' : 'Connected');

    try {
      this.eventSource = new EventSource(this.buildStreamUrl(), { withCredentials: true });

      this.eventSource.onopen = () => {
        const wasReconnect = this.hadConnectedOnce && this.reconnectAttempts > 0;
        this.hadConnectedOnce = true;
        this.reconnectAttempts = 0;
        this.onStateChangeCallback?.('Connected');
        if (wasReconnect) {
          this.onReconnectCallback?.();
        }
      };

      this.eventSource.onmessage = (e) => {
        if (e.lastEventId) {
          this.lastEventId = e.lastEventId;
        }
        try {
          const parsed = JSON.parse(e.data);
          if (e.lastEventId) parsed.id = e.lastEventId;
          this.onEventCallback?.(parsed);
        } catch {
          // Heartbeat or raw text
        }
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        if (this.isDestroyed) return;

        this.reconnectAttempts++;
        // Continuous capped exponential backoff (1s -> 2s -> 4s -> 8s -> 16s -> 30s max)
        const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 30000);
        this.onStateChangeCallback?.('Reconnecting');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.initiateConnection();
        }, delay);
      };
    } catch {
      this.onStateChangeCallback?.('Offline');
    }
  }

  public disconnect() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.onStateChangeCallback?.('Offline');
  }
}
