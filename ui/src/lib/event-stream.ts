export type ConnectionState = 'Connected' | 'Reconnecting' | 'Offline';

export interface StreamEvent {
  event?: 'incident_update' | 'agent_activity' | 'approval_created' | 'approval_resolved' | 'scenario_tick' | 'ping';
  type?: string;
  data?: any;
  timestamp?: string;
}

export class AlexiaEventStream {
  private eventSource: EventSource | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: any = null;
  private onEventCallback?: (event: StreamEvent) => void;
  private onStateChangeCallback?: (state: ConnectionState) => void;
  private isDestroyed = false;

  constructor(url: string = '/stream') {
    this.url = url;
  }

  public connect(
    onEvent: (event: StreamEvent) => void,
    onStateChange: (state: ConnectionState) => void
  ) {
    this.onEventCallback = onEvent;
    this.onStateChangeCallback = onStateChange;
    this.isDestroyed = false;
    this.initiateConnection();
  }

  private initiateConnection() {
    if (this.isDestroyed) return;

    this.onStateChangeCallback?.(
      this.reconnectAttempts > 0 ? 'Reconnecting' : 'Connected'
    );

    try {
      this.eventSource = new EventSource(this.url);

      this.eventSource.onopen = () => {
        this.reconnectAttempts = 0;
        this.onStateChangeCallback?.('Connected');
      };

      this.eventSource.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          this.onEventCallback?.(parsed);
        } catch {
          // Heartbeat or raw text
        }
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15000);
          this.onStateChangeCallback?.('Reconnecting');
          this.reconnectTimer = setTimeout(() => {
            this.initiateConnection();
          }, delay);
        } else {
          // After retry exhaustion, fall back to offline demo status
          this.onStateChangeCallback?.('Offline');
        }
      };
    } catch {
      this.onStateChangeCallback?.('Offline');
    }
  }

  public disconnect() {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.onStateChangeCallback?.('Offline');
  }
}
