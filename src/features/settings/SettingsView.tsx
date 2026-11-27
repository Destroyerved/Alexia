import React, { useEffect, useState } from 'react';
import { Shield, Lock, Server, Check, Bell, Activity, DollarSign, AlertTriangle } from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { AutonomyStatus } from '../../components/status/AutonomyStatus';

export const SettingsView: React.FC = () => {
  const {
    environment,
    setEnvironment,
    platformSettings,
    collectors,
    savePlatformSettings,
    subscribeWebPush,
  } = useAlexia();

  const [dailyUsdBudget, setDailyUsdBudget] = useState<number>(Number(platformSettings.daily_usd_budget ?? 10));
  const [dailyTokenBudget, setDailyTokenBudget] = useState<number>(Number(platformSettings.daily_token_budget ?? 5000000));
  const [redactionEnabled, setRedactionEnabled] = useState<boolean>(Boolean(platformSettings.redaction_enabled ?? true));
  const [stepUpRequired, setStepUpRequired] = useState<boolean>(Boolean(platformSettings.step_up_auth_required ?? true));
  const [webhookVerify, setWebhookVerify] = useState<boolean>(Boolean(platformSettings.webhook_signature_verification ?? true));
  const [autoSnapshot, setAutoSnapshot] = useState<boolean>(Boolean(platformSettings.auto_snapshot_before_tier1 ?? true));
  const [muted, setMuted] = useState<boolean>(Boolean(platformSettings.notifications_muted ?? false));
  const [quietStart, setQuietStart] = useState<string>(String(platformSettings.quiet_hours_start ?? ''));
  const [quietEnd, setQuietEnd] = useState<string>(String(platformSettings.quiet_hours_end ?? ''));
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDailyUsdBudget(Number(platformSettings.daily_usd_budget ?? 10));
    setDailyTokenBudget(Number(platformSettings.daily_token_budget ?? 5000000));
    setRedactionEnabled(Boolean(platformSettings.redaction_enabled ?? true));
    setStepUpRequired(Boolean(platformSettings.step_up_auth_required ?? true));
    setWebhookVerify(Boolean(platformSettings.webhook_signature_verification ?? true));
    setAutoSnapshot(Boolean(platformSettings.auto_snapshot_before_tier1 ?? true));
    setMuted(Boolean(platformSettings.notifications_muted ?? false));
    setQuietStart(String(platformSettings.quiet_hours_start ?? ''));
    setQuietEnd(String(platformSettings.quiet_hours_end ?? ''));
  }, [platformSettings]);

  const handleSave = async () => {
    setSaving(true);
    const res = await savePlatformSettings({
      environment,
      daily_usd_budget: Number(dailyUsdBudget),
      daily_token_budget: Number(dailyTokenBudget),
      redaction_enabled: redactionEnabled,
      step_up_auth_required: stepUpRequired,
      webhook_signature_verification: webhookVerify,
      auto_snapshot_before_tier1: autoSnapshot,
      notifications_muted: muted,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
    });
    setSaving(false);
    setFeedback({ ok: res.success, text: res.message });
    setTimeout(() => setFeedback(null), 4000);
  };

  const handleEnablePush = async () => {
    const res = await subscribeWebPush();
    setFeedback({ ok: res.success, text: res.message });
    setTimeout(() => setFeedback(null), 5000);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Settings
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Manage autonomous kill switches, durable SQLite platform policies, budgets, and push notifications.
        </p>
      </div>

      {feedback && (
        <div
          role="status"
          className="p-3 rounded-lg border text-xs flex items-center gap-2"
          style={{
            backgroundColor: feedback.ok ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
            borderColor: feedback.ok ? 'var(--status-success-border)' : 'var(--status-critical-border)',
            color: feedback.ok ? 'var(--status-success)' : 'var(--status-critical)',
          }}
        >
          {feedback.ok ? <Check size={16} /> : <AlertTriangle size={16} />}
          <span>{feedback.text}</span>
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
          When active, Alexia&apos;s agents autonomously diagnose and apply Tier 0 safe remediations. When paused, all automated changes queue for manual approval while monitoring continues.
        </p>
      </div>

      {/* Live Collector Supervisor Status */}
      {collectors && (
        <div className="web-card p-6 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Activity size={16} className="text-[var(--accent-primary)]" />
            <span>Background Telemetry Collectors</span>
          </h2>
          <div className="flex flex-wrap gap-2 text-xs font-mono">
            {collectors.collectors.length === 0 ? (
              <span className="text-[var(--text-muted)]">
                Collectors idle ({collectors.enabled ? 'starting' : 'disabled in test mode'})
              </span>
            ) : (
              collectors.collectors.map((c) => (
                <span
                  key={c.name}
                  className="px-2.5 py-1 rounded-lg border flex items-center gap-1.5"
                  style={{
                    backgroundColor: c.running ? 'var(--status-success-bg)' : 'var(--surface-hover)',
                    borderColor: c.running ? 'var(--status-success-border)' : 'var(--border-subtle)',
                    color: c.running ? 'var(--status-success)' : 'var(--text-muted)',
                  }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  <span>{c.name}</span>
                </span>
              ))
            )}
          </div>
        </div>
      )}

      {/* Durable Platform Controls & Budget Caps */}
      <div className="web-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Server size={16} className="text-[var(--accent-primary)]" />
          <span>Environment, Budgets & Security Guardrails</span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Target Environment</label>
            <select
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              className="web-input w-full text-xs"
            >
              <option value="Sandbox (ShopLite Docker)">Sandbox (ShopLite Docker)</option>
              <option value="production-sandbox">Production Sandbox</option>
              <option value="production">Production Host</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
              <DollarSign size={12} className="inline mr-0.5" />
              Daily USD Cap
            </label>
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={dailyUsdBudget}
              onChange={(e) => setDailyUsdBudget(Number(e.target.value))}
              className="web-input w-full text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Daily Token Cap</label>
            <input
              type="number"
              min={10000}
              step={50000}
              value={dailyTokenBudget}
              onChange={(e) => setDailyTokenBudget(Number(e.target.value))}
              className="web-input w-full text-xs font-mono"
            />
          </div>
        </div>

        <div className="space-y-2 pt-2 text-xs">
          {[
            {
              label: 'PII & Secret Redaction Before Model Ingestion (FR-C11)',
              checked: redactionEnabled,
              onChange: setRedactionEnabled,
            },
            {
              label: 'Require Passkey / TOTP Step-Up on Tier-1 Approvals (FR-M5)',
              checked: stepUpRequired,
              onChange: setStepUpRequired,
            },
            {
              label: 'Verify GitHub X-Hub-Signature-256 HMAC on Webhooks (FR-D1)',
              checked: webhookVerify,
              onChange: setWebhookVerify,
            },
            {
              label: 'Automatic Pre-Action Database Snapshot Before Tier-1 Mutations (FR-I1)',
              checked: autoSnapshot,
              onChange: setAutoSnapshot,
            },
          ].map((item) => (
            <label
              key={item.label}
              className="flex items-center justify-between p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] cursor-pointer"
            >
              <span className="text-[var(--text-primary)]">{item.label}</span>
              <input
                type="checkbox"
                checked={item.checked}
                onChange={(e) => item.onChange(e.target.checked)}
                className="accent-[var(--accent-primary)] w-4 h-4 cursor-pointer"
              />
            </label>
          ))}
        </div>

        {/* Web Push & Quiet Hours */}
        <div className="pt-3 border-t border-[var(--border-subtle)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Bell size={14} className="text-[var(--accent-primary)]" />
                <span>Mobile & Desktop Web Push Alerts</span>
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)]">
                Pre-redacted one-line incident &amp; approval notifications (critical alerts bypass quiet hours unless muted).
              </p>
            </div>
            <button type="button" onClick={handleEnablePush} className="web-btn-secondary text-xs">
              Subscribe This Browser
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs items-end">
            <label className="flex items-center gap-2 p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] cursor-pointer">
              <input
                type="checkbox"
                checked={muted}
                onChange={(e) => setMuted(e.target.checked)}
                className="accent-[var(--accent-primary)]"
              />
              <span>Mute all push alerts</span>
            </label>
            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">Quiet Hours Start (HH:MM)</label>
              <input
                type="time"
                value={quietStart}
                onChange={(e) => setQuietStart(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-[var(--text-muted)] mb-1">Quiet Hours End (HH:MM)</label>
              <input
                type="time"
                value={quietEnd}
                onChange={(e) => setQuietEnd(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="web-btn-primary text-xs disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
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
            <p className="text-[var(--text-secondary)]">Database snapshots, container restarts/rollbacks, temporary IP blocks (≤60m), sandbox tests.</p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-warning)] block mb-0.5">Tier 1 — Requires Operator Step-Up Approval</span>
            <p className="text-[var(--text-secondary)]">Merging fix PRs, snapshot restores, destructive migrations, container network isolation, secret rotations.</p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-critical)] block mb-0.5">Tier 2 — Cryptographically Forbidden</span>
            <p className="text-[var(--text-secondary)]">Arbitrary shell commands, raw SQL DROP / TRUNCATE, deleting backups or modifying the audit ledger.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
