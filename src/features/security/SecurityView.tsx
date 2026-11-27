import React, { useEffect, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Copy,
  Database,
  Download,
  Lock,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Ban,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { apiClient } from '../../lib/api';
import { formatRelativeTime, truncateHash, formatBytes } from '../../lib/formatters';
import { SecurityReport } from '../../types/reports';

type SecurityTab = 'reports' | 'audit' | 'snapshots' | 'perimeter' | 'devices';

export const SecurityView: React.FC = () => {
  const {
    securityReports,
    auditLogs,
    auditChain,
    snapshots,
    blockedIps,
    devices,
    currentView,
    isLiveBackend,
    verifyAuditChain,
    takeSnapshot,
    verifySnapshot,
    restoreSnapshot,
    runIntegrityCheck,
    runMigrationGuard,
    blockIp,
    unblockIp,
    revokeDevice,
    openAuthModal,
    setCurrentView,
  } = useAlexia();

  const [activeTab, setActiveTab] = useState<SecurityTab>(
    currentView === 'audit' ? 'audit' : 'reports'
  );
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Audit filter & pagination state
  const [auditSearch, setAuditSearch] = useState('');
  const [auditOutcome, setAuditOutcome] = useState<string>('ALL');
  const [auditLimit, setAuditLimit] = useState<number>(25);

  // Migration dry-run state
  const [migrationSql, setMigrationSql] = useState('ALTER TABLE users DROP COLUMN phone;');
  const [migrationResult, setMigrationResult] = useState<Record<string, any> | null>(null);
  const [integrityTables, setIntegrityTables] = useState<Record<string, number> | null>(null);

  // Manual IP block form state
  const [ipToBlock, setIpToBlock] = useState('');
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [blockReason, setBlockReason] = useState('Manual containment via Security Console');

  useEffect(() => {
    if (currentView === 'audit') setActiveTab('audit');
    else if (currentView === 'security') setActiveTab('reports');
  }, [currentView]);

  const notify = (ok: boolean, text: string) => {
    setFeedback({ ok, text });
    setTimeout(() => setFeedback(null), 5000);
  };

  const selectedReport: SecurityReport | undefined =
    securityReports.find((r) => r.id === selectedReportId) ?? securityReports[0];

  const filteredAuditLogs = auditLogs.filter((log) => {
    const matchesQuery =
      !auditSearch.trim() ||
      String(log.actor).toLowerCase().includes(auditSearch.toLowerCase()) ||
      String(log.action).toLowerCase().includes(auditSearch.toLowerCase()) ||
      String(log.event || '').toLowerCase().includes(auditSearch.toLowerCase()) ||
      String(log.current_hash).toLowerCase().includes(auditSearch.toLowerCase());
    const matchesOutcome = auditOutcome === 'ALL' || log.outcome === auditOutcome;
    return matchesQuery && matchesOutcome;
  });

  const handleVerifyChain = async () => {
    const res = await verifyAuditChain();
    notify(res.success, res.message);
  };

  const handleExportMarkdown = () => {
    if (!selectedReport) return;
    const md = [
      `# ${selectedReport.title}`,
      `> ${selectedReport.disclaimer}`,
      `Incident: ${selectedReport.incident_id}`,
      ...selectedReport.sections.map((sec) => `## ${sec.heading}\n\n${sec.content}`),
    ].join('\n\n');
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedReport.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintPdf = () => {
    if (!selectedReport) return;
    if (isLiveBackend) {
      window.open(apiClient.getReportExportUrl(selectedReport.id, 'html'), '_blank', 'noopener,noreferrer');
      return;
    }
    window.print();
  };

  const handleCopyReport = () => {
    if (!selectedReport) return;
    const text = selectedReport.sections.map((s) => `${s.heading}\n${s.content}\n`).join('\n');
    navigator.clipboard?.writeText(`${selectedReport.title}\n\n${selectedReport.disclaimer}\n\n${text}`);
    notify(true, 'Report copied to clipboard.');
  };

  const handleExportAuditJson = () => {
    const blob = new Blob([JSON.stringify(filteredAuditLogs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alexia-audit-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportAuditCsv = () => {
    const header = 'id,timestamp,actor,action,outcome,previous_hash,current_hash,signature\n';
    const rows = filteredAuditLogs
      .map((r) =>
        [r.id, r.timestamp, r.actor, r.action, r.outcome, r.previous_hash, r.current_hash, r.signature || '']
          .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');
    const url = URL.createObjectURL(new Blob([header + rows], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `alexia-audit-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBlockIpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ipToBlock.trim()) return;
    const res = await blockIp(ipToBlock.trim(), blockMinutes, blockReason);
    notify(res.success, res.message);
    if (res.success) setIpToBlock('');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            Security & Audit
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Compliance breach notices, HMAC-signed audit ledger, snapshots, migration guard, and paired devices.
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)]">
          {(
            [
              { id: 'reports', label: 'Compliance Reports' },
              { id: 'audit', label: 'Audit Ledger' },
              { id: 'snapshots', label: 'Snapshots & DB' },
              { id: 'perimeter', label: 'IP Blocklist' },
              { id: 'devices', label: 'Devices & Security' },
            ] as Array<{ id: SecurityTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                activeTab === t.id
                  ? 'bg-[var(--surface-hover)] text-[var(--accent-primary)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
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
          {feedback.ok ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* 1. Reports Tab */}
      {activeTab === 'reports' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-4 space-y-2.5">
            {securityReports.length === 0 && (
              <div className="web-card p-6 text-xs text-[var(--text-muted)] text-center">
                No breach-report drafts yet. Run scenario S6 to have Sentinel draft CERT-In / DPDP / GDPR notices.
              </div>
            )}
            {securityReports.map((rep) => {
              const isSelected = selectedReport?.id === rep.id;
              return (
                <div
                  key={rep.id}
                  onClick={() => setSelectedReportId(rep.id)}
                  className={`web-card p-4 cursor-pointer transition-all ${
                    isSelected ? 'border-[var(--border-highlight)] ring-1 ring-[var(--accent-primary)]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="font-bold text-[var(--text-primary)] font-mono">{rep.report_type.toUpperCase()}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">{formatRelativeTime(rep.created_at)}</span>
                  </div>
                  <h4 className="text-xs font-medium text-[var(--text-primary)] line-clamp-2">{rep.title}</h4>
                </div>
              );
            })}
          </div>

          {selectedReport && (
            <div className="lg:col-span-8 web-card p-6 space-y-4">
              <p className="p-2.5 rounded-lg text-[11px] font-semibold bg-[var(--status-warning-bg)] text-[var(--status-warning)] border border-[var(--status-warning-border)]">
                {selectedReport.disclaimer}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[var(--border-subtle)]">
                <div>
                  <h3 className="text-base font-bold text-[var(--text-primary)]">{selectedReport.title}</h3>
                  <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
                    Report {selectedReport.id} • Incident {selectedReport.incident_id}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={handleCopyReport} className="web-btn-secondary text-xs">
                    <Copy size={13} />
                    <span>Copy</span>
                  </button>
                  <button type="button" onClick={handleExportMarkdown} className="web-btn-secondary text-xs">
                    <Download size={13} />
                    <span>Export .md</span>
                  </button>
                  <button type="button" onClick={handlePrintPdf} className="web-btn-primary text-xs">
                    <Printer size={13} />
                    <span>Print / PDF</span>
                  </button>
                </div>
              </div>

              <div className="space-y-4 text-xs">
                {selectedReport.sections.map((sec, i) => (
                  <div key={i} className="p-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] space-y-1">
                    <h4 className="font-semibold text-[var(--accent-primary)]">{sec.heading}</h4>
                    <p className="text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">{sec.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2. Audit Log Tab */}
      {activeTab === 'audit' && (
        <div className="web-card overflow-hidden">
          <div className="p-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--text-primary)]">
                SHA-256 + HMAC-SHA256 Append-Only Ledger
              </span>
              <span
                className="font-mono font-semibold px-2 py-0.5 rounded text-[11px]"
                style={{
                  backgroundColor:
                    auditChain && !auditChain.verified ? 'var(--status-critical-bg)' : 'var(--status-success-bg)',
                  color: auditChain && !auditChain.verified ? 'var(--status-critical)' : 'var(--status-success)',
                }}
              >
                {auditChain
                  ? auditChain.verified
                    ? `Chain Verified ✓ (${auditChain.rows.toLocaleString()} blocks)`
                    : 'TAMPERING DETECTED'
                  : 'Offline Demo Ledger'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleVerifyChain} className="web-btn-secondary text-[11px]">
                <ShieldCheck size={12} />
                <span>Verify Chain</span>
              </button>
              <button type="button" onClick={handleExportAuditCsv} className="web-btn-secondary text-[11px]">
                <Download size={12} />
                <span>Export CSV</span>
              </button>
              <button type="button" onClick={handleExportAuditJson} className="web-btn-secondary text-[11px]">
                <Download size={12} />
                <span>Export JSON</span>
              </button>
            </div>
          </div>

          {/* Search & Outcome Filter */}
          <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 bg-[var(--bg-main)]">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-2.5 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder="Filter audit blocks by actor, action, or hash..."
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                className="web-input pl-8 w-full text-xs"
              />
            </div>
            <select
              value={auditOutcome}
              onChange={(e) => setAuditOutcome(e.target.value)}
              className="web-input text-xs py-1.5"
            >
              <option value="ALL">All Outcomes</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="DENIED">DENIED</option>
              <option value="ROLLED_BACK">ROLLED_BACK</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px] bg-[var(--surface-hover)]">
                  <th className="py-2.5 px-3.5">Block</th>
                  <th className="py-2.5 px-3.5">Timestamp</th>
                  <th className="py-2.5 px-3.5">Actor</th>
                  <th className="py-2.5 px-3.5">Action</th>
                  <th className="py-2.5 px-3.5">Outcome</th>
                  <th className="py-2.5 px-3.5">SHA-256 / HMAC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {filteredAuditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[var(--text-muted)] font-sans">
                      No audit blocks match the current filter.
                    </td>
                  </tr>
                ) : (
                  filteredAuditLogs.slice(0, auditLimit).map((log) => (
                    <tr key={log.id} className="hover:bg-[var(--surface-hover)]">
                      <td className="py-2.5 px-3.5 text-[var(--accent-primary)] font-semibold">{log.id}</td>
                      <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{formatRelativeTime(log.timestamp)}</td>
                      <td className="py-2.5 px-3.5 font-sans text-[var(--text-primary)]">{log.actor}</td>
                      <td className="py-2.5 px-3.5 font-sans text-[var(--text-secondary)] max-w-sm truncate" title={log.action}>
                        {log.action}
                      </td>
                      <td className="py-2.5 px-3.5">
                        <span
                          className={`px-1.5 py-0.2 rounded text-[10px] ${
                            log.outcome === 'SUCCESS'
                              ? 'text-[var(--status-success)] bg-[var(--status-success-bg)]'
                              : log.outcome === 'DENIED'
                              ? 'text-[var(--status-critical)] bg-[var(--status-critical-bg)]'
                              : 'text-[var(--status-warning)] bg-[var(--status-warning-bg)]'
                          }`}
                        >
                          {log.outcome}
                        </span>
                      </td>
                      <td className="py-2.5 px-3.5 text-[var(--text-muted)] text-[11px]">
                        <span>{truncateHash(log.current_hash, 12)}</span>
                        {log.signature?.startsWith('hmac-sha256:') && (
                          <span className="ml-1.5 text-[9px] px-1 py-0.2 rounded bg-[var(--accent-muted)] text-[var(--accent-primary)]">
                            HMAC
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {filteredAuditLogs.length > auditLimit && (
            <div className="p-3 border-t border-[var(--border-subtle)] text-center">
              <button
                type="button"
                onClick={() => setAuditLimit((prev) => prev + 25)}
                className="web-btn-secondary text-xs"
              >
                Load more ({filteredAuditLogs.length - auditLimit} remaining)
              </button>
            </div>
          )}
        </div>
      )}

      {/* 3. Snapshots & Database Integrity Tab */}
      {activeTab === 'snapshots' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Verified State Snapshots ({snapshots.length})
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const res = await runIntegrityCheck();
                  if (res.tables) setIntegrityTables(res.tables);
                  notify(res.success, res.message);
                }}
                className="web-btn-secondary text-xs"
              >
                <Database size={14} />
                <span>Run DB Integrity Check</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const res = await takeSnapshot();
                  notify(res.success, res.message);
                }}
                className="web-btn-primary text-xs"
              >
                <Camera size={14} />
                <span>Create Snapshot</span>
              </button>
            </div>
          </div>

          {integrityTables && (
            <div className="web-card p-4 text-xs font-mono flex flex-wrap items-center justify-between gap-2">
              <span className="text-[var(--status-success)] font-semibold">
                SQLite PRAGMA quick_check: OK
              </span>
              <span className="text-[var(--text-secondary)]">
                Tables:{' '}
                {Object.entries(integrityTables)
                  .map(([tbl, cnt]) => `${tbl} (${cnt} rows)`)
                  .join(' · ')}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {snapshots.length === 0 ? (
              <div className="web-card p-8 text-center text-xs text-[var(--text-muted)] md:col-span-2">
                No snapshots created yet. Click &ldquo;Create Snapshot&rdquo; to capture an online SHA-256 backup.
              </div>
            ) : (
              snapshots.map((snap) => (
                <div key={snap.id} className="web-card p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">{snap.id}</span>
                    <span className="text-[10px] text-[var(--accent-primary)] bg-[var(--accent-muted)] px-2 py-0.5 rounded font-mono font-bold">
                      {snap.integrity_status.toUpperCase()}
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">{snap.target_resource}</h4>
                  <p className="text-xs text-[var(--text-secondary)]">Trigger: {snap.trigger_action}</p>
                  <p className="text-[11px] font-mono text-[var(--text-muted)] truncate" title={snap.sha256_checksum}>
                    SHA-256: {snap.sha256_checksum || 'n/a'}
                  </p>
                  <div className="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)] text-[11px]">
                    <span className="font-mono text-[var(--text-muted)]">Size: {formatBytes(snap.size_bytes)}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await verifySnapshot(snap.id);
                          notify(res.success, res.message);
                        }}
                        className="web-btn-secondary text-[11px] py-1 px-2.5"
                      >
                        <ShieldCheck size={12} />
                        <span>Verify</span>
                      </button>
                      <button
                        type="button"
                        disabled={!snap.restore_eligible}
                        onClick={async () => {
                          const res = await restoreSnapshot(snap.id);
                          notify(res.success, res.message);
                          if (res.success && isLiveBackend) setCurrentView('approvals');
                        }}
                        className="web-btn-secondary text-[11px] py-1 px-2.5 text-[var(--accent-primary)] disabled:opacity-50"
                      >
                        <RotateCcw size={12} />
                        <span>Restore (Tier 1)</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Integrity Migration Dry-Run Tool (FR-I3) */}
          <div className="web-card p-5 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Integrity Migration Guard — Throwaway Copy Dry-Run
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Executes proposed SQL DDL against an isolated copy of the database to detect dropped tables, columns, or data loss before deployment.
              </p>
            </div>
            <textarea
              rows={2}
              value={migrationSql}
              onChange={(e) => setMigrationSql(e.target.value)}
              className="web-input w-full text-xs font-mono"
            />
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={async () => {
                  const res = await runMigrationGuard(migrationSql);
                  setMigrationResult(res);
                }}
                className="web-btn-secondary text-xs"
              >
                Dry-Run Migration
              </button>
              {migrationResult && (
                <span
                  className="text-xs font-mono font-semibold"
                  style={{
                    color: migrationResult.safe ? 'var(--status-success)' : 'var(--status-critical)',
                  }}
                >
                  {migrationResult.safe
                    ? 'SAFE ✓ (0 rows at risk)'
                    : `BLOCKED: ${migrationResult.risk_summary || migrationResult.error} (${migrationResult.estimated_records_at_risk ?? 0} records at risk)`}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 4. Perimeter & Active IP Blocklist Tab */}
      {activeTab === 'perimeter' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form onSubmit={handleBlockIpSubmit} className="lg:col-span-4 web-card p-5 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Ban size={15} className="text-[var(--status-critical)]" />
              <span>Temporary IP Containment (Tier 0)</span>
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              Blocks an offending external IPv4/IPv6 address at the reverse proxy & ShopLite middleware (max 60 minutes; loopback protected).
            </p>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Source IP Address</label>
              <input
                type="text"
                placeholder="e.g. 198.51.100.88"
                value={ipToBlock}
                onChange={(e) => setIpToBlock(e.target.value)}
                className="web-input w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Duration (minutes, max 60)</label>
              <input
                type="number"
                min={1}
                max={60}
                value={blockMinutes}
                onChange={(e) => setBlockMinutes(Math.min(60, Math.max(1, Number(e.target.value) || 60)))}
                className="web-input w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1">Reason</label>
              <input
                type="text"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                className="web-input w-full text-xs"
              />
            </div>
            <button type="submit" className="web-btn-primary w-full text-xs">
              Block IP Temporarily
            </button>
          </form>

          <div className="lg:col-span-8 web-card overflow-hidden">
            <div className="p-4 border-b border-[var(--border-subtle)] text-xs font-semibold text-[var(--text-primary)]">
              Active Contained IP Addresses ({blockedIps.length})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px] bg-[var(--surface-hover)]">
                    <th className="py-2.5 px-3.5">IP Address</th>
                    <th className="py-2.5 px-3.5">Reason</th>
                    <th className="py-2.5 px-3.5">Expires In</th>
                    <th className="py-2.5 px-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {blockedIps.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-[var(--text-muted)] font-sans">
                        No IP addresses currently blocked. Run Scenario S5 or S6 to see Sentinel perimeter containment.
                      </td>
                    </tr>
                  ) : (
                    blockedIps.map((b) => (
                      <tr key={b.ip} className="hover:bg-[var(--surface-hover)]">
                        <td className="py-2.5 px-3.5 text-[var(--status-critical)] font-semibold">{b.ip}</td>
                        <td className="py-2.5 px-3.5 font-sans text-[var(--text-secondary)]">{b.reason}</td>
                        <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{Math.ceil(b.seconds_remaining / 60)}m</td>
                        <td className="py-2.5 px-3.5 text-right">
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await unblockIp(b.ip);
                              notify(res.success, res.message);
                            }}
                            className="web-btn-secondary text-[11px] py-1 px-2.5"
                          >
                            Unblock
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. Devices & Security Tab (FR-M9) */}
      {activeTab === 'devices' && (
        <div className="space-y-4">
          <div className="web-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-muted)] text-[var(--accent-primary)] flex items-center justify-center">
                <Lock size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Operator Authentication, TOTP & WebAuthn Passkeys
                </h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  Enroll hardware/platform passkeys, view Authenticator TOTP secret, and manage paired mobile companions.
                </p>
              </div>
            </div>
            <button type="button" onClick={openAuthModal} className="web-btn-primary text-xs">
              <Smartphone size={14} />
              <span>Manage Session & Passkeys</span>
            </button>
          </div>

          <div className="web-card overflow-hidden">
            <div className="p-4 border-b border-[var(--border-subtle)] text-xs font-semibold text-[var(--text-primary)]">
              Registered Operator & Mobile Companion Devices ({devices.length})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px] bg-[var(--surface-hover)]">
                    <th className="py-2.5 px-3.5">Device ID</th>
                    <th className="py-2.5 px-3.5">Label / Platform</th>
                    <th className="py-2.5 px-3.5">Operator</th>
                    <th className="py-2.5 px-3.5">Last Seen</th>
                    <th className="py-2.5 px-3.5">Status</th>
                    <th className="py-2.5 px-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {devices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-[var(--text-muted)] font-sans">
                        No paired devices recorded yet. Sign in via &ldquo;Manage Session &amp; Passkeys&rdquo; to register this device.
                      </td>
                    </tr>
                  ) : (
                    devices.map((dev) => {
                      const revoked = Boolean(dev.is_revoked);
                      return (
                        <tr key={dev.device_id} className="hover:bg-[var(--surface-hover)]">
                          <td className="py-2.5 px-3.5 text-[var(--text-primary)] font-semibold">{dev.device_id}</td>
                          <td className="py-2.5 px-3.5 font-sans text-[var(--text-secondary)]">
                            {dev.device_name} ({dev.platform})
                          </td>
                          <td className="py-2.5 px-3.5 text-[var(--text-primary)]">{dev.user}</td>
                          <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{formatRelativeTime(dev.last_seen)}</td>
                          <td className="py-2.5 px-3.5">
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] ${
                                revoked
                                  ? 'bg-[var(--status-critical-bg)] text-[var(--status-critical)]'
                                  : 'bg-[var(--status-success-bg)] text-[var(--status-success)]'
                              }`}
                            >
                              {revoked ? 'REVOKED' : 'ACTIVE'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3.5 text-right">
                            {!revoked && (
                              <button
                                type="button"
                                onClick={async () => {
                                  const res = await revokeDevice(dev.device_id);
                                  notify(res.success, res.message);
                                }}
                                className="web-btn-secondary text-[11px] py-1 px-2.5 text-[var(--status-critical)]"
                              >
                                <Trash2 size={12} />
                                <span>Revoke</span>
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
