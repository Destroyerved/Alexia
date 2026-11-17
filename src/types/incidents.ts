export type IncidentStatus =
  | 'open'
  | 'triaged'
  | 'acting'
  | 'verifying'
  | 'resolved'
  | 'escalated';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';

export type IncidentCategory =
  | 'Security'
  | 'Deployment'
  | 'Availability'
  | 'Performance'
  | 'Integrity';

export interface IncidentStageRecord {
  stage:
    | 'detection'
    | 'triage'
    | 'snapshot'
    | 'diagnosis'
    | 'plan'
    | 'action'
    | 'verification'
    | 'resolution';
  label: string;
  status: 'completed' | 'in_progress' | 'pending' | 'failed' | 'skipped';
  timestamp: string;
  responsible_agent: string;
  explanation: string;
  evidence?: string;
  error?: string;
}

export interface VerificationEvidence {
  test_before: {
    passed: boolean;
    output: string;
    timestamp: string;
  };
  test_after: {
    passed: boolean;
    output: string;
    timestamp: string;
  };
  health_check: {
    status: 'healthy' | 'unhealthy' | 'degraded';
    latency_ms: number;
    http_code: number;
    timestamp: string;
  };
  deployment_status: string;
  snapshot_verified: boolean;
}

export interface Incident {
  id: string;
  title: string;
  summary: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  category: IncidentCategory;
  affected_service: string;
  owner_agent: string; // Builder, Deployer, Healer, Sentinel, Integrity
  events: string[];
  created_at: string;
  updated_at: string;
  approval_required: boolean;
  approval_id?: string;
  diagnosis?: {
    root_cause: string;
    explanation: string;
    evidence: string[];
    uncertainties?: string[];
    sources: Array<{
      title: string;
      url: string;
      domain: string;
      excerpt: string;
      retrieved_at: string;
    }>;
    confidence: number;
  };
  stages: IncidentStageRecord[];
  snapshots: string[];
  cost_usd: number;
  model_calls: string[];
  verification?: VerificationEvidence;
  is_demo?: boolean;
  metadata?: {
    code_fix?: CodeFix;
    proof_of_fix?: { failed_before: boolean; passed_after: boolean; before_log: string; after_log: string };
    [key: string]: unknown;
  };
}

/** What Builder wrote and how the sandbox judged it (alexia/agents/builder.py). */
export interface CodeFix {
  target_file: string;
  root_cause: string;
  explanation: string;
  failing_test: string;
  patch: string;
  proven: boolean;
  summary: string;
  patch_applied: boolean;
  base_note?: string;
  test_runner?: string;
  attempts: Array<{ attempt: number; model_tier: string; summary: string }>;
  security_review?: string;
  pr?: { number: number; html_url: string; mode?: string };
}
