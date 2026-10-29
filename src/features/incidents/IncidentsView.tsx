import React, { useState } from 'react';
import {
  Search,
  AlertTriangle,
  Bot,
  ExternalLink,
  ChevronRight,
  X,
  FileText,
  Activity,
  ShieldCheck,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { SeverityBadge } from '../../components/status/SeverityBadge';
import { StatusBadge } from '../../components/status/StatusBadge';
import { formatCurrency, formatRelativeTime } from '../../lib/formatters';

export const IncidentsView: React.FC = () => {
  const { incidents, selectedIncidentId, setSelectedIncidentId, modelCalls } = useAlexia();

  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'details' | 'diagnosis' | 'verification'>('details');

  const filteredIncidents = incidents.filter((inc) => {
    const matchesSearch =
      inc.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inc.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inc.affected_service.toLowerCase().includes(searchQuery.toLowerCase()) ||
      inc.summary.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSeverity = severityFilter === 'all' || inc.severity === severityFilter;
    const matchesStatus = statusFilter === 'all' || inc.status === statusFilter;
    return matchesSearch && matchesSeverity && matchesStatus;
  });

  const selectedIncident = incidents.find((i) => i.id === selectedIncidentId) || null;
  // FR-U2 reasoning trace: every model call made for this incident (model, tokens, latency, cost)
  const incidentCalls = selectedIncident ? modelCalls.filter((c) => c.incident_id === selectedIncident.id) : [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Incidents
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Monitor security threats, anomalies, and multi-agent automated remediation progress.
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 text-[var(--text-muted)]" size={15} />
          <input
            type="text"
            placeholder="Search by ID, service, or keywords..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="web-input pl-9 w-full text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="web-input text-xs cursor-pointer py-1.5"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="web-input text-xs cursor-pointer py-1.5"
          >
            <option value="all">All Statuses</option>
            <option value="open">Open</option>
            <option value="triaged">Triaged</option>
            <option value="acting">Acting</option>
            <option value="verifying">Verifying</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>

      {/* Main Incident List & Detail Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Incident List */}
        <div className={`space-y-3 ${selectedIncident ? 'lg:col-span-6 xl:col-span-5' : 'lg:col-span-12'}`}>
          {filteredIncidents.length === 0 ? (
            <div className="web-card p-10 text-center text-sm text-[var(--text-muted)]">
              No incidents match your current filter.
            </div>
          ) : (
            filteredIncidents.map((inc) => {
              const isSelected = selectedIncident?.id === inc.id;
              return (
                <div
                  key={inc.id}
                  onClick={() => setSelectedIncidentId(inc.id)}
                  className={`web-card p-4 cursor-pointer transition-all ${
                    isSelected
                      ? 'border-[var(--border-highlight)] ring-1 ring-[var(--accent-primary)]'
                      : 'hover:border-[var(--border-medium)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={inc.severity} size="sm" />
                      <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">
                        {inc.id}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] font-mono">
                        • {inc.affected_service}
                      </span>
                    </div>
                    <StatusBadge status={inc.status} size="sm" />
                  </div>

                  <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    {inc.title}
                  </h3>
                  <p className="text-xs text-[var(--text-secondary)] line-clamp-2 leading-relaxed">
                    {inc.summary}
                  </p>

                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
                    <span>Guardian: {inc.owner_agent}</span>
                    <span className="font-mono">{formatRelativeTime(inc.created_at)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Selected Incident Detail Pane */}
        {selectedIncident && (
          <div className="lg:col-span-6 xl:col-span-7 web-card p-6 space-y-5 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-[var(--border-subtle)]">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <SeverityBadge severity={selectedIncident.severity} size="sm" />
                  <span className="font-mono text-xs font-bold text-[var(--text-primary)]">
                    {selectedIncident.id}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--accent-primary)] font-mono">
                    {selectedIncident.affected_service}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-[var(--text-primary)]">
                  {selectedIncident.title}
                </h2>
              </div>
              <button
                onClick={() => setSelectedIncidentId(null)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                title="Close panel"
                aria-label="Close details"
              >
                <X size={18} />
              </button>
            </div>

            {/* Sub-tabs */}
            <div className="flex items-center gap-4 border-b border-[var(--border-subtle)] text-xs font-medium">
              <button
                onClick={() => setActiveTab('details')}
                className={`pb-2.5 transition-colors cursor-pointer ${
                  activeTab === 'details'
                    ? 'border-b-2 border-[var(--accent-primary)] text-[var(--accent-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => setActiveTab('diagnosis')}
                className={`pb-2.5 transition-colors cursor-pointer ${
                  activeTab === 'diagnosis'
                    ? 'border-b-2 border-[var(--accent-primary)] text-[var(--accent-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Diagnosis
              </button>
              <button
                onClick={() => setActiveTab('verification')}
                className={`pb-2.5 transition-colors cursor-pointer ${
                  activeTab === 'verification'
                    ? 'border-b-2 border-[var(--accent-primary)] text-[var(--accent-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Verification
              </button>
            </div>

            {/* Tab: Overview */}
            {activeTab === 'details' && (
              <div className="space-y-4 text-xs">
                <div>
                  <h4 className="font-semibold text-[var(--text-primary)] mb-1">Summary</h4>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    {selectedIncident.summary}
                  </p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-[var(--surface-hover)] border border-[var(--border-subtle)] font-mono text-[11px]">
                  <div>
                    <span className="text-[var(--text-muted)] block">Agent</span>
                    <span className="text-[var(--accent-primary)] font-semibold">{selectedIncident.owner_agent}</span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Cost</span>
                    <span className="text-[var(--text-primary)]">{formatCurrency(selectedIncident.cost_usd)}</span>
                  </div>
                  <div>
                    <span className="text-[var(--text-muted)] block">Status</span>
                    <span className="text-[var(--text-primary)] capitalize">{selectedIncident.status}</span>
                  </div>
                </div>

                {/* Lifecycle Stage Steps */}
                <div>
                  <h4 className="font-semibold text-[var(--text-primary)] mb-2">Remediation Steps</h4>
                  <div className="space-y-2">
                    {selectedIncident.stages.map((stage, i) => (
                      <div
                        key={stage.stage}
                        className="p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] flex items-start justify-between gap-2"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[var(--text-primary)]">
                              {i + 1}. {stage.label}
                            </span>
                            <span className="text-[10px] text-[var(--text-muted)] font-mono">
                              ({stage.responsible_agent})
                            </span>
                          </div>
                          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                            {stage.explanation}
                          </p>
                        </div>
                        <StatusBadge status={stage.status} size="sm" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Tab: Diagnosis */}
            {activeTab === 'diagnosis' && (
              <div className="space-y-4 text-xs">
                {selectedIncident.diagnosis ? (
                  <>
                    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-main)]">
                      <h4 className="font-semibold text-[var(--accent-primary)] mb-1">Root Cause</h4>
                      <p className="font-mono text-[var(--text-primary)]">
                        {selectedIncident.diagnosis.root_cause}
                      </p>
                      <span className="text-[11px] text-[var(--text-muted)] mt-1 block">
                        Confidence: {(selectedIncident.diagnosis.confidence * 100).toFixed(0)}%
                      </span>
                    </div>

                    <div>
                      <h4 className="font-semibold text-[var(--text-primary)] mb-1.5">Evidence Findings</h4>
                      <ul className="space-y-1 text-[var(--text-secondary)]">
                        {selectedIncident.diagnosis.evidence.map((ev, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-[var(--accent-primary)]">•</span>
                            <span className="font-mono text-[11px]">{ev}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4 className="font-semibold text-[var(--text-primary)] mb-1.5">Sources (Tavily)</h4>
                      {selectedIncident.diagnosis.sources?.length ? (
                        <ul className="space-y-1.5">
                          {selectedIncident.diagnosis.sources.map((src, i) => (
                            <li key={i}>
                              <a
                                href={src.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[var(--accent-primary)] hover:underline"
                              >
                                {src.title}
                                <ExternalLink size={11} />
                              </a>
                              {src.excerpt && <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{src.excerpt}</p>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[var(--text-muted)]">No web sources were needed for this diagnosis.</p>
                      )}
                    </div>

                    <div>
                      <h4 className="font-semibold text-[var(--text-primary)] mb-1.5">Reasoning Trace ({incidentCalls.length} model calls)</h4>
                      {incidentCalls.length ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left font-mono text-[11px]">
                            <thead className="text-[var(--text-muted)]">
                              <tr>
                                <th className="py-1 pr-3">Model</th>
                                <th className="py-1 pr-3">Task</th>
                                <th className="py-1 pr-3">Tokens</th>
                                <th className="py-1 pr-3">Latency</th>
                                <th className="py-1">Cost</th>
                              </tr>
                            </thead>
                            <tbody className="text-[var(--text-secondary)]">
                              {incidentCalls.map((c) => (
                                <tr key={c.id}>
                                  <td className="py-1 pr-3 text-[var(--accent-primary)]">{c.tier}</td>
                                  <td className="py-1 pr-3">{c.task}</td>
                                  <td className="py-1 pr-3">{c.input_tokens + c.output_tokens}</td>
                                  <td className="py-1 pr-3">{Math.round(c.latency_ms)} ms</td>
                                  <td className="py-1">{formatCurrency(c.cost_usd)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="text-[var(--text-muted)]">
                          {selectedIncident.model_calls.length} model calls recorded; details are listed under Model Usage.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-center py-6 text-[var(--text-muted)]">No diagnosis data recorded.</p>
                )}
              </div>
            )}

            {/* Tab: Verification */}
            {activeTab === 'verification' && (
              <div className="space-y-4 text-xs">
                {selectedIncident.verification ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3 rounded-xl border border-[var(--status-critical-border)] bg-[var(--status-critical-bg)]">
                        <span className="text-[10px] font-bold text-[var(--status-critical)] block mb-1">
                          BEFORE FIX
                        </span>
                        <code className="text-[11px] text-[var(--status-critical)] font-mono block">
                          {selectedIncident.verification.test_before.output}
                        </code>
                      </div>

                      <div className="p-3 rounded-xl border border-[var(--status-success-border)] bg-[var(--status-success-bg)]">
                        <span className="text-[10px] font-bold text-[var(--status-success)] block mb-1">
                          AFTER FIX
                        </span>
                        <code className="text-[11px] text-[var(--status-success)] font-mono block">
                          {selectedIncident.verification.test_after.output}
                        </code>
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-main)] text-[11px] font-mono flex items-center justify-between">
                      <span>Probe: HTTP {selectedIncident.verification.health_check.http_code} ({selectedIncident.verification.health_check.latency_ms}ms)</span>
                      <span className="text-[var(--accent-primary)] font-semibold">Healthy</span>
                    </div>
                  </>
                ) : (
                  <p className="text-center py-6 text-[var(--text-muted)]">Verification suite pending.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
