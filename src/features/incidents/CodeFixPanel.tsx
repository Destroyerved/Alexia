import React from 'react';
import { CheckCircle2, ExternalLink, GitPullRequest, XCircle } from 'lucide-react';
import { CodeFix } from '../../types/incidents';

interface CodeFixPanelProps {
  fix: CodeFix;
  proof?: { failed_before: boolean; passed_after: boolean; before_log: string; after_log: string };
}

/** Colour a unified diff line by line (+ added, - removed, @@ hunk header). */
const DiffBlock: React.FC<{ diff: string }> = ({ diff }) => (
  <pre className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] text-[11px] leading-relaxed overflow-x-auto font-mono">
    {diff.split('\n').map((line, i) => {
      const color = line.startsWith('+++') || line.startsWith('---')
        ? 'var(--text-muted)'
        : line.startsWith('+')
        ? 'var(--status-success)'
        : line.startsWith('-')
        ? 'var(--status-critical)'
        : line.startsWith('@@')
        ? 'var(--accent-primary)'
        : 'var(--text-secondary)';
      return (
        <div key={i} style={{ color }}>
          {line || ' '}
        </div>
      );
    })}
  </pre>
);

/** `good` = the phase behaved as the proof requires (RED: test failed, GREEN: test passed). */
const LogBlock: React.FC<{ label: string; good: boolean; log: string }> = ({ label, good, log }) => {
  const tone = good ? 'success' : 'critical';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: `var(--status-${tone})` }}>
        {good ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        <span>{label}</span>
      </div>
      <pre
        className="p-3 rounded-lg border text-[10.5px] leading-snug max-h-56 overflow-auto font-mono whitespace-pre-wrap"
        style={{ borderColor: `var(--status-${tone}-border)`, backgroundColor: `var(--status-${tone}-bg)`, color: 'var(--text-secondary)' }}
      >
        {log || '(no output)'}
      </pre>
    </div>
  );
};

export const CodeFixPanel: React.FC<CodeFixPanelProps> = ({ fix, proof }) => (
  <div className="space-y-4 text-xs">
    <div
      className="p-3.5 rounded-xl border flex flex-wrap items-center justify-between gap-2"
      style={{
        borderColor: fix.proven ? 'var(--status-success-border)' : 'var(--status-critical-border)',
        backgroundColor: fix.proven ? 'var(--status-success-bg)' : 'var(--status-critical-bg)',
      }}
    >
      <div>
        <p className="font-bold" style={{ color: fix.proven ? 'var(--status-success)' : 'var(--status-critical)' }}>
          {fix.proven ? 'Red → Green proof verified in sandbox' : 'Fix not proven: escalated to a human'}
        </p>
        <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
          {fix.summary} · {fix.attempts.length} attempt{fix.attempts.length === 1 ? '' : 's'} ·{' '}
          {fix.attempts.map((a) => a.model_tier).join(' → ')} · runner: {fix.test_runner || 'pytest'}
        </p>
        {fix.base_note && <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{fix.base_note}</p>}
      </div>
      {fix.pr && (
        <a
          href={fix.pr.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="web-btn-secondary text-[11px]"
          title={fix.pr.mode === 'simulated' ? 'GitHub token not configured: PR simulated locally' : 'Open the pull request'}
        >
          <GitPullRequest size={13} />
          <span>PR #{fix.pr.number}{fix.pr.mode === 'simulated' ? ' (simulated)' : ''}</span>
          <ExternalLink size={11} />
        </a>
      )}
    </div>

    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-main)] space-y-1">
      <h4 className="font-semibold text-[var(--accent-primary)]">Root cause</h4>
      <p className="text-[var(--text-primary)]">{fix.root_cause}</p>
      <p className="text-[var(--text-secondary)]">{fix.explanation}</p>
    </div>

    {proof && (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <LogBlock label="Before patch: regression test must FAIL (RED)" good={proof.failed_before} log={proof.before_log} />
        <LogBlock label="After patch: regression test must PASS (GREEN)" good={proof.passed_after} log={proof.after_log} />
      </div>
    )}

    <div className="space-y-1.5">
      <h4 className="font-semibold text-[var(--text-primary)]">Patch · {fix.target_file}</h4>
      <DiffBlock diff={fix.patch} />
    </div>

    <div className="space-y-1.5">
      <h4 className="font-semibold text-[var(--text-primary)]">Regression test written by Builder</h4>
      <pre className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-main)] text-[11px] leading-relaxed overflow-x-auto font-mono text-[var(--text-secondary)]">
        {fix.failing_test}
      </pre>
    </div>

    {fix.security_review && (
      <p className="text-[11px] text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text-secondary)]">Ultra security review:</span> {fix.security_review}
      </p>
    )}
  </div>
);
