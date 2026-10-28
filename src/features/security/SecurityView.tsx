import React, { useState } from 'react';
import {
  ShieldAlert,
  Fingerprint,
  Camera,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { formatRelativeTime, truncateHash, formatBytes } from '../../lib/formatters';
import { SecurityReport } from '../../types/reports';

export const SecurityView: React.FC = () => {
  const { securityReports, auditLogs, snapshots } = useAlexia();

  const [activeTab, setActiveTab] = useState<'reports' | 'audit' | 'snapshots'>('reports');
  const [selectedReport, setSelectedReport] = useState<SecurityReport>(securityReports[0]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const handleCopyReport = () => {
    const text = selectedReport.sections
      .map((s) => `${s.heading}\n${s.content}\n`)
      .join('\n');
    navigator.clipboard.writeText(
      `${selectedReport.title}\n\n${selectedReport.disclaimer}\n\n${text}`
    );
    setCopyFeedback('Report copied to clipboard!');
    setTimeout(() => setCopyFeedback(null), 3000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            Security & Audit
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Compliance drafts, tamper-evident audit ledger, and container state snapshots.
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 p-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)]">
          <button
            onClick={() => setActiveTab('reports')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === 'reports'
                ? 'bg-[var(--surface-hover)] text-[var(--accent-primary)] font-semibold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Compliance Reports
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === 'audit'
                ? 'bg-[var(--surface-hover)] text-[var(--accent-primary)] font-semibold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Audit Ledger
          </button>
          <button
            onClick={() => setActiveTab('snapshots')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              activeTab === 'snapshots'
                ? 'bg-[var(--surface-hover)] text-[var(--accent-primary)] font-semibold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Snapshots
          </button>
        </div>
      </div>

      {/* Reports Tab */}
      {activeTab === 'reports' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-4 space-y-2.5">
            {securityReports.map((rep) => {
              const isSelected = selectedReport.id === rep.id;
              return (
                <div
                  key={rep.id}
                  onClick={() => setSelectedReport(rep)}
                  className={`web-card p-4 cursor-pointer transition-all ${
                    isSelected ? 'border-[var(--border-highlight)] ring-1 ring-[var(--accent-primary)]' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="font-bold text-[var(--text-primary)] font-mono">{rep.report_type.toUpperCase()}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">{formatRelativeTime(rep.created_at)}</span>
                  </div>
                  <h4 className="text-xs font-medium text-[var(--text-primary)] line-clamp-2">
                    {rep.title}
                  </h4>
                </div>
              );
            })}
          </div>

          <div className="lg:col-span-8 web-card p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <div>
                <h3 className="text-base font-bold text-[var(--text-primary)]">{selectedReport.title}</h3>
                <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">Report {selectedReport.id}</p>
              </div>
              <button
                onClick={handleCopyReport}
                className="web-btn-secondary text-xs"
              >
                <Copy size={13} />
                <span>Copy</span>
              </button>
            </div>

            {copyFeedback && (
              <div className="p-2.5 rounded-lg bg-[var(--status-success-bg)] text-[var(--status-success)] text-xs flex items-center gap-2">
                <CheckCircle2 size={14} />
                <span>{copyFeedback}</span>
              </div>
            )}

            <div className="space-y-4 text-xs">
              {selectedReport.sections.map((sec, i) => (
                <div key={i} className="p-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] space-y-1">
                  <h4 className="font-semibold text-[var(--accent-primary)]">{sec.heading}</h4>
                  <p className="text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">{sec.content}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Audit Log Tab */}
      {activeTab === 'audit' && (
        <div className="web-card overflow-hidden">
          <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between text-xs">
            <span className="font-semibold text-[var(--text-primary)]">SHA-256 Tamper-Evident Ledger</span>
            <span className="text-[var(--text-muted)] font-mono">1,482 verified blocks</span>
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
                  <th className="py-2.5 px-3.5">Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-[var(--surface-hover)]">
                    <td className="py-2.5 px-3.5 text-[var(--accent-primary)] font-semibold">{log.id}</td>
                    <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{formatRelativeTime(log.timestamp)}</td>
                    <td className="py-2.5 px-3.5 font-sans text-[var(--text-primary)]">{log.actor}</td>
                    <td className="py-2.5 px-3.5 font-sans text-[var(--text-secondary)]">{log.action}</td>
                    <td className="py-2.5 px-3.5">
                      <span className={`px-1.5 py-0.2 rounded text-[10px] ${
                        log.outcome === 'SUCCESS' ? 'text-[var(--status-success)] bg-[var(--status-success-bg)]' : 'text-[var(--status-warning)]'
                      }`}>
                        {log.outcome}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 text-[var(--text-muted)] text-[11px]">{truncateHash(log.current_hash, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Snapshots Tab */}
      {activeTab === 'snapshots' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {snapshots.map((snap) => (
            <div key={snap.id} className="web-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">{snap.id}</span>
                <span className="text-[10px] text-[var(--accent-primary)] bg-[var(--accent-muted)] px-2 py-0.5 rounded font-mono font-bold">
                  {snap.integrity_status.toUpperCase()}
                </span>
              </div>
              <h4 className="text-sm font-semibold text-[var(--text-primary)]">{snap.target_resource}</h4>
              <p className="text-xs text-[var(--text-secondary)]">Trigger: {snap.trigger_action}</p>
              <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)]">
                <span>Size: {formatBytes(snap.size_bytes)}</span>
                <span className="text-[var(--accent-primary)]">Restore Eligible</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
