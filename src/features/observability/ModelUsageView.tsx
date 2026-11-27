import React from 'react';
import { useAlexia } from '../../context/AlexiaContext';
import { formatCurrency, formatTokenCount } from '../../lib/formatters';

export const ModelUsageView: React.FC = () => {
  const { modelSummary, modelCalls } = useAlexia();

  const percentBudgetUsed =
    modelSummary.daily_budget_usd > 0
      ? ((modelSummary.total_spend_usd / modelSummary.daily_budget_usd) * 100).toFixed(1)
      : '0.0';

  const tierCards = [
    {
      key: 'nano',
      label: 'Nemotron 3 Nano',
      role: 'Fast event routing & log classification',
      stats: modelSummary.tier_breakdown?.nano ?? { calls: 0, tokens: 0, cost_usd: 0 },
    },
    {
      key: 'super',
      label: 'Nemotron 3 Super',
      role: 'Root-cause diagnosis & patch synthesis',
      stats: modelSummary.tier_breakdown?.super ?? { calls: 0, tokens: 0, cost_usd: 0 },
    },
    {
      key: 'ultra',
      label: 'Nemotron 3 Ultra',
      role: 'Deep multi-service forensics & compliance drafts',
      stats: modelSummary.tier_breakdown?.ultra ?? { calls: 0, tokens: 0, cost_usd: 0 },
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--text-primary)]">
          Model Usage
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Concise breakdown of token spend, latency, and invocation costs across Nano, Super, and Ultra tiers.
        </p>
      </div>

      {/* Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="web-card p-4">
          <span className="text-xs text-[var(--text-secondary)]">Today's Spend</span>
          <div className="text-2xl font-bold text-[var(--text-primary)] mt-1 font-mono">
            {formatCurrency(modelSummary.total_spend_usd)}
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            {percentBudgetUsed}% of {formatCurrency(modelSummary.daily_budget_usd)} budget
          </span>
        </div>

        <div className="web-card p-4">
          <span className="text-xs text-[var(--text-secondary)]">Total Tokens</span>
          <div className="text-2xl font-bold text-[var(--text-primary)] mt-1 font-mono">
            {formatTokenCount(modelSummary.total_input_tokens + modelSummary.total_output_tokens)}
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            In: {formatTokenCount(modelSummary.total_input_tokens)} • Out: {formatTokenCount(modelSummary.total_output_tokens)}
          </span>
        </div>

        <div className="web-card p-4">
          <span className="text-xs text-[var(--text-secondary)]">Average Latency</span>
          <div className="text-2xl font-bold text-[var(--accent-primary)] mt-1 font-mono">
            {modelSummary.avg_latency_ms} ms
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            {modelSummary.total_calls} calls • {modelSummary.failed_calls} failed
          </span>
        </div>

        <div className="web-card p-4">
          <span className="text-xs text-[var(--text-secondary)]">Tavily Invocations</span>
          <div className="text-2xl font-bold text-[var(--text-primary)] mt-1 font-mono">
            {modelSummary.total_tavily_calls}
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-mono">
            Cache hit rate: {(modelSummary.cache_hit_rate_percent ?? 0).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Per-Tier Breakdown (FR-U5) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="tier-breakdown-grid">
        {tierCards.map((tier) => (
          <div key={tier.key} className="web-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--text-primary)] font-mono">
                {tier.label}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-[var(--accent-muted)] text-[var(--accent-primary)]">
                {tier.key}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">{tier.role}</p>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[var(--border-subtle)] text-xs font-mono">
              <div>
                <span className="text-[10px] text-[var(--text-muted)] block">Calls</span>
                <span className="font-semibold text-[var(--text-primary)]">{tier.stats.calls}</span>
              </div>
              <div>
                <span className="text-[10px] text-[var(--text-muted)] block">Tokens</span>
                <span className="font-semibold text-[var(--text-primary)]">
                  {formatTokenCount(tier.stats.tokens ?? 0)}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-[var(--text-muted)] block">Cost</span>
                <span className="font-semibold text-[var(--accent-primary)]">
                  {formatCurrency(tier.stats.cost_usd)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Readable Invocations Table */}
      <div className="web-card overflow-hidden">
        <div className="p-4 border-b border-[var(--border-subtle)] text-xs font-semibold text-[var(--text-primary)]">
          Recent Model Invocations
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-[var(--text-muted)] text-[11px] bg-[var(--surface-hover)]">
                <th className="py-2.5 px-3.5">Call ID</th>
                <th className="py-2.5 px-3.5">Model</th>
                <th className="py-2.5 px-3.5">Tier</th>
                <th className="py-2.5 px-3.5">Task Description</th>
                <th className="py-2.5 px-3.5">Latency</th>
                <th className="py-2.5 px-3.5">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {modelCalls.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 px-3.5 text-center font-sans text-[var(--text-muted)]">
                    No model invocations recorded for the current window.
                  </td>
                </tr>
              ) : (
                modelCalls.map((call) => (
                  <tr key={call.id} className="hover:bg-[var(--surface-hover)]">
                    <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{call.id}</td>
                    <td className="py-2.5 px-3.5 font-semibold text-[var(--text-primary)]">{call.model_name}</td>
                    <td className="py-2.5 px-3.5">
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-[var(--surface-hover)] text-[var(--accent-primary)]">
                        {call.tier}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 font-sans text-[var(--text-secondary)] max-w-xs truncate">{call.task}</td>
                    <td className="py-2.5 px-3.5 text-[var(--text-muted)]">{call.latency_ms}ms</td>
                    <td className="py-2.5 px-3.5 text-[var(--accent-primary)] font-semibold">{formatCurrency(call.cost_usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
