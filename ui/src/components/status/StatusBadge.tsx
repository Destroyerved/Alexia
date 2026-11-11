import React from 'react';
import {
  CheckCircle2,
  Clock,
  Activity,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';
import { IncidentStatus } from '../../types/incidents';

interface StatusBadgeProps {
  status: IncidentStatus | string;
  size?: 'sm' | 'md';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'md' }) => {
  const isSm = size === 'sm';
  const iconSize = isSm ? 12 : 14;

  const normalized = (status || '').toLowerCase();

  switch (normalized) {
    case 'resolved':
    case 'completed':
    case 'successful':
    case 'healthy':
    case 'active':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-success-bg)',
            borderColor: 'var(--status-success-border)',
            color: 'var(--status-success)',
          }}
        >
          <CheckCircle2 size={iconSize} className="shrink-0" />
          <span className="capitalize">{status}</span>
        </span>
      );

    case 'verifying':
    case 'checking gates':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-info-bg)',
            borderColor: 'var(--status-info-border)',
            color: 'var(--status-info)',
          }}
        >
          <RotateCw size={iconSize} className="shrink-0 animate-spin" />
          <span className="capitalize">{status}</span>
        </span>
      );

    case 'acting':
    case 'working':
    case 'deploying':
    case 'building':
    case 'in_progress':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-info-bg)',
            borderColor: 'var(--status-info-border)',
            color: 'var(--status-info)',
          }}
        >
          <Activity size={iconSize} className="shrink-0 animate-pulse" />
          <span className="capitalize">{status}</span>
        </span>
      );

    case 'triaged':
    case 'waiting for approval':
    case 'pending':
    case 'degraded':
    case 'paused':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-warning-bg)',
            borderColor: 'var(--status-warning-border)',
            color: 'var(--status-warning)',
          }}
        >
          <Clock size={iconSize} className="shrink-0" />
          <span className="capitalize">{status}</span>
        </span>
      );

    case 'open':
    case 'escalated':
    case 'failed':
    case 'unhealthy':
    case 'error':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-critical-bg)',
            borderColor: 'var(--status-critical-border)',
            color: 'var(--status-critical)',
          }}
        >
          <AlertTriangle size={iconSize} className="shrink-0" />
          <span className="capitalize">{status}</span>
        </span>
      );

    case 'idle':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--surface-card)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'var(--text-muted)' }} />
          <span className="capitalize">{status}</span>
        </span>
      );
  }
};
