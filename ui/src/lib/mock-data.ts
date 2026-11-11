import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { AgentInfo, OrchestratorInfo } from '../types/agents';
import { ServiceItem, DeploymentRecord } from '../types/services';
import { ModelCallRecord, ModelUsageSummary } from '../types/model-calls';
import { AuditRecord, SnapshotRecord } from '../types/audit';
import { ScenarioDefinition } from '../types/scenarios';
import { SecurityReport } from '../types/reports';

export const INITIAL_AGENTS: AgentInfo[] = [
  {
    id: 'sentinel',
    name: 'Sentinel',
    role_description: 'WAF IP containment, SHA-256 evidence ledger & CERT-In/DPDP/GDPR reports',
    state: 'Idle',
    current_task: 'Standing by',
    latest_event: 'Monitoring live WAF gateway & auth streams',
    latest_event_time: new Date().toISOString(),
    total_actions_today: 0,
  },
  {
    id: 'healer',
    name: 'Healer',
    role_description: 'Live process/container triage, recovery & HTTP health verification',
    state: 'Idle',
    current_task: 'Standing by',
    latest_event: 'Monitoring target service health probes',
    latest_event_time: new Date().toISOString(),
    total_actions_today: 0,
  },
  {
    id: 'builder',
    name: 'Builder',
    role_description: 'Multi-file discovery, isolated sandbox Red->Green patching & Git PRs',
    state: 'Idle',
    current_task: 'Standing by',
    latest_event: 'Ready for isolated sandbox verification',
    latest_event_time: new Date().toISOString(),
    total_actions_today: 0,
  },
  {
    id: 'deployer',
    name: 'Deployer',
    role_description: 'Tri-gate deploy checks, release archiving & instant tarball/Docker rollback',
    state: 'Idle',
    current_task: 'Standing by',
    latest_event: 'Pre-deploy & health gates armed',
    latest_event_time: new Date().toISOString(),
    total_actions_today: 0,
  },
  {
    id: 'integrity',
    name: 'Integrity',
    role_description: 'Online SQLite/Postgres backups, read-only exposure audits & throwaway migration dry-runs',
    state: 'Idle',
    current_task: 'Standing by',
    latest_event: 'Audit SHA-256 hash chain verified',
    latest_event_time: new Date().toISOString(),
    total_actions_today: 0,
  },
];

export const INITIAL_ORCHESTRATOR: OrchestratorInfo = {
  name: 'Orchestrator',
  role_description: 'Autonomous central coordinator routing events, policy gates, and agent sequencing',
  state: 'Idle',
  active_workflow: 'Continuous supervision across registered target services',
  coordinating_agents: ['Sentinel', 'Healer', 'Builder', 'Deployer', 'Integrity'],
};

// Clean production boot state — zero pre-seeded demo incidents, approvals, or fake spend
export const INITIAL_INCIDENTS: Incident[] = [];
export const INITIAL_APPROVALS: ApprovalRequest[] = [];
export const INITIAL_SERVICES: ServiceItem[] = [];
export const INITIAL_DEPLOYMENTS: DeploymentRecord[] = [];
export const INITIAL_MODEL_CALLS: ModelCallRecord[] = [];

export const INITIAL_MODEL_SUMMARY: ModelUsageSummary = {
  total_spend_usd: 0,
  daily_budget_usd: 5.0,
  remaining_budget_usd: 5.0,
  total_calls: 0,
  failed_calls: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
  avg_latency_ms: 0,
  total_tavily_calls: 0,
  tier_breakdown: {
    nano: { calls: 0, cost_usd: 0 },
    super: { calls: 0, cost_usd: 0 },
    ultra: { calls: 0, cost_usd: 0 },
  },
};

export const INITIAL_AUDIT_LOGS: AuditRecord[] = [];
export const INITIAL_SNAPSHOTS: SnapshotRecord[] = [];
export const INITIAL_SECURITY_REPORTS: SecurityReport[] = [];

export const SCENARIO_CATALOG: ScenarioDefinition[] = [
  {
    id: 'S6',
    name: 'SQL Injection & Customer PII Data Exposure',
    category: 'Security',
    is_mandatory_demo: true,
    demonstrates:
      'Live WAF SQLi detection on /search, instant 403 IP block, online SQLite backup, read-only DB row exposure audit, isolated sandbox Red->Green parameterization patch, Git branch/PR, and CERT-In/DPDP/GDPR draft reports.',
    agents_involved: ['Sentinel', 'Integrity', 'Healer', 'Builder', 'Deployer'],
    expected_outcome:
      'Attacker IP banned at WAF gateway, evidence SHA-256 sealed, DB exposure quantified, patch proven Red->Green if LLM is live, and breach drafts persisted.',
    simulated_payload_info: "GET /search?q=' UNION SELECT id, email, phone FROM users -- from 198.51.100.88",
    estimated_duration_seconds: 15,
  },
  {
    id: 'S1',
    name: 'Bad Deployment & Automatic Rollback',
    category: 'Deployment',
    is_mandatory_demo: true,
    demonstrates:
      'Pre-deploy diff gate warning, post-deploy HTTP 500 health gate failure, automatic release rollback to last known-good build, and sandbox regression fix.',
    agents_involved: ['Deployer', 'Healer', 'Builder', 'Integrity'],
    expected_outcome:
      'Defective release rolled back automatically via RuntimeSupervisor, service health restored, and rollback sealed in SHA-256 audit ledger.',
    simulated_payload_info: 'Deploy commit introducing unguarded ZeroDivisionError on /checkout.',
    estimated_duration_seconds: 12,
  },
  {
    id: 'S2',
    name: 'Process / Container Crash & Self-Healing',
    category: 'Availability',
    is_mandatory_demo: true,
    demonstrates:
      'Real process/container exit detection, online DB snapshot, RuntimeSupervisor restart, live HTTP /health verification, and RunbookMemory persistence.',
    agents_involved: ['Healer', 'Integrity'],
    expected_outcome:
      'Managed service restarted and verified healthy via live HTTP probe; verified runbook saved for sub-second future triage.',
    simulated_payload_info: 'Unexpected process/container exit (code 137) on supervised target service.',
    estimated_duration_seconds: 10,
  },
  {
    id: 'S4',
    name: 'Leaked Live Secret in Git Push',
    category: 'Security',
    is_mandatory_demo: true,
    demonstrates:
      'Pre-deploy secret scanner catches live Stripe/API key in commit diff, blocks deployment immediately, redacts raw key from storage, and queues Tier-1 secret rotation.',
    agents_involved: ['Deployer', 'Sentinel'],
    expected_outcome:
      'Deployment blocked before exposure, raw credential redacted across SQLite/SSE/LLM logs, and Tier-1 rotate_secret queued for TOTP approval.',
    simulated_payload_info: 'Git push diff containing live credential pattern sk_live_... in config.',
    estimated_duration_seconds: 8,
  },
  {
    id: 'S3_DISK',
    name: 'Disk Pressure & Safe Log Rotation',
    category: 'Availability',
    is_mandatory_demo: false,
    demonstrates:
      'Disk utilization threshold alert, precautionary online DB snapshot, and safe temporary/log file rotation.',
    agents_involved: ['Healer', 'Integrity'],
    expected_outcome: 'Temporary log files truncated/rotated cleanly without touching application data.',
    simulated_payload_info: 'Log volume saturation threshold alert (>95% utilization).',
    estimated_duration_seconds: 8,
  },
  {
    id: 'S5_BRUTE',
    name: 'Brute-Force Authentication Flood',
    category: 'Security',
    is_mandatory_demo: false,
    demonstrates:
      'Sliding-window 401 burst detection in AuthLogCollector and instant FirewallManager IP ban enforced by the WAF gateway.',
    agents_involved: ['Sentinel'],
    expected_outcome: 'Offending IP 203.0.113.195 blocked with HTTP 403 at WAF gateway.',
    simulated_payload_info: 'High-rate HTTP 401 login failures against /login from 203.0.113.195.',
    estimated_duration_seconds: 6,
  },
];
