import React, { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  Lock,
  Server,
  Check,
  Cpu,
  KeyRound,
  Plus,
  Trash2,
  ShieldAlert,
  RefreshCw,
  Copy,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { AutonomyStatus } from '../../components/status/AutonomyStatus';
import {
  apiClient,
  AuthBootstrapStatus,
  BlockedIpEntry,
  LLMProviderStatus,
  TargetConfigPayload,
} from '../../lib/api';

export const SettingsView: React.FC = () => {
  const { isLiveBackend, refresh } = useAlexia();

  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // 1. Operator & TOTP state
  const [authStatus, setAuthStatus] = useState<AuthBootstrapStatus | null>(null);
  const [setupUser, setSetupUser] = useState('admin');
  const [setupPass, setSetupPass] = useState('');
  const [enrolledSecret, setEnrolledSecret] = useState<{
    username: string;
    totp_secret: string;
    provisioning_uri: string;
  } | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  // 2. LLM Provider state
  const [llmStatus, setLlmStatus] = useState<LLMProviderStatus | null>(null);
  const [provider, setProvider] = useState('auto');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [fastModel, setFastModel] = useState('');
  const [codingModel, setCodingModel] = useState('');
  const [reasoningModel, setReasoningModel] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [savingLlm, setSavingLlm] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // 3. Target Registry state
  const [targets, setTargets] = useState<TargetConfigPayload[]>([]);
  const [showAddTarget, setShowAddTarget] = useState(false);
  const [newTarget, setNewTarget] = useState<TargetConfigPayload>({
    name: '',
    runtime: 'process',
    enabled: true,
    upstream_url: 'http://127.0.0.1:8002',
    health_url: 'http://127.0.0.1:8002/health',
    workspace_path: '',
    command: '',
    db_type: 'sqlite',
    db_path: '',
    memory_limit_mb: 512,
  });

  // 4. WAF Blocklist state
  const [blockedIps, setBlockedIps] = useState<BlockedIpEntry[]>([]);
  const [manualBlockIp, setManualBlockIp] = useState('');
  const [manualBlockReason, setManualBlockReason] = useState('Manual operator block');

  const showNotice = (ok: boolean, text: string) => {
    setBanner({ ok, text });
    setTimeout(() => setBanner(null), 5000);
  };

  const loadSettingsData = useCallback(async () => {
    if (!apiClient.isLiveBackend()) return;
    const [aStatus, lCfg, tRes, bIps] = await Promise.all([
      apiClient.getAuthStatus(),
      apiClient.getLLMConfig(),
      apiClient.getTargets(),
      apiClient.getBlockedIps(),
    ]);
    if (aStatus) setAuthStatus(aStatus);
    if (lCfg) {
      setLlmStatus(lCfg.status);
      setProvider(lCfg.saved.provider || 'auto');
      setBaseUrl(lCfg.saved.base_url || '');
      setFastModel(lCfg.saved.fast_model || '');
      setCodingModel(lCfg.saved.coding_model || '');
      setReasoningModel(lCfg.saved.reasoning_model || '');
      setHasSavedKey(Boolean(lCfg.saved.has_api_key));
    }
    if (tRes?.targets) setTargets(tRes.targets);
    setBlockedIps(bIps);
  }, []);

  useEffect(() => {
    void loadSettingsData();
  }, [isLiveBackend, loadSettingsData]);

  const handleEnrollOperator = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnrolling(true);
    const res = await apiClient.setupInitialOperator(setupUser.trim(), setupPass);
    setEnrolling(false);
    if (!res.success) {
      showNotice(false, res.error || 'Operator enrollment failed');
      return;
    }
    setEnrolledSecret({
      username: res.username || setupUser.trim(),
      totp_secret: res.totp_secret || '',
      provisioning_uri: res.provisioning_uri || '',
    });
    setSetupPass('');
    showNotice(true, `Operator '${res.username}' enrolled! Save your Base32 TOTP secret now.`);
    await loadSettingsData();
    await refresh();
  };

  const handleSaveLlm = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLlm(true);
    const res = await apiClient.saveLLMConfig({
      provider,
      api_key: apiKey.trim() || undefined,
      base_url: baseUrl.trim(),
      fast_model: fastModel.trim(),
      coding_model: codingModel.trim(),
      reasoning_model: reasoningModel.trim(),
    });
    setSavingLlm(false);
    if (!res.success) {
      showNotice(false, res.error || 'Failed to save LLM settings');
      return;
    }
    if (res.llm) setLlmStatus(res.llm);
    setApiKey('');
    await loadSettingsData();
    await refresh();
    showNotice(true, `LLM provider saved (${res.llm?.provider.toUpperCase()} — ${res.llm?.live ? 'LIVE' : 'Rule-Engine Mode'})`);
  };

  const handleTestLlm = async () => {
    setTestingLlm(true);
    setLlmTestResult(null);
    const res = await apiClient.testLLMConnection();
    setTestingLlm(false);
    if (res.ok) {
      setLlmTestResult({
        ok: true,
        text: `Connected to ${res.provider} (${res.model}) in ${res.latency_ms}ms — Reply: "${res.reply}"`,
      });
    } else {
      setLlmTestResult({
        ok: false,
        text: res.error || 'LLM connection check failed',
      });
    }
  };

  const handleAddTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTarget.name.trim()) return;
    const res = await apiClient.upsertTarget({
      ...newTarget,
      name: newTarget.name.trim(),
    });
    if (!res.success) {
      showNotice(false, res.error || 'Failed to register target');
      return;
    }
    setShowAddTarget(false);
    setNewTarget({
      name: '',
      runtime: 'process',
      enabled: true,
      upstream_url: 'http://127.0.0.1:8002',
      health_url: 'http://127.0.0.1:8002/health',
      workspace_path: '',
      command: '',
      db_type: 'sqlite',
      db_path: '',
      memory_limit_mb: 512,
    });
    await loadSettingsData();
    await refresh();
    showNotice(true, `Registered target service '${res.target?.name}'`);
  };

  const handleRemoveTarget = async (name: string) => {
    const res = await apiClient.deleteTarget(name);
    if (!res.success) {
      showNotice(false, res.message);
      return;
    }
    await loadSettingsData();
    await refresh();
    showNotice(true, res.message);
  };

  const handleManualBlockIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualBlockIp.trim()) return;
    const res = await apiClient.blockIp(manualBlockIp.trim(), 60, manualBlockReason.trim() || 'Manual operator block');
    if (!res.success) {
      showNotice(false, res.message);
      return;
    }
    setManualBlockIp('');
    await loadSettingsData();
    await refresh();
    showNotice(true, res.message);
  };

  const handleUnblockIp = async (ip: string) => {
    const res = await apiClient.unblockIp(ip);
    if (!res.success) {
      showNotice(false, res.message);
      return;
    }
    await loadSettingsData();
    await refresh();
    showNotice(true, res.message);
  };

  const copyText = (txt: string) => {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(txt);
      showNotice(true, 'Copied to clipboard.');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Settings & Production Control Plane
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Configure operator TOTP authentication, multi-provider LLM routing, supervised target services, WAF IP bans, and the autonomy kill switch.
        </p>
      </div>

      {banner && (
        <div
          className="p-3.5 rounded-xl border text-xs flex items-center gap-2"
          style={{
            backgroundColor: banner.ok ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
            borderColor: banner.ok ? 'var(--status-success-border)' : 'var(--status-critical-border)',
            color: banner.ok ? 'var(--status-success)' : 'var(--status-critical)',
          }}
        >
          {banner.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{banner.text}</span>
        </div>
      )}

      {/* 1. Autonomous Kill Switch */}
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
                Master circuit-breaker for Tier-0 automated interventions (resuming requires RFC 6238 TOTP step-up)
              </p>
            </div>
          </div>

          <AutonomyStatus />
        </div>

        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          When active, Alexia executes reversible Tier-0 remediations automatically (snapshots, WAF IP blocks, process restarts, release rollbacks) while gating consequential Tier-1 changes behind single-use HMAC approvals. When paused, every automated action is queued for human review.
        </p>
      </div>

      {/* 2. Operator Account & RFC 6238 TOTP Enrollment */}
      <div className="web-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <KeyRound size={16} className="text-[var(--accent-primary)]" />
            <span>Operator Authentication & TOTP Authenticator</span>
          </h2>
          {authStatus && !authStatus.setup_required && (
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[var(--status-success-bg)] text-[var(--status-success)]">
              {authStatus.operator_count} Enrolled
            </span>
          )}
        </div>

        {enrolledSecret && (
          <div
            className="p-4 rounded-xl border space-y-2.5 text-xs"
            style={{
              backgroundColor: 'var(--surface-hover)',
              borderColor: 'var(--border-highlight)',
            }}
          >
            <div className="flex items-center justify-between">
              <strong className="text-[var(--accent-primary)] font-mono">
                Authenticator Provisioned for {enrolledSecret.username}
              </strong>
              <button
                type="button"
                onClick={() => copyText(enrolledSecret.totp_secret)}
                className="web-btn-secondary text-[11px] py-1 px-2"
              >
                <Copy size={12} />
                <span>Copy Secret</span>
              </button>
            </div>
            <p className="text-[var(--text-secondary)]">
              Add this Base32 key to Google Authenticator, Authy, 1Password, or Bitwarden for Tier-1 approvals and Kill-Switch resume:
            </p>
            <div className="p-2.5 rounded bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono text-sm tracking-widest font-bold text-[var(--text-primary)] select-all">
              {enrolledSecret.totp_secret}
            </div>
            <p className="text-[10px] font-mono text-[var(--text-muted)] break-all">
              {enrolledSecret.provisioning_uri}
            </p>
          </div>
        )}

        {!authStatus || authStatus.setup_required ? (
          <form onSubmit={handleEnrollOperator} className="space-y-3">
            <p className="text-xs text-[var(--text-secondary)]">
              No hardcoded demo accounts exist. Create your administrator account below (salted <code className="font-mono">scrypt</code> + RFC 6238 TOTP) to authorize Tier-1 actions.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Operator Username</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  value={setupUser}
                  onChange={(e) => setSetupUser(e.target.value)}
                  className="web-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Password (min 8 chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder="Strong operator passphrase"
                  value={setupPass}
                  onChange={(e) => setSetupPass(e.target.value)}
                  className="web-input w-full text-xs"
                />
              </div>
            </div>
            <button type="submit" disabled={enrolling} className="web-btn-primary text-xs">
              <Check size={14} />
              <span>{enrolling ? 'Enrolling...' : 'Enroll Operator & Generate TOTP Secret'}</span>
            </button>
          </form>
        ) : (
          <div className="space-y-2 text-xs">
            {authStatus.operators.map((op) => (
              <div
                key={op.username}
                className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] flex items-center justify-between font-mono"
              >
                <div>
                  <span className="font-semibold text-[var(--text-primary)]">{op.username}</span>
                  <span className="ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded bg-[var(--accent-muted)] text-[var(--accent-primary)]">
                    {op.role}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--text-muted)]">TOTP Active</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Multi-Provider LLM Engine Configuration */}
      <div className="web-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Cpu size={16} className="text-[var(--accent-primary)]" />
            <span>Multi-Provider LLM Engine & Model Routing</span>
          </h2>
          {llmStatus && (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold"
              style={{
                backgroundColor: llmStatus.live ? 'var(--status-success-bg)' : 'var(--status-warning-bg)',
                color: llmStatus.live ? 'var(--status-success)' : 'var(--status-warning)',
              }}
            >
              {llmStatus.live ? `${llmStatus.provider.toUpperCase()} LIVE` : 'RULE-ENGINE FALLBACK'}
            </span>
          )}
        </div>

        <form onSubmit={handleSaveLlm} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="web-input w-full text-xs font-mono"
              >
                <option value="auto">auto (detect configured API key / local Ollama)</option>
                <option value="openai">openai (GPT-4o / GPT-4.1)</option>
                <option value="gemini">gemini (Gemini 2.5 Flash / Pro)</option>
                <option value="anthropic">anthropic (Claude Sonnet / Haiku)</option>
                <option value="openrouter">openrouter (OpenRouter Gateway)</option>
                <option value="nebius">nebius (NVIDIA Nemotron on Token Factory)</option>
                <option value="ollama">ollama (Local Self-Hosted Models)</option>
                <option value="custom">custom (OpenAI-Compatible Endpoint)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                API Key {hasSavedKey ? '(saved — leave blank to keep)' : ''}
              </label>
              <input
                type="password"
                placeholder={provider === 'ollama' ? 'Not required for local Ollama' : 'sk-... / AIza... / sk-ant-...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                Custom Base URL (optional)
              </label>
              <input
                type="text"
                placeholder="e.g. http://127.0.0.1:11434/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                Fast Triage Model (Nano Tier Override)
              </label>
              <input
                type="text"
                placeholder={llmStatus?.models?.nano || 'Provider default'}
                value={fastModel}
                onChange={(e) => setFastModel(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                Code Synthesis Model (Super Tier Override)
              </label>
              <input
                type="text"
                placeholder={llmStatus?.models?.super || 'Provider default'}
                value={codingModel}
                onChange={(e) => setCodingModel(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1 font-medium">
                Deep Reasoning & Reports Model (Ultra Tier Override)
              </label>
              <input
                type="text"
                placeholder={llmStatus?.models?.ultra || 'Provider default'}
                value={reasoningModel}
                onChange={(e) => setReasoningModel(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button type="submit" disabled={savingLlm} className="web-btn-primary text-xs">
              <Check size={14} />
              <span>{savingLlm ? 'Saving...' : 'Save & Activate LLM Config'}</span>
            </button>
            <button
              type="button"
              disabled={testingLlm}
              onClick={handleTestLlm}
              className="web-btn-secondary text-xs"
            >
              <RefreshCw size={13} className={testingLlm ? 'animate-spin' : ''} />
              <span>{testingLlm ? 'Testing Live Call...' : 'Test Live Connection'}</span>
            </button>
          </div>
        </form>

        {llmTestResult && (
          <div
            className="p-3 rounded-lg border text-xs font-mono"
            style={{
              backgroundColor: llmTestResult.ok ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
              borderColor: llmTestResult.ok ? 'var(--status-success-border)' : 'var(--status-critical-border)',
              color: llmTestResult.ok ? 'var(--status-success)' : 'var(--status-critical)',
            }}
          >
            {llmTestResult.text}
          </div>
        )}
      </div>

      {/* 4. Protected Target Services Registry */}
      <div className="web-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Server size={16} className="text-[var(--accent-primary)]" />
            <span>Supervised Target Services ({targets.length})</span>
          </h2>
          <button
            type="button"
            onClick={() => setShowAddTarget(!showAddTarget)}
            className="web-btn-secondary text-xs"
          >
            <Plus size={13} />
            <span>{showAddTarget ? 'Cancel' : 'Add Target'}</span>
          </button>
        </div>

        <div className="space-y-2 text-xs">
          {targets.length === 0 ? (
            <p className="text-[var(--text-muted)]">No target services loaded.</p>
          ) : (
            targets.map((t) => (
              <div
                key={t.name}
                className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 font-mono">
                    <strong className="text-[var(--text-primary)]">{t.name}</strong>
                    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--accent-muted)] text-[var(--accent-primary)]">
                      {t.runtime}
                    </span>
                    {t.db_type && t.db_type !== 'none' && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--surface-hover)] text-[var(--text-secondary)]">
                        {t.db_type}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-[11px] text-[var(--text-secondary)]">
                    Upstream: {t.upstream_url} • Health: {t.health_url}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveTarget(t.name)}
                  className="text-[var(--status-critical)] hover:opacity-80 self-end sm:self-center p-1.5 cursor-pointer"
                  title={`Remove ${t.name}`}
                  aria-label={`Remove ${t.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        {showAddTarget && (
          <form onSubmit={handleAddTarget} className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-hover)] space-y-3">
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">Register New Protected Service</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Service Name</label>
                <input
                  type="text"
                  required
                  placeholder="billing-api"
                  value={newTarget.name}
                  onChange={(e) => setNewTarget({ ...newTarget, name: e.target.value })}
                  className="web-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Runtime Driver</label>
                <select
                  value={newTarget.runtime}
                  onChange={(e) =>
                    setNewTarget({ ...newTarget, runtime: e.target.value as TargetConfigPayload['runtime'] })
                  }
                  className="web-input w-full text-xs font-mono"
                >
                  <option value="process">Local OS Process</option>
                  <option value="docker">Docker Container</option>
                  <option value="compose">Docker Compose Service</option>
                  <option value="http">External HTTP Upstream</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Database Engine</label>
                <select
                  value={newTarget.db_type || 'none'}
                  onChange={(e) =>
                    setNewTarget({ ...newTarget, db_type: e.target.value as TargetConfigPayload['db_type'] })
                  }
                  className="web-input w-full text-xs font-mono"
                >
                  <option value="sqlite">SQLite</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Upstream URL</label>
                <input
                  type="text"
                  required
                  value={newTarget.upstream_url}
                  onChange={(e) => setNewTarget({ ...newTarget, upstream_url: e.target.value })}
                  className="web-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Health Check URL</label>
                <input
                  type="text"
                  required
                  value={newTarget.health_url}
                  onChange={(e) => setNewTarget({ ...newTarget, health_url: e.target.value })}
                  className="web-input w-full text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                  {newTarget.runtime === 'docker' ? 'Container Name' : 'Start Command (for process)'}
                </label>
                <input
                  type="text"
                  placeholder={newTarget.runtime === 'docker' ? 'my-api-container' : 'uvicorn app.main:app --port 8002'}
                  value={newTarget.runtime === 'docker' ? newTarget.container_name || '' : newTarget.command || ''}
                  onChange={(e) =>
                    newTarget.runtime === 'docker'
                      ? setNewTarget({ ...newTarget, container_name: e.target.value })
                      : setNewTarget({ ...newTarget, command: e.target.value })
                  }
                  className="web-input w-full text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Workspace Path (for Builder sandbox)</label>
                <input
                  type="text"
                  placeholder="./services/billing-api"
                  value={newTarget.workspace_path || ''}
                  onChange={(e) => setNewTarget({ ...newTarget, workspace_path: e.target.value })}
                  className="web-input w-full text-xs font-mono"
                />
              </div>
            </div>

            <button type="submit" className="web-btn-primary text-xs">
              <Check size={14} />
              <span>Register Service</span>
            </button>
          </form>
        )}
      </div>

      {/* 5. WAF Gateway IP Blocklist */}
      <div className="web-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <ShieldAlert size={16} className="text-[var(--status-critical)]" />
          <span>Live WAF Gateway IP Blocklist ({blockedIps.length})</span>
        </h2>

        <form onSubmit={handleManualBlockIp} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            placeholder="IPv4 / IPv6 address (e.g. 198.51.100.44)"
            value={manualBlockIp}
            onChange={(e) => setManualBlockIp(e.target.value)}
            className="web-input text-xs font-mono flex-1"
          />
          <input
            type="text"
            placeholder="Reason"
            value={manualBlockReason}
            onChange={(e) => setManualBlockReason(e.target.value)}
            className="web-input text-xs flex-1"
          />
          <button type="submit" className="web-btn-secondary text-xs shrink-0">
            Block IP (60m)
          </button>
        </form>

        {blockedIps.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">No IP addresses currently blocked at the WAF gateway.</p>
        ) : (
          <div className="space-y-2 text-xs">
            {blockedIps.map((b) => (
              <div
                key={b.ip}
                className="p-3 rounded-lg border border-[var(--status-critical-border)] bg-[var(--status-critical-bg)] flex items-center justify-between gap-2"
              >
                <div className="font-mono">
                  <strong className="text-[var(--status-critical)]">{b.ip}</strong>
                  <span className="text-[var(--text-secondary)] ml-2">— {b.reason}</span>
                  <span className="text-[10px] text-[var(--text-muted)] ml-2">
                    ({Math.max(1, Math.round(b.seconds_remaining / 60))}m left)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleUnblockIp(b.ip)}
                  className="web-btn-secondary text-[11px] py-1 px-2.5"
                >
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 6. Safety Tier Policy */}
      <div className="web-card p-6 space-y-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Lock size={16} className="text-[var(--status-warning)]" />
          <span>Safety Tier Policy</span>
        </h2>

        <div className="space-y-2 text-xs">
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-success)] block mb-0.5">Tier 0 — Automatic & Reversible</span>
            <p className="text-[var(--text-secondary)]">
              Online DB snapshots, temporary WAF IP blocks, supervised restarts, log rotation, release rollbacks, and Git branch PR creation.
            </p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-warning)] block mb-0.5">Tier 1 — Requires RFC 6238 TOTP / Passkey Approval</span>
            <p className="text-[var(--text-secondary)]">
              PR merge & live code deployment, database snapshot restore, schema migrations, secret rotation, network quarantine, and memory ceiling changes.
            </p>
          </div>
          <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <span className="font-semibold text-[var(--status-critical)] block mb-0.5">Tier 2 — Cryptographically Forbidden</span>
            <p className="text-[var(--text-secondary)]">
              Arbitrary shell execution, destructive unbacked SQL, disabling auth/TLS, raw PII exfiltration, and audit ledger deletion.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
