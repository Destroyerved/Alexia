import React from 'react';
import { FlaskConical, ShieldAlert } from 'lucide-react';

export const DemoModeBanner: React.FC = () => {
  return (
    <div
      className="border-b px-4 py-1.5 flex items-center justify-between text-xs z-30 shrink-0"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <FlaskConical size={13} className="shrink-0 text-[var(--accent-primary)]" />
        <span
          className="font-bold tracking-wider uppercase px-1.5 py-0.5 rounded text-[10px]"
          style={{
            backgroundColor: 'var(--accent-glow)',
            color: 'var(--accent-primary)',
            border: '1px solid var(--accent-primary)',
          }}
        >
          DEMO MODE
        </span>
        <span className="hidden sm:inline text-[var(--text-secondary)]">
          — Real-time DevSecOps simulation on ShopLite Docker environment. Telemetry & scenarios demonstrate multi-agent triage.
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
        <ShieldAlert size={12} className="text-[var(--status-warning)]" />
        <span className="hidden md:inline font-mono">Tier 2 Actions Cryptographically Blocked</span>
      </div>
    </div>
  );
};
