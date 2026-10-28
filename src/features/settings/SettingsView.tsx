import React, { useState } from 'react';
import { Shield, Lock, Server, Check } from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { AutonomyStatus } from '../../components/status/AutonomyStatus';

export const SettingsView: React.FC = () => {
  const { autonomyState, environment, setEnvironment } = useAlexia();
  const [savedFeedback, setSavedFeedback] = useState(false);

  const handleSave = () => {
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 2500);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Settings
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Manage autonomous kill switches, environment targets, and safety policies.
        </p>
      </div>

      {savedFeedback && (
        <div className="p-3 rounded-lg bg-[var(--status-success-bg)] text-[var(--status-success)] text-xs flex items-center gap-2">
          <Check size={16} />
          <span>Preferences saved successfully.</span>
        </div>
      )}

      {/* Safety Kill Switch */}
      <div className="web-card p-6 space-y-4">
        <div className="flex items-center justify-between pb-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[var(--accent-muted)] text-[var(--accent-primary)] flex items-center justify-center">
              <Shield size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                Autonomous Kill Switch
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Master switch to pause automated container and database changes
              </p>
            </div>
          </div>

          <AutonomyStatus />
        </div>

        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          When active, Alexia's agents autonomously diagnose and apply Tier 0 safe remediations. When paused, all automated changes halt while background monitoring continues.
        </p>
      </div>

      {/* Environment Target */}
      <div className="web-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Server size={16} className="text-[var(--accent-primary)]" />
          <span>Target Environment</span>
        </h2>

        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Selected Cluster / Environment</label>
          <select
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className="web-input w-full text-xs"
          >
            <option value="Sandbox (ShopLite Docker)">Sandbox (ShopLite Docker)</option>
            <option value="Staging (Isolated Cluster)">Staging (Isolated Cluster)</option>
          </select>
        </div>

        <div className="pt-2">
          <button
            onClick={handleSave}
            className="web-btn-primary text-xs"
          >
            Save Settings
          </button>
        </div>
      </div>

      {/* Policy Classification */}
      <div className="web-card p-6 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Lock size={16} className="text-[var(--status-warning)]" />
          <span>Safety Tier Policy</span>
        </h2>

        <div className="space-y-2 text-xs">
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-success)] block mb-0.5">Tier 0 — Automatic</span>
            <p className="text-[var(--text-secondary)]">Database snapshots, container diffs, AST syntax checks, regression suites.</p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-warning)] block mb-0.5">Tier 1 — Requires Operator Approval</span>
            <p className="text-[var(--text-secondary)]">Service patches, container restarts, canary rollbacks, secret rotations.</p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-critical)] block mb-0.5">Tier 2 — Cryptographically Forbidden</span>
            <p className="text-[var(--text-secondary)]">Arbitrary /bin/sh exec, raw SQL DROP / TRUNCATE, deleting audit ledger.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
