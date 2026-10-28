import React from 'react';
import { useAlexia } from '../../context/AlexiaContext';
import { formatCurrency, formatTokenCount } from '../../lib/formatters';

export const ModelUsageView: React.FC = () => {
  const { modelSummary, modelCalls } = useAlexia();

  const percentBudgetUsed = (
    (modelSummary.total_spend_usd / modelSummary.daily_budget_usd) *
    100
  ).toFixed(1);

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
            {percentBudgetUsed}% of daily budget
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
          <span className="text-[11px] text-[var(--text-muted)]">Sub-second response</span>
        </div>

        <div className="web-card p-4">
          <span className="text-xs text-[var(--text-secondary)]">Tavily Invocations</span>
          <div className="text-2xl font-bold text-[var(--text-primary)] mt-1 font-mono">
            {modelSummary.total_tavily_calls}
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">Threat intelligence queries</span>
        </div>
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
              {modelCalls.map((call) => (
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
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
