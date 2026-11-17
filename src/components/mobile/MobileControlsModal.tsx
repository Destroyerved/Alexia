import React, { useState } from 'react';
import {
  X,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Camera,
  ShieldCheck,
  CheckCircle2,
  Lock,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { ActionResult } from '../../lib/api';

interface MobileControlsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MobileControlsModal: React.FC<MobileControlsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    autonomyState,
    toggleAutonomy,
    rollbackDeployment,
    restartService,
    takeSnapshot,
    verifyAuditChain,
    auditChain,
  } = useAlexia();
  const [actionFeedback, setActionFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  if (!isOpen) return null;

  // Every control goes through the same catalog/tier checks as the agents (FR-M7); show the server's verdict
  const handleAction = async (name: string, fn: () => Promise<ActionResult>) => {
    const res = await fn();
    setActionFeedback({ ok: res.success, text: res.message || name });
    setTimeout(() => setActionFeedback(null), 4000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label="Catalog Safe Controls"
    >
      {/* Backdrop click to dismiss */}
      <div
        className="fixed inset-0 bg-transparent"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="w-full sm:max-w-md border-t sm:border rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl relative max-h-[85vh] overflow-y-auto z-10"
        style={{
          backgroundColor: 'var(--surface-primary)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
          paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div
          className="flex items-center justify-between pb-3 border-b mb-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div>
            <h3 className="text-base font-bold font-mono text-[var(--text-primary)]">Catalog Safe Controls</h3>
            <p className="text-xs text-[var(--text-secondary)]">Approved Tier 0 & Tier 1 operations only</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            aria-label="Close controls modal"
          >
            <X size={20} />
          </button>
        </div>

        {actionFeedback && (
          <div
            className="mb-4 p-2.5 rounded-xl border text-xs flex items-center gap-2"
            style={{
              backgroundColor: actionFeedback.ok ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
              borderColor: actionFeedback.ok ? 'var(--status-success-border)' : 'var(--status-critical-border)',
              color: actionFeedback.ok ? 'var(--status-success)' : 'var(--status-critical)',
            }}
          >
            {actionFeedback.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>{actionFeedback.text}</span>
          </div>
        )}

        <div className="space-y-3">
          {/* Autonomy switch */}
          <button
            onClick={() => handleAction('Autonomy Toggle', () => toggleAutonomy())}
            className="w-full min-h-[50px] p-3 rounded-xl border flex items-center justify-between transition-all text-left cursor-pointer"
            style={{
              backgroundColor: 'var(--surface-card)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-3">
              {autonomyState === 'Active' ? (
                <PauseCircle className="text-[var(--status-warning)]" size={20} />
              ) : (
                <PlayCircle className="text-[var(--accent-primary)]" size={20} />
              )}
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">
                  {autonomyState === 'Active' ? 'Pause Guardian Autonomy' : 'Resume Guardian Autonomy'}
                </p>
                <p className="text-[11px] text-[var(--text-secondary)]">
                  {autonomyState === 'Active' ? 'Safely pause automated interventions' : 'Allow Tier 0 autonomous fixes'}
                </p>
              </div>
            </div>
            <span
              className="text-[10px] font-mono uppercase px-2 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--text-secondary)',
              }}
            >
              Tier 0
            </span>
          </button>

          {/* Restart service */}
          <button
            onClick={() => handleAction('Restart shoplite-api', () => restartService('svc_shoplite_api'))}
            className="w-full min-h-[50px] p-3 rounded-xl border flex items-center justify-between transition-all text-left cursor-pointer"
            style={{
              backgroundColor: 'var(--surface-card)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-3">
              <RefreshCw className="text-[var(--status-info)]" size={20} />
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">Restart shoplite-api</p>
                <p className="text-[11px] text-[var(--text-secondary)]">Queued for approval while autonomy is paused</p>
              </div>
            </div>
            <span
              className="text-[10px] font-mono uppercase px-2 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--text-secondary)',
              }}
            >
              Tier 0
            </span>
          </button>

          {/* Rollback service */}
          <button
            onClick={() =>
              handleAction('Rollback shoplite-api', () =>
                rollbackDeployment('shoplite-api', 'last known-good image', 'Manual mobile rollback command')
              )
            }
            className="w-full min-h-[50px] p-3 rounded-xl border flex items-center justify-between transition-all text-left cursor-pointer"
            style={{
              backgroundColor: 'var(--surface-card)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-3">
              <RotateCcw className="text-[var(--status-info)]" size={20} />
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">Roll Back shoplite-api</p>
                <p className="text-[11px] text-[var(--text-secondary)]">Restore the last known-good image</p>
              </div>
            </div>
            <span
              className="text-[10px] font-mono uppercase px-2 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--text-secondary)',
              }}
            >
              Tier 0
            </span>
          </button>

          {/* Take snapshot */}
          <button
            onClick={() =>
              handleAction('Database state snapshot', takeSnapshot)
            }
            className="w-full min-h-[50px] p-3 rounded-xl border flex items-center justify-between transition-all text-left cursor-pointer"
            style={{
              backgroundColor: 'var(--surface-card)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-3">
              <Camera className="text-[var(--accent-primary)]" size={20} />
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">Take Instant DB Snapshot</p>
                <p className="text-[11px] text-[var(--text-secondary)]">Integrity creates isolated pg_dump backup</p>
              </div>
            </div>
            <span
              className="text-[10px] font-mono uppercase px-2 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--text-secondary)',
              }}
            >
              Tier 0
            </span>
          </button>

          {/* Run integrity verification */}
          <button
            onClick={() =>
              handleAction('Cryptographic Hash-Chain Verification', verifyAuditChain)
            }
            className="w-full min-h-[50px] p-3 rounded-xl border flex items-center justify-between transition-all text-left cursor-pointer"
            style={{
              backgroundColor: 'var(--surface-card)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-3">
              <ShieldCheck className="text-[var(--accent-primary)]" size={20} />
              <div>
                <p className="text-xs font-semibold text-[var(--text-primary)]">Run Hash-Chain Verification</p>
                <p className="text-[11px] text-[var(--text-secondary)]">Verify SHA-256 links on all {auditChain ? auditChain.rows.toLocaleString() : ''} audit blocks</p>
              </div>
            </div>
            <span
              className="text-[10px] font-mono uppercase px-2 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--text-secondary)',
              }}
            >
              Tier 0
            </span>
          </button>

          {/* Blocked tier 2 notice */}
          <div
            className="p-3.5 rounded-xl border flex items-center gap-3 opacity-80"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical-border)',
            }}
          >
            <Lock className="text-[var(--status-critical)] shrink-0" size={18} />
            <div className="text-[11px] text-[var(--text-secondary)]">
              <strong className="text-[var(--status-critical)] font-semibold">Tier 2 Actions Forbidden:</strong> Direct shell access, arbitrary container execution, and raw DB drop commands are cryptographically disabled.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
