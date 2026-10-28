import React, { useState } from 'react';
import {
  CheckSquare,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  X,
  RefreshCw,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { SeverityBadge } from '../../components/status/SeverityBadge';
import { StatusBadge } from '../../components/status/StatusBadge';
import { formatRelativeTime } from '../../lib/formatters';
import { ApprovalRequest } from '../../types/actions';

export const ApprovalsView: React.FC = () => {
  const {
    approvals,
    approveAction,
    rejectAction,
    pendingActionId,
    setCurrentView,
    setSelectedIncidentId,
  } = useAlexia();

  const [confirmingAction, setConfirmingAction] = useState<{
    approval: ApprovalRequest;
    decision: 'approved' | 'rejected';
  } | null>(null);

  const [rejectionReason, setRejectionReason] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const historyApprovals = approvals.filter((a) => a.status !== 'pending');

  const handleConfirmDecision = async () => {
    if (!confirmingAction) return;

    const { approval, decision } = confirmingAction;
    try {
      if (decision === 'approved') {
        const res = await approveAction(approval.id);
        setFeedbackMessage({
          type: res.success ? 'success' : 'error',
          text: res.message,
        });
      } else {
        const res = await rejectAction(
          approval.id,
          rejectionReason || 'Rejected by operator'
        );
        setFeedbackMessage({
          type: res.success ? 'success' : 'error',
          text: res.message,
        });
      }
    } catch (err: any) {
      setFeedbackMessage({
        type: 'error',
        text: err?.message || 'Operation failed',
      });
    } finally {
      setConfirmingAction(null);
      setRejectionReason('');
      setTimeout(() => setFeedbackMessage(null), 5000);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            Approvals
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Human-in-the-loop authorization queue for consequential remediation operations.
          </p>
        </div>

        {/* Action Tier Legend */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-2 py-0.5 rounded bg-[var(--status-warning-bg)] text-[var(--status-warning)] border border-[var(--status-warning-border)] font-semibold">
            Tier 1: Approval Req.
          </span>
        </div>
      </div>

      {feedbackMessage && (
        <div
          className="p-3.5 rounded-xl border text-xs flex items-center justify-between"
          style={{
            backgroundColor:
              feedbackMessage.type === 'success'
                ? 'var(--status-success-bg)'
                : 'var(--status-critical-bg)',
            borderColor:
              feedbackMessage.type === 'success'
                ? 'var(--status-success-border)'
                : 'var(--status-critical-border)',
            color:
              feedbackMessage.type === 'success'
                ? 'var(--status-success)'
                : 'var(--status-critical)',
          }}
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} />
            <span>{feedbackMessage.text}</span>
          </div>
          <button
            onClick={() => setFeedbackMessage(null)}
            className="text-current hover:opacity-75 cursor-pointer"
            aria-label="Dismiss message"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Pending Action Queue */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          Pending Action Queue ({pendingApprovals.length})
        </h2>

        {pendingApprovals.length === 0 ? (
          <div className="web-card p-10 text-center text-sm text-[var(--text-muted)]">
            <CheckCircle2 size={28} className="text-[var(--accent-primary)] mx-auto mb-2 opacity-80" />
            <p className="font-semibold text-[var(--text-primary)]">No pending approvals</p>
            <p className="text-xs mt-1">All autonomous actions are currently cleared.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingApprovals.map((app) => (
              <div
                key={app.id}
                className="web-card p-5 space-y-4 border-[var(--status-warning-border)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-[var(--status-warning-bg)] text-[var(--status-warning)]">
                      {app.action_tier_label}
                    </span>
                    <span className="font-mono text-xs text-[var(--text-muted)] font-semibold">
                      {app.id}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)] font-mono">
                      • Target: <strong className="text-[var(--text-primary)]">{app.affected_service}</strong>
                    </span>
                  </div>
                  <SeverityBadge severity={app.risk_level} size="sm" />
                </div>

                <div>
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">
                    {app.action_name}
                  </h3>
                  <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                    <strong>Why Proposed:</strong> {app.reason}
                  </p>
                </div>

                {/* Outcome & Rollback */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 rounded-xl bg-[var(--surface-hover)] border border-[var(--border-subtle)] text-xs">
                  <div>
                    <span className="text-[11px] text-[var(--text-muted)] block font-medium">Expected Result</span>
                    <span className="text-[var(--text-primary)] mt-0.5 block">{app.expected_outcome}</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-[var(--text-muted)] block font-medium">Rollback Safeguard</span>
                    <span className="text-[var(--accent-primary)] font-mono mt-0.5 block">{app.rollback_plan}</span>
                  </div>
                </div>

                {/* Action Buttons: Clearly Separated */}
                <div className="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)] text-xs">
                  <span className="text-[var(--text-muted)]">
                    Requested by: <strong className="text-[var(--text-primary)] font-mono">{app.requesting_agent}</strong>
                  </span>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={pendingActionId === app.id}
                      onClick={() =>
                        setConfirmingAction({
                          approval: app,
                          decision: 'rejected',
                        })
                      }
                      className="web-btn-secondary text-xs text-[var(--status-critical)] hover:border-[var(--status-critical-border)]"
                    >
                      Reject...
                    </button>

                    <button
                      type="button"
                      disabled={pendingActionId === app.id}
                      onClick={() =>
                        setConfirmingAction({
                          approval: app,
                          decision: 'approved',
                        })
                      }
                      className="web-btn-primary text-xs"
                    >
                      {pendingActionId === app.id ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          <span>Authorizing...</span>
                        </>
                      ) : (
                        <span>Authorize Action</span>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {confirmingAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="w-full max-w-md p-6 rounded-2xl border shadow-xl relative space-y-4"
            style={{
              backgroundColor: 'var(--surface-primary)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <h3 className="font-bold text-base">
                {confirmingAction.decision === 'approved' ? 'Authorize Action' : 'Reject Action'}
              </h3>
              <button
                onClick={() => setConfirmingAction(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Close confirmation"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-3 bg-[var(--surface-hover)] rounded-lg text-xs space-y-1">
              <p className="font-semibold text-[var(--text-primary)]">{confirmingAction.approval.action_name}</p>
              <p className="text-[var(--text-secondary)]">Target: {confirmingAction.approval.affected_service}</p>
            </div>

            {confirmingAction.decision === 'rejected' && (
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Rejection Reason</label>
                <input
                  type="text"
                  placeholder="Reason for audit log..."
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  className="web-input w-full text-xs"
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setConfirmingAction(null)}
                className="web-btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDecision}
                className="web-btn-primary text-xs"
                style={
                  confirmingAction.decision === 'rejected'
                    ? { backgroundColor: 'var(--status-critical)', color: '#FFFFFF' }
                    : undefined
                }
              >
                {confirmingAction.decision === 'approved' ? 'Confirm & Execute' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      {historyApprovals.length > 0 && (
        <div className="space-y-3 pt-6 border-t border-[var(--border-subtle)]">
          <h3 className="text-sm font-semibold text-[var(--text-secondary)]">
            Resolved Approvals History
          </h3>
          <div className="space-y-2">
            {historyApprovals.map((app) => (
              <div
                key={app.id}
                className="p-3 web-card flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={app.status} size="sm" />
                  <span className="font-medium text-[var(--text-primary)]">{app.action_name}</span>
                  <span className="text-[var(--text-muted)] font-mono">({app.affected_service})</span>
                </div>
                <span className="text-[11px] text-[var(--text-muted)] font-mono">
                  {app.decided_at ? formatRelativeTime(app.decided_at) : 'Historical'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
