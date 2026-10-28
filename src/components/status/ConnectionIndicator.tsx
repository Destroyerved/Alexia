import React from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { ConnectionState } from '../../lib/event-stream';

interface ConnectionIndicatorProps {
  state: ConnectionState;
}

export const ConnectionIndicator: React.FC<ConnectionIndicatorProps> = ({ state }) => {
  switch (state) {
    case 'Connected':
      return (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border"
          style={{
            backgroundColor: 'var(--status-success-bg)',
            borderColor: 'var(--status-success-border)',
            color: 'var(--status-success)',
          }}
          title="Telemetry stream: SSE connected & active"
        >
          <span className="relative flex h-2 w-2">
            <span
              className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
              style={{ backgroundColor: 'var(--accent-primary)' }}
            />
            <span
              className="relative inline-flex rounded-full h-2 w-2"
              style={{ backgroundColor: 'var(--accent-primary)' }}
            />
          </span>
          <Wifi size={13} />
          <span className="font-mono text-[11px]">Stream Live</span>
        </div>
      );
    case 'Reconnecting':
      return (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border"
          style={{
            backgroundColor: 'var(--status-warning-bg)',
            borderColor: 'var(--status-warning-border)',
            color: 'var(--status-warning)',
          }}
        >
          <RefreshCw size={13} className="animate-spin" />
          <span className="font-mono text-[11px]">Reconnecting</span>
        </div>
      );
    case 'Offline':
    default:
      return (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border"
          style={{
            backgroundColor: 'var(--status-critical-bg)',
            borderColor: 'var(--status-critical-border)',
            color: 'var(--status-critical)',
          }}
        >
          <WifiOff size={13} />
          <span className="font-mono text-[11px]">Offline</span>
        </div>
      );
  }
};
