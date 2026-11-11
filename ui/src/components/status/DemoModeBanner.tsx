import React from 'react';
import { ShieldCheck, KeyRound, Cpu, ArrowRight } from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';

export const DemoModeBanner: React.FC = () => {
  const { isLiveBackend, authSetupRequired, llmStatus, blockedIps, setCurrentView } = useAlexia();

  if (!isLiveBackend) {
    return null;
  }

  return (
    <div
      className="border-b px-4 py-1.5 flex items-center justify-between text-xs z-30 shrink-0"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-3 font-mono text-[11px] flex-wrap">
        <span className="flex items-center gap-1.5 text-[var(--accent-primary)] font-semibold">
          <ShieldCheck size={13} className="shrink-0" />
          <span>WAF GATEWAY ACTIVE</span>
        </span>
        <span className="text-[var(--text-muted)]">•</span>
        <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
          <Cpu size={12} />
          <span>
            LLM:{' '}
            <strong className={llmStatus?.live ? 'text-[var(--status-success)]' : 'text-[var(--status-warning)]'}>
              {llmStatus?.live ? `${llmStatus.provider.toUpperCase()} (LIVE)` : 'Rule-Engine Safety Mode'}
            </strong>
          </span>
        </span>
        {blockedIps.length > 0 && (
          <>
            <span className="text-[var(--text-muted)]">•</span>
            <span className="text-[var(--status-critical)] font-semibold">
              {blockedIps.length} IP{blockedIps.length === 1 ? '' : 's'} Blocked
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        {authSetupRequired ? (
          <button
            type="button"
            onClick={() => setCurrentView('settings')}
            className="flex items-center gap-1.5 font-mono font-semibold text-[var(--status-warning)] hover:underline cursor-pointer"
          >
            <KeyRound size={12} />
            <span>Enroll Operator TOTP</span>
            <ArrowRight size={11} />
          </button>
        ) : !llmStatus?.live ? (
          <button
            type="button"
            onClick={() => setCurrentView('settings')}
            className="flex items-center gap-1 font-mono text-[var(--accent-primary)] hover:underline cursor-pointer"
          >
            <span>Configure LLM Key</span>
            <ArrowRight size={11} />
          </button>
        ) : (
          <span className="hidden md:inline font-mono text-[var(--text-secondary)]">
            Tier 2 Actions Cryptographically Blocked
          </span>
        )}
      </div>
    </div>
  );
};
