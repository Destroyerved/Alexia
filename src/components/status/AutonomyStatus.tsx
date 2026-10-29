import React, { useState } from 'react';
import { ShieldCheck, PauseCircle, PlayCircle, AlertTriangle, X } from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';

export const AutonomyStatus: React.FC = () => {
  const { autonomyState, toggleAutonomy, isLiveBackend } = useAlexia();
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isActive = autonomyState === 'Active';
  // Pausing is the safe direction; resuming needs step-up (FR-M6)
  const needsStepUp = !isActive && isLiveBackend;

  const handleToggle = () => {
    setError(null);
    setStepUpCode('');
    setShowConfirmModal(true);
  };

  const confirmAction = async () => {
    setBusy(true);
    const res = await toggleAutonomy(needsStepUp ? stepUpCode : undefined);
    setBusy(false);
    if (res.success) {
      setShowConfirmModal(false);
    } else {
      setError(res.message);
    }
  };

  return (
    <>
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all cursor-pointer"
        style={{
          backgroundColor: isActive ? 'var(--status-success-bg)' : 'var(--status-warning-bg)',
          borderColor: isActive ? 'var(--status-success-border)' : 'var(--status-warning-border)',
          color: isActive ? 'var(--status-success)' : 'var(--status-warning)',
        }}
        title="Toggle Autonomous DevSecOps Interventions Kill Switch"
        aria-label="Toggle Guardian Autonomy"
      >
        {isActive ? (
          <>
            <ShieldCheck size={14} className="stroke-[2.5]" />
            <span className="font-mono uppercase tracking-wider text-[11px]">Autonomy: Active</span>
          </>
        ) : (
          <>
            <PauseCircle size={14} className="stroke-[2.5]" />
            <span className="font-mono uppercase tracking-wider text-[11px]">Autonomy: Paused</span>
          </>
        )}
      </button>

      {/* Safety Confirmation Dialog */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="w-full max-w-md p-6 rounded-2xl border shadow-2xl relative"
            style={{
              backgroundColor: 'var(--surface-primary)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            <button
              onClick={() => setShowConfirmModal(false)}
              className="absolute top-4 right-4 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors p-1"
              aria-label="Close modal"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-3.5 mb-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: isActive ? 'var(--status-warning-bg)' : 'var(--status-success-bg)',
                  color: isActive ? 'var(--status-warning)' : 'var(--status-success)',
                  border: `1px solid ${isActive ? 'var(--status-warning-border)' : 'var(--status-success-border)'}`,
                }}
              >
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3 className="text-base font-bold font-mono">
                  {isActive ? 'Pause Guardian Autonomy?' : 'Resume Guardian Autonomy?'}
                </h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  Master Kill Switch / Safety Lock Protocol
                </p>
              </div>
            </div>

            <p className="text-xs text-[var(--text-secondary)] mb-6 leading-relaxed">
              {isActive ? (
                <>
                  Pausing autonomy halts all automated remediations, container restarts, and canary shifts (Tier 0 & Tier 1).
                  <br />
                  <strong className="text-[var(--text-primary)] mt-1.5 block">
                    Security monitoring and incident detection will continue uninterrupted.
                  </strong>
                </>
              ) : (
                <>
                  Resuming autonomy allows Alexia agents (Sentinel, Healer, Builder, Deployer, Integrity) to resume automated diagnoses and execute Tier 0 permitted actions.
                </>
              )}
            </p>

            {needsStepUp && (
              <div className="mb-4">
                <label htmlFor="resume-step-up" className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                  Step-up verification (passkey / biometric, or 6-digit TOTP)
                </label>
                <input
                  id="resume-step-up"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="Demo code: 123456"
                  value={stepUpCode}
                  onChange={(e) => setStepUpCode(e.target.value.replace(/\D/g, ''))}
                  className="web-input w-full text-xs font-mono tracking-widest"
                />
              </div>
            )}

            {error && (
              <p className="mb-4 p-2.5 rounded-lg text-xs bg-[var(--status-critical-bg)] text-[var(--status-critical)] border border-[var(--status-critical-border)]">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="cyber-btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAction}
                disabled={busy || (needsStepUp && stepUpCode.length !== 6)}
                className="cyber-btn-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                style={
                  isActive
                    ? {
                        backgroundColor: 'var(--status-warning)',
                        color: '#050806',
                      }
                    : undefined
                }
              >
                {isActive ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
                <span>{isActive ? 'Confirm Pause Autonomy' : 'Confirm Resume Autonomy'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
