import React from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  CheckSquare,
  DollarSign,
  ArrowRight,
  Server,
  Bot,
  PlayCircle,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { SeverityBadge } from '../../components/status/SeverityBadge';
import { StatusBadge } from '../../components/status/StatusBadge';
import { formatCurrency } from '../../lib/formatters';

export const OverviewView: React.FC = () => {
  const {
    incidents,
    approvals,
    agents,
    services,
    modelSummary,
    setCurrentView,
    setSelectedIncidentId,
  } = useAlexia();

  const openIncidents = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  );
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const healthyServicesCount = services.filter((s) => s.status === 'healthy').length;

  return (
    <div className="space-y-8">
      {/* 1. Header Hero Section */}
      <div className="relative rounded-2xl border p-6 sm:p-8 overflow-hidden web-card">

        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium mb-3 border"
            style={{
              backgroundColor: 'var(--accent-muted)',
              borderColor: 'var(--border-highlight)',
              color: 'var(--accent-primary)',
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
            <span>Autonomous Security Engine Active</span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-[var(--text-primary)]">
            Alexia Guardian
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mt-2 leading-relaxed">
            Continuous DevSecOps surveillance monitoring infrastructure incidents, Docker microservice health, and automated remediation workflows.
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-5">
            <button
              onClick={() => setCurrentView('incidents')}
              className="web-btn-primary"
            >
              <span>View Incidents</span>
              <ArrowRight size={14} />
            </button>
            <button
              onClick={() => setCurrentView('scenarios')}
              className="web-btn-secondary"
            >
              <PlayCircle size={15} />
              <span>Run scenario</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. Four Compact Summary Cards (Small, consistent, readable) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: System Health */}
        <div className="web-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="font-medium">System Health</span>
            <ShieldCheck size={16} className="text-[var(--accent-primary)]" />
          </div>
          <div className="my-2">
            <span className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">
              {healthyServicesCount}/{services.length} Healthy
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            ShopLite Docker Stack
          </span>
        </div>

        {/* Card 2: Open Incidents */}
        <div
          onClick={() => setCurrentView('incidents')}
          className="web-card p-4 flex flex-col justify-between cursor-pointer hover:border-[var(--status-critical-border)]"
        >
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Open Incidents</span>
            <AlertTriangle size={16} className="text-[var(--status-critical)]" />
          </div>
          <div className="my-2">
            <span className="text-xl sm:text-2xl font-bold text-[var(--status-critical)]">
              {openIncidents.length} Active
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            {incidents.filter((i) => i.status === 'resolved').length} resolved today
          </span>
        </div>

        {/* Card 3: Pending Approvals */}
        <div
          onClick={() => setCurrentView('approvals')}
          className="web-card p-4 flex flex-col justify-between cursor-pointer hover:border-[var(--status-warning-border)]"
        >
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Pending Approvals</span>
            <CheckSquare size={16} className="text-[var(--status-warning)]" />
          </div>
          <div className="my-2">
            <span className="text-xl sm:text-2xl font-bold text-[var(--status-warning)]">
              {pendingApprovals.length} Actions
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            Human-in-the-loop Tier 1
          </span>
        </div>

        {/* Card 4: Model Usage */}
        <div
          onClick={() => setCurrentView('usage')}
          className="web-card p-4 flex flex-col justify-between cursor-pointer hover:border-[var(--border-medium)]"
        >
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="font-medium">Model Usage</span>
            <DollarSign size={16} className="text-[var(--accent-primary)]" />
          </div>
          <div className="my-2">
            <span className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">
              {formatCurrency(modelSummary.total_spend_usd)}
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            Cap: {formatCurrency(modelSummary.daily_budget_usd)}
          </span>
        </div>
      </div>

      {/* 3. Simple Two-Column Layout (Desktop) / Vertically Stacked (Mobile) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Main Section: Recent Incidents (~65% / 8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between pb-1">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Recent Incidents
            </h2>
            <button
              onClick={() => setCurrentView('incidents')}
              className="text-xs text-[var(--accent-primary)] hover:underline font-medium cursor-pointer"
            >
              All incidents →
            </button>
          </div>

          <div className="space-y-3">
            {incidents.slice(0, 3).map((incident) => (
              <div
                key={incident.id}
                onClick={() => {
                  setSelectedIncidentId(incident.id);
                  setCurrentView('incidents');
                }}
                className="web-card p-4 cursor-pointer hover:border-[var(--border-highlight)] transition-colors group"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={incident.severity} size="sm" />
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {incident.id}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)] font-mono">
                      • {incident.affected_service}
                    </span>
                  </div>
                  <StatusBadge status={incident.status} size="sm" />
                </div>

                <h3 className="text-sm font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent-primary)] transition-colors">
                  {incident.title}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-1 line-clamp-2 leading-relaxed">
                  {incident.summary}
                </p>

                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[var(--border-subtle)] text-[11px]">
                  <span className="text-[var(--text-muted)] font-mono">
                    Guardian: {incident.owner_agent}
                  </span>
                  <span className="text-[var(--accent-primary)] font-medium group-hover:underline">
                    View details →
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Secondary Section: Service Health & Guardian Fleet (~35% / 4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Service Health */}
          <div className="web-card p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Server size={15} className="text-[var(--accent-primary)]" />
                <span>Service Health</span>
              </h3>
              <button
                onClick={() => setCurrentView('services')}
                className="text-xs text-[var(--accent-primary)] hover:underline cursor-pointer"
              >
                View
              </button>
            </div>

            <div className="space-y-2">
              {services.map((srv) => (
                <div
                  key={srv.id}
                  className="flex items-center justify-between text-xs py-1"
                >
                  <span className="font-medium text-[var(--text-primary)] font-mono">
                    {srv.name}
                  </span>
                  <span className="flex items-center gap-1.5 text-[var(--status-success)] text-[11px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)]" />
                    <span>{srv.status}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Guardian Agent Fleet */}
          <div className="web-card p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Bot size={15} className="text-[var(--accent-primary)]" />
                <span>Guardian Agents</span>
              </h3>
              <span className="text-[10px] font-mono text-[var(--accent-primary)] bg-[var(--accent-muted)] px-1.5 py-0.5 rounded">
                Active
              </span>
            </div>

            <div className="space-y-2 text-xs">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between py-1 border-b border-[var(--border-subtle)] last:border-none"
                >
                  <div className="min-w-0" title={agent.role_description}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[var(--text-primary)]">
                        {agent.name}
                      </span>
                      <span className="text-[10px] text-[var(--text-muted)] font-mono">
                        {agent.total_actions_today} actions today
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] truncate" title={agent.current_task}>
                      {agent.state === 'Idle' ? agent.latest_event : agent.current_task}
                    </p>
                  </div>
                  <span
                    className="text-[10px] font-mono uppercase shrink-0 ml-2"
                    style={{
                      color:
                        agent.state === 'Waiting for approval'
                          ? 'var(--status-warning)'
                          : agent.state === 'Working'
                          ? 'var(--accent-primary)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {agent.state}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
