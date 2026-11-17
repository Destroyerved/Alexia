import React, { useState } from 'react';
import {
  PlayCircle,
  RotateCcw,
  CheckCircle2,
  Activity,
  ArrowRight,
  X,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { ScenarioDefinition } from '../../types/scenarios';
import { formatRelativeTime } from '../../lib/formatters';

export const ScenariosView: React.FC = () => {
  const {
    scenarios,
    activeScenarioRun,
    runScenario,
    resetEnvironment,
    setCurrentView,
    setSelectedIncidentId,
  } = useAlexia();

  const [confirmingScenario, setConfirmingScenario] = useState<ScenarioDefinition | null>(null);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleStartScenario = async () => {
    if (!confirmingScenario) return;
    const target = confirmingScenario;
    setConfirmingScenario(null);
    await runScenario(target.id);
  };

  const handleReset = async () => {
    setIsResetting(true);
    await resetEnvironment();
    setIsResetting(false);
    setShowResetDialog(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            Scenarios
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Run realistic DevSecOps fault injection benchmarks to test automated incident remediation.
          </p>
        </div>

        <button
          onClick={() => setShowResetDialog(true)}
          className="web-btn-secondary text-xs"
        >
          <RotateCcw size={14} />
          <span>Reset Sandbox</span>
        </button>
      </div>

      {/* Active Running Scenario Panel: Only displayed when active */}
      {activeScenarioRun && (
        <div className="web-card p-5 border-[var(--border-highlight)] ring-1 ring-[var(--accent-primary)] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent-primary)] animate-ping" />
              <span className="font-semibold text-sm text-[var(--text-primary)] font-mono">
                Executing Scenario {activeScenarioRun.scenario_id}
              </span>
            </div>
            <span className="text-xs font-mono font-bold text-[var(--accent-primary)]">
              {activeScenarioRun.status} ({activeScenarioRun.progress_percent}%)
            </span>
          </div>

          {/* Simple progress bar */}
          <div className="w-full bg-[var(--surface-hover)] rounded-full h-2 overflow-hidden">
            <div
              className="bg-[var(--accent-primary)] h-full transition-all duration-300 rounded-full"
              style={{ width: `${activeScenarioRun.progress_percent}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>{activeScenarioRun.current_step}</span>
            {activeScenarioRun.status === 'completed' && (
              <button
                onClick={() => {
                  setSelectedIncidentId('DEMO-INC-2026-0841');
                  setCurrentView('incidents');
                }}
                className="text-xs text-[var(--accent-primary)] font-semibold hover:underline flex items-center gap-1 cursor-pointer"
              >
                <span>View Resulting Incident</span>
                <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Clean List of Scenarios as Simple Rows/Cards */}
      <div className="space-y-3">
        {scenarios.map((scenario) => (
          <div
            key={scenario.id}
            className="web-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-[var(--border-medium)] transition-colors"
          >
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-xs font-bold font-mono bg-[var(--accent-muted)] text-[var(--accent-primary)]">
                  {scenario.id}
                </span>
                <h3 className="font-semibold text-sm text-[var(--text-primary)]">
                  {scenario.name}
                </h3>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {scenario.demonstrates}
              </p>
              <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)] font-mono pt-1">
                <span>Est: {scenario.estimated_duration_seconds}s</span>
                <span>Agents: {scenario.agents_involved.join(', ')}</span>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-3">
              <button
                disabled={activeScenarioRun?.status === 'injecting' || activeScenarioRun?.status === 'detecting' || activeScenarioRun?.status === 'remediating'}
                onClick={() => setConfirmingScenario(scenario)}
                className="web-btn-primary text-xs disabled:opacity-50"
              >
                <PlayCircle size={14} />
                <span>Run</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirmation Modal */}
      {confirmingScenario && (
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
              <h3 className="font-bold text-base">Run Scenario {confirmingScenario.id}</h3>
              <button
                onClick={() => setConfirmingScenario(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Close modal"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Injects synthetic fault traffic into the sandbox container stack to demonstrate autonomous detection and remediation.
            </p>

            <div className="p-3 rounded-lg bg-[var(--surface-hover)] text-xs font-mono">
              <span className="text-[var(--text-muted)] block text-[11px]">Payload</span>
              <span className="text-[var(--text-primary)]">{confirmingScenario.simulated_payload_info}</span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setConfirmingScenario(null)}
                className="web-btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartScenario}
                className="web-btn-primary text-xs"
              >
                Start Scenario
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Dialog */}
      {showResetDialog && (
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
              <h3 className="font-bold text-base">Reset Sandbox?</h3>
              <button
                onClick={() => setShowResetDialog(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                aria-label="Close dialog"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Restores baseline container states and clears active test queues.
            </p>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setShowResetDialog(false)}
                className="web-btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isResetting}
                onClick={handleReset}
                className="web-btn-primary text-xs"
              >
                {isResetting ? 'Resetting...' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
