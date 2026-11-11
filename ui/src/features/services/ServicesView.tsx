import React, { useState } from 'react';
import {
  Server,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  X,
  GitCommit,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { StatusBadge } from '../../components/status/StatusBadge';
import { formatRelativeTime } from '../../lib/formatters';
import { ServiceItem } from '../../types/services';

export const ServicesView: React.FC = () => {
  const {
    services,
    deployments,
    rollbackDeployment,
    restartService,
    setCurrentView,
    setSelectedIncidentId,
  } = useAlexia();

  const [rollbackModalService, setRollbackModalService] = useState<ServiceItem | null>(null);
  const [rollbackReason, setRollbackReason] = useState('Revert to known good image tag');
  const [selectedService, setSelectedService] = useState<ServiceItem | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const showResult = (res: { success: boolean; message: string }) => {
    setFeedback({ ok: res.success, text: res.message });
    setTimeout(() => setFeedback(null), 5000);
  };

  // Roll back to the previous image of the newest rollback-eligible deployment of this service
  const rollbackTarget = rollbackModalService
    ? deployments.find((d) => d.service_name === rollbackModalService.name && d.rollback_available !== false)
    : undefined;

  const handleRollbackConfirm = async () => {
    if (!rollbackModalService) return;
    const targetImage = rollbackTarget?.previous_known_good_image ?? 'last known-good image';
    showResult(await rollbackDeployment(rollbackModalService.name, targetImage, rollbackReason));
    setRollbackModalService(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Services
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Container microservices, health indicators, resource consumption, and rollback controls.
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className="p-3 rounded-xl border text-xs flex items-center gap-2"
          style={{
            backgroundColor: feedback.ok ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
            borderColor: feedback.ok ? 'var(--status-success-border)' : 'var(--status-critical-border)',
            color: feedback.ok ? 'var(--status-success)' : 'var(--status-critical)',
          }}
        >
          {feedback.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Main Service List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {services.map((srv) => (
          <div
            key={srv.id}
            onClick={() => setSelectedService(srv)}
            className="web-card p-5 flex flex-col justify-between space-y-4 cursor-pointer hover:border-[var(--border-highlight)] transition-colors group"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm text-[var(--text-primary)] font-mono">
                  {srv.name}
                </span>
                <StatusBadge status={srv.status} size="sm" />
              </div>

              <div className="text-xs text-[var(--text-muted)] font-mono truncate">
                {srv.image}
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-[var(--border-subtle)] text-xs font-mono">
                <div>
                  <span className="text-[10px] text-[var(--text-muted)] block">CPU</span>
                  <span className="font-semibold text-[var(--text-primary)]">{srv.cpu_percent}%</span>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--text-muted)] block">Memory</span>
                  <span className="font-semibold text-[var(--text-primary)]">{srv.memory_mb} MB</span>
                </div>
                <div>
                  <span className="text-[10px] text-[var(--text-muted)] block">Restarts</span>
                  <span className={`font-semibold ${srv.restart_count > 0 ? 'text-[var(--status-warning)]' : 'text-[var(--text-primary)]'}`}>
                    {srv.restart_count}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)] text-xs">
              <span className="text-[11px] text-[var(--text-muted)] font-mono">
                {srv.container_id}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRollbackModalService(srv);
                }}
                className="web-btn-secondary text-[11px] py-1 px-2.5"
              >
                <RotateCcw size={12} />
                <span>Rollback</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Selected Service Diagnostics Drawer/Section */}
      {selectedService && (
        <div className="web-card p-6 space-y-4 mt-6">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <Server size={17} className="text-[var(--accent-primary)]" />
              <h3 className="font-bold text-base text-[var(--text-primary)] font-mono">
                {selectedService.name} Diagnostics
              </h3>
            </div>
            <button
              onClick={() => setSelectedService(null)}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              aria-label="Close service diagnostics"
            >
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-mono">
            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
              <span className="text-[var(--text-muted)] block mb-1">Image Tag</span>
              <span className="text-[var(--text-primary)] font-semibold">{selectedService.image}</span>
            </div>
            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
              <span className="text-[var(--text-muted)] block mb-1">Last Health Check</span>
              <span className="text-[var(--text-primary)]">{formatRelativeTime(selectedService.last_health_check)}</span>
            </div>
            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
              <span className="text-[var(--text-muted)] block mb-1">Uptime</span>
              <span className="text-[var(--accent-primary)] font-semibold">{selectedService.uptime_seconds}s</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={async () => showResult(await restartService(selectedService.id))}
              className="web-btn-secondary text-xs"
            >
              <RotateCcw size={13} />
              <span>Restart container (Tier 0)</span>
            </button>
          </div>

          {selectedService.latest_incident_id && (
            <div className="p-3 rounded-lg bg-[var(--status-critical-bg)] border border-[var(--status-critical-border)] text-xs flex items-center justify-between">
              <div className="flex items-center gap-2 text-[var(--status-critical)]">
                <AlertTriangle size={15} />
                <span>Active incident reported: {selectedService.latest_incident_id}</span>
              </div>
              <button
                onClick={() => {
                  setSelectedIncidentId(selectedService.latest_incident_id!);
                  setCurrentView('incidents');
                }}
                className="text-[var(--status-critical)] underline font-medium cursor-pointer"
              >
                Inspect Incident →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Deployments (FR-U4: last deploy, current image, gates, rollback) */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <GitCommit size={16} className="text-[var(--accent-primary)]" />
          Deployments ({deployments.length})
        </h2>
        <div className="web-card overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px] bg-[var(--surface-hover)]">
                <th className="py-2.5 px-3.5">Deployment</th>
                <th className="py-2.5 px-3.5">Image</th>
                <th className="py-2.5 px-3.5">Status</th>
                <th className="py-2.5 px-3.5">Gates</th>
                <th className="py-2.5 px-3.5">Started</th>
                <th className="py-2.5 px-3.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {deployments.map((dep) => {
                const gates = [...dep.pre_deploy_gates, ...dep.health_gates];
                const gatesPassed = gates.filter((g) => g.passed).length;
                return (
                  <tr key={dep.id} className="hover:bg-[var(--surface-hover)] align-top">
                    <td className="py-2.5 px-3.5 font-mono text-[var(--text-primary)]">{dep.id}</td>
                    <td className="py-2.5 px-3.5 font-mono text-[var(--text-secondary)]">
                      {dep.image_tag}
                      <span className="block text-[10px] text-[var(--text-muted)]">prev: {dep.previous_known_good_image}</span>
                    </td>
                    <td className="py-2.5 px-3.5 text-[var(--text-primary)]">{dep.status}</td>
                    <td className="py-2.5 px-3.5 text-[var(--text-secondary)]" title={gates.map((g) => `${g.passed ? 'PASS' : 'FAIL'} ${g.name}: ${g.details}`).join('\n')}>
                      {gatesPassed}/{gates.length} passed
                    </td>
                    <td className="py-2.5 px-3.5 text-[var(--text-muted)] font-mono">{formatRelativeTime(dep.started_at)}</td>
                    <td className="py-2.5 px-3.5 text-right">
                      {dep.rollback_available && (
                        <button
                          type="button"
                          onClick={async () =>
                            showResult(await rollbackDeployment(dep.service_name, dep.previous_known_good_image, 'Operator rollback from Deployments', dep.id))
                          }
                          className="web-btn-secondary text-[11px]"
                        >
                          <RotateCcw size={12} />
                          <span>Roll back</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rollback Modal */}
      {rollbackModalService && (
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
              <h3 className="font-bold text-base">Rollback {rollbackModalService.name}</h3>
              <button
                onClick={() => setRollbackModalService(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Close modal"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-[var(--surface-hover)] border border-[var(--border-subtle)] text-xs space-y-1 font-mono">
              <p>Current: <span className="text-[var(--status-critical)]">{rollbackModalService.image}</span></p>
              <p>Target: <span className="text-[var(--accent-primary)]">{rollbackTarget?.previous_known_good_image ?? 'no rollback-eligible deployment'}</span></p>
            </div>

            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Reason for Rollback</label>
              <input
                type="text"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                className="web-input w-full text-xs"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setRollbackModalService(null)}
                className="web-btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRollbackConfirm}
                className="web-btn-primary text-xs"
              >
                Confirm Rollback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
