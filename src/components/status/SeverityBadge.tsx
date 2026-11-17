import React from 'react';
import { AlertOctagon, AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { IncidentSeverity } from '../../types/incidents';

interface SeverityBadgeProps {
  severity: IncidentSeverity;
  size?: 'sm' | 'md';
}

export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity, size = 'md' }) => {
  const isSm = size === 'sm';
  const iconSize = isSm ? 12 : 14;

  switch (severity) {
    case 'critical':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-semibold font-mono rounded-md border uppercase tracking-wider ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-critical-bg)',
            borderColor: 'var(--status-critical-border)',
            color: 'var(--status-critical)',
          }}
        >
          <AlertOctagon size={iconSize} className="shrink-0" />
          <span>Critical</span>
        </span>
      );
    case 'high':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-semibold font-mono rounded-md border uppercase tracking-wider ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-warning-bg)',
            borderColor: 'var(--status-warning-border)',
            color: 'var(--status-warning)',
          }}
        >
          <AlertTriangle size={iconSize} className="shrink-0" />
          <span>High</span>
        </span>
      );
    case 'medium':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-semibold font-mono rounded-md border uppercase tracking-wider ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-info-bg)',
            borderColor: 'var(--status-info-border)',
            color: 'var(--status-info)',
          }}
        >
          <Info size={iconSize} className="shrink-0" />
          <span>Medium</span>
        </span>
      );
    case 'low':
      return (
        <span
          className={`inline-flex items-center gap-1.5 font-semibold font-mono rounded-md border uppercase tracking-wider ${
            isSm ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs'
          }`}
          style={{
            backgroundColor: 'var(--status-success-bg)',
            borderColor: 'var(--status-success-border)',
            color: 'var(--status-success)',
          }}
        >
          <ShieldCheck size={iconSize} className="shrink-0" />
          <span>Low</span>
        </span>
      );
    default:
      return null;
  }
};
