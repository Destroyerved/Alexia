import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { AgentInfo, OrchestratorInfo } from '../types/agents';
import { ServiceItem, DeploymentRecord } from '../types/services';
import { ModelCallRecord, ModelUsageSummary } from '../types/model-calls';
import { AuditRecord, SnapshotRecord } from '../types/audit';
import { ScenarioDefinition, ScenarioId, ScenarioRunState } from '../types/scenarios';
import { SecurityReport } from '../types/reports';
import { ConnectionState, AlexiaEventStream, StreamEvent } from '../lib/event-stream';
import { ActionResult, DashboardPayload, apiClient } from '../lib/api';
import { toDeploymentRecord, toScenarioDefinition, toSecurityReport, toSnapshotRecord } from '../lib/adapters';
import {
  INITIAL_AGENTS,
  INITIAL_ORCHESTRATOR,
  INITIAL_INCIDENTS,
  INITIAL_APPROVALS,
  INITIAL_SERVICES,
  INITIAL_DEPLOYMENTS,
  INITIAL_MODEL_CALLS,
  INITIAL_MODEL_SUMMARY,
  INITIAL_AUDIT_LOGS,
  INITIAL_SNAPSHOTS,
  SCENARIO_CATALOG,
  INITIAL_SECURITY_REPORTS,
} from '../lib/mock-data';

export interface AppNotification {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'info';
  timestamp: string;
  read: boolean;
  link_to?: string;
}

export interface AuditChainStatus {
  verified: boolean;
  rows: number;
}

interface AlexiaContextType {
  // Navigation / View
  currentView: string;
  setCurrentView: (view: string) => void;
  selectedIncidentId: string | null;
  setSelectedIncidentId: (id: string | null) => void;

  // Domain state
  incidents: Incident[];
  approvals: ApprovalRequest[];
  agents: AgentInfo[];
  orchestrator: OrchestratorInfo;
  services: ServiceItem[];
  deployments: DeploymentRecord[];
  modelCalls: ModelCallRecord[];
  modelSummary: ModelUsageSummary;
  auditLogs: AuditRecord[];
  auditChain: AuditChainStatus | null;
  snapshots: SnapshotRecord[];
  scenarios: ScenarioDefinition[];
  securityReports: SecurityReport[];
  notifications: AppNotification[];

  // Global safety & environment
  autonomyState: 'Active' | 'Paused';
  /** Pause, or resume with a step-up TOTP code (prompted for when omitted). */
  toggleAutonomy: (stepUpCode?: string) => Promise<ActionResult>;
  environment: string;
  setEnvironment: (env: string) => void;
  connectionState: ConnectionState;
  isDemoMode: boolean;
  isLiveBackend: boolean;
  lastUpdated: string;

  // Actions & Operations
  pendingActionId: string | null;
  approveAction: (approvalId: string, note?: string, stepUpCode?: string) => Promise<ActionResult>;
  rejectAction: (approvalId: string, reason: string) => Promise<ActionResult>;
  activeScenarioRun: ScenarioRunState | null;
  runScenario: (scenarioId: ScenarioId) => Promise<void>;
  resetEnvironment: () => Promise<void>;
  rollbackDeployment: (serviceName: string, targetImage: string, reason: string, deploymentId?: string) => Promise<ActionResult>;
  restartService: (serviceId: string) => Promise<ActionResult>;
  takeSnapshot: () => Promise<ActionResult>;
  verifyAuditChain: () => Promise<ActionResult>;
  refresh: () => Promise<void>;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
}

const AlexiaContext = createContext<AlexiaContextType | undefined>(undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Push-notification deep links (/m/approvals/<id>, /m/incident/<id>) -> dashboard view ids. */
function viewForDeepLink(link?: string): string | undefined {
  if (!link) return undefined;
  if (link.includes('/approvals')) return 'approvals';
  if (link.includes('/incident')) return 'incidents';
  return undefined;
}

export const AlexiaProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentView, setCurrentView] = useState<string>('overview');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>('DEMO-INC-2026-0841');

  const [incidents, setIncidents] = useState<Incident[]>(INITIAL_INCIDENTS);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>(INITIAL_APPROVALS);
  const [agents, setAgents] = useState<AgentInfo[]>(INITIAL_AGENTS);
  const [orchestrator] = useState<OrchestratorInfo>(INITIAL_ORCHESTRATOR);
  const [services, setServices] = useState<ServiceItem[]>(INITIAL_SERVICES);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>(INITIAL_DEPLOYMENTS);
  const [modelCalls, setModelCalls] = useState<ModelCallRecord[]>(INITIAL_MODEL_CALLS);
  const [modelSummary, setModelSummary] = useState<ModelUsageSummary>(INITIAL_MODEL_SUMMARY);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>(INITIAL_AUDIT_LOGS);
  const [auditChain, setAuditChain] = useState<AuditChainStatus | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>(INITIAL_SNAPSHOTS);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>(SCENARIO_CATALOG);
  const [securityReports, setSecurityReports] = useState<SecurityReport[]>(INITIAL_SECURITY_REPORTS);

  const [autonomyState, setAutonomyState] = useState<'Active' | 'Paused'>('Active');
  const [environment, setEnvironment] = useState<string>('Sandbox (ShopLite Docker)');
  const [connectionState, setConnectionState] = useState<ConnectionState>('Connected');
  const [isLiveBackend, setIsLiveBackend] = useState<boolean>(false);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [activeScenarioRun, setActiveScenarioRun] = useState<ScenarioRunState | null>(null);

  const [notifications, setNotifications] = useState<AppNotification[]>([
    {
      id: 'notif-1',
      title: 'Tier 1 Approval Required',
      description: 'Deployer requested permission to roll back canary shoplite-api v2.4.2.',
      severity: 'high',
      timestamp: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
      read: false,
      link_to: 'approvals',
    },
    {
      id: 'notif-2',
      title: 'SQL Injection Resolved',
      description: 'DEMO-INC-2026-0841 successfully verified and mitigated by Sentinel.',
      severity: 'critical',
      timestamp: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
      read: false,
      link_to: 'incidents',
    },
  ]);

  const pushNotification = useCallback((n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => {
    setNotifications((prev) =>
      [{ ...n, id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: new Date().toISOString(), read: false }, ...prev].slice(0, 50)
    );
  }, []);

  // Periodic heartbeat / timestamp update
  useEffect(() => {
    const timer = setInterval(() => {
      setLastUpdated(new Date().toISOString());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Live backend is the single source of truth: replace every list, even when it is empty
  const applyDashboard = useCallback((payload: DashboardPayload) => {
    const liveIncidents = payload.incidents ?? [];
    setIncidents(liveIncidents);
    setSelectedIncidentId((prev) =>
      prev && liveIncidents.some((i) => i.id === prev) ? prev : liveIncidents[0]?.id ?? null
    );
    setApprovals(payload.approvals ?? []);
    setServices((payload.services ?? []) as unknown as ServiceItem[]);
    setDeployments((payload.deployments ?? []).map(toDeploymentRecord));
    setSnapshots((payload.snapshots ?? []).map(toSnapshotRecord));
    setSecurityReports((payload.reports ?? []).map(toSecurityReport));
    setModelCalls(payload.model_calls ?? []);
    if (payload.model_summary) setModelSummary(payload.model_summary);
    setAuditLogs(payload.audit?.entries ?? []);
    setAuditChain({ verified: Boolean(payload.audit?.chain_verified), rows: payload.audit?.verified_rows ?? 0 });
    setAutonomyState(payload.is_autonomy_paused ? 'Paused' : 'Active');
    setIsDemoMode(Boolean(payload.settings?.demo_mode ?? true));
    setLastUpdated(new Date().toISOString());
  }, []);

  const refresh = useCallback(async () => {
    const payload = await apiClient.fetchDashboard();
    if (payload) applyDashboard(payload);
  }, [applyDashboard]);

  // Coalesce bursts of SSE frames into one dashboard re-fetch
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 400);
  }, [refresh]);

  // Hydrate from live backend when available and subscribe to SSE stream
  useEffect(() => {
    let mounted = true;
    let stream: AlexiaEventStream | null = null;

    const handleEvent = (event: StreamEvent) => {
      setLastUpdated(new Date().toISOString());
      const evtType = event.type || event.event;
      if ((evtType === 'incident_created' || evtType === 'incident_updated') && event.data) {
        const inc = event.data as Incident;
        setIncidents((prev) => {
          const exists = prev.some((i) => i.id === inc.id);
          return exists ? prev.map((i) => (i.id === inc.id ? inc : i)) : [inc, ...prev];
        });
        scheduleRefresh();
      } else if (evtType === 'notification' && event.data) {
        const n = event.data;
        pushNotification({
          title: n.title,
          description: n.body,
          severity: n.severity === 'critical' ? 'critical' : n.severity === 'high' ? 'high' : 'info',
          link_to: viewForDeepLink(n.deep_link),
        });
      } else if (
        evtType === 'approval_decided' ||
        evtType === 'deployment_rolled_back' ||
        evtType === 'service_restarted'
      ) {
        scheduleRefresh();
      }
    };

    apiClient
      .fetchDashboard()
      .then((payload) => {
        if (!mounted) return;
        if (!payload) {
          // Static/offline hosting: keep the bundled demo data and say so
          setConnectionState('Offline');
          return;
        }
        setIsLiveBackend(true);
        applyDashboard(payload);
        void apiClient.getScenarios().then((catalog) => {
          if (mounted && catalog?.length) setScenarios(catalog.map(toScenarioDefinition));
        });
        stream = new AlexiaEventStream(apiClient.getEventStreamUrl());
        stream.connect(handleEvent, (state) => setConnectionState(state));
      })
      .catch(() => {
        if (mounted) setConnectionState('Offline');
      });

    return () => {
      mounted = false;
      stream?.disconnect();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [applyDashboard, pushNotification, scheduleRefresh]);

  // Demo-mode only: local audit rows so the offline walkthrough still shows the ledger moving
  const appendDemoAudit = useCallback(
    (entry: Omit<AuditRecord, 'id' | 'timestamp' | 'previous_hash' | 'verification_status'>) => {
      setAuditLogs((logs) => [
        {
          ...entry,
          id: `AUD-${(logs.length + 1483).toString().padStart(6, '0')}`,
          timestamp: new Date().toISOString(),
          previous_hash: logs[0]?.current_hash || '00000000',
          verification_status: 'Verified',
        },
        ...logs,
      ]);
    },
    []
  );

  const toggleAutonomy = useCallback(
    async (stepUpCode?: string): Promise<ActionResult> => {
      const pause = autonomyState === 'Active';
      if (!apiClient.isLiveBackend()) {
        setAutonomyState(pause ? 'Paused' : 'Active');
        appendDemoAudit({
          actor: 'human_operator (demo@alexia.local)',
          event: pause ? 'AUTONOMY_PAUSED' : 'AUTONOMY_RESUMED',
          action: pause ? 'PauseAutonomousActions' : 'ResumeAutonomousActions',
          target: 'GlobalGuardianEngine',
          outcome: 'SUCCESS',
          current_hash: 'f9410ea821bb40219410ea821bb40219410ea821bb40219410ea821bb40219',
          signature: 'ed25519:safety_lock_sig...',
        });
        return { success: true, message: pause ? 'Autonomy paused (demo mode)' : 'Autonomy resumed (demo mode)' };
      }

      let stepUpToken: string | undefined;
      if (!pause) {
        // Resuming is the risky direction: step-up within the last 5 minutes (FR-M6)
        const code =
          stepUpCode ??
          window.prompt('Resuming autonomy needs step-up authentication.\nEnter your 6-digit authenticator code (demo: 123456):') ??
          '';
        if (!code.trim()) return { success: false, message: 'Resume cancelled: step-up code required.' };
        const su = await apiClient.stepUp(code.trim());
        if (!su.token) {
          pushNotification({ title: 'Step-up failed', description: su.error || 'Invalid code', severity: 'high' });
          return { success: false, message: su.error || 'Step-up failed' };
        }
        stepUpToken = su.token;
      }

      const res = await apiClient.toggleAutonomy(pause, 'Operator (web dashboard)', stepUpToken);
      if (res.success) {
        setAutonomyState(res.is_paused ? 'Paused' : 'Active');
      } else {
        pushNotification({ title: 'Autonomy change refused', description: res.message, severity: 'high' });
      }
      scheduleRefresh();
      return res;
    },
    [autonomyState, appendDemoAudit, pushNotification, scheduleRefresh]
  );

  const approveAction = useCallback(
    async (approvalId: string, note?: string, stepUpCode?: string): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        if (apiClient.isLiveBackend()) {
          if (!stepUpCode?.trim()) {
            return { success: false, message: 'Enter your step-up code (passkey/TOTP) to approve a Tier-1 action.' };
          }
          const su = await apiClient.stepUp(stepUpCode.trim());
          if (!su.token) return { success: false, message: su.error || 'Step-up authentication failed' };
          const result = await apiClient.submitApprovalDecision(
            approvalId, 'approved', note, 'Operator (web dashboard)', su.token
          );
          await refresh();
          return result;
        }

        const result = await apiClient.submitApprovalDecision(approvalId, 'approved', note);
        if (result.success) {
          setApprovals((prev) =>
            prev.map((app) =>
              app.id === approvalId
                ? { ...app, status: 'approved', decided_by: 'human_operator (demo@alexia.local)', decided_at: new Date().toISOString() }
                : app
            )
          );
          const targetApproval = approvals.find((a) => a.id === approvalId);
          if (targetApproval) {
            setIncidents((prev) =>
              prev.map((inc) =>
                inc.id === targetApproval.incident_id
                  ? {
                      ...inc,
                      status: 'acting',
                      approval_required: false,
                      stages: inc.stages.map((s) =>
                        s.stage === 'action'
                          ? { ...s, status: 'completed', explanation: `Action approved and executed: ${targetApproval.action_name}` }
                          : s.stage === 'verification'
                          ? { ...s, status: 'in_progress', explanation: 'Deployer verifying container health probes...' }
                          : s
                      ),
                    }
                  : inc
              )
            );
            appendDemoAudit({
              actor: 'human_operator (demo@alexia.local)',
              event: 'APPROVAL_GRANTED',
              action: targetApproval.action_name,
              target: targetApproval.affected_service,
              outcome: 'SUCCESS',
              incident_id: targetApproval.incident_id,
              current_hash: '9a81b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb9c1',
              signature: 'ed25519:operator_approval_sig',
            });
          }
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [approvals, appendDemoAudit, refresh]
  );

  const rejectAction = useCallback(
    async (approvalId: string, reason: string): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        const result = await apiClient.submitApprovalDecision(approvalId, 'rejected', reason, 'Operator (web dashboard)');
        if (apiClient.isLiveBackend()) {
          await refresh();
          return result;
        }
        if (result.success) {
          setApprovals((prev) =>
            prev.map((app) =>
              app.id === approvalId
                ? {
                    ...app,
                    status: 'rejected',
                    rejection_reason: reason,
                    decided_by: 'human_operator (demo@alexia.local)',
                    decided_at: new Date().toISOString(),
                  }
                : app
            )
          );
          const targetApproval = approvals.find((a) => a.id === approvalId);
          if (targetApproval) {
            setIncidents((prev) =>
              prev.map((inc) =>
                inc.id === targetApproval.incident_id
                  ? {
                      ...inc,
                      status: 'escalated',
                      stages: inc.stages.map((s) =>
                        s.stage === 'action' ? { ...s, status: 'failed', explanation: `Action rejected by operator: ${reason}` } : s
                      ),
                    }
                  : inc
              )
            );
            appendDemoAudit({
              actor: 'human_operator (demo@alexia.local)',
              event: 'APPROVAL_REJECTED',
              action: targetApproval.action_name,
              target: targetApproval.affected_service,
              outcome: 'DENIED',
              incident_id: targetApproval.incident_id,
              current_hash: '7781b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb9c9',
              signature: 'ed25519:operator_rejection_sig',
            });
          }
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [approvals, appendDemoAudit, refresh]
  );

  const rollbackDeployment = useCallback(
    async (serviceName: string, targetImage: string, reason: string, deploymentId?: string): Promise<ActionResult> => {
      if (apiClient.isLiveBackend()) {
        const candidate = deploymentId
          ? deployments.find((d) => d.id === deploymentId)
          : deployments.find((d) => d.service_name === serviceName && d.rollback_available);
        if (!candidate) return { success: false, message: `No rollback-eligible deployment for ${serviceName}` };
        const res = await apiClient.rollbackDeployment(candidate.id);
        await refresh();
        return res;
      }

      setServices((prev) =>
        prev.map((s) => (s.name === serviceName ? { ...s, image: targetImage, status: 'healthy', uptime_seconds: 60 } : s))
      );
      const now = new Date().toISOString();
      const newDep: DeploymentRecord = {
        id: `DEP-${Date.now().toString().slice(-6)}`,
        service_name: serviceName,
        image_tag: targetImage,
        previous_known_good_image: targetImage,
        trigger: 'rollback',
        status: 'Successful',
        started_at: now,
        completed_at: now,
        pre_deploy_gates: [{ name: 'Target Image Verification', passed: true, details: `Validated ${targetImage} in local cache`, timestamp: now }],
        health_gates: [{ name: 'Healthz Endpoint', passed: true, details: 'HTTP 200 OK received in 3.4ms', timestamp: now }],
        rollback_info: { is_rollback: true, target_image: targetImage, reason, executed_at: now },
      };
      setDeployments((prev) => [newDep, ...prev]);
      appendDemoAudit({
        actor: 'Deployer',
        event: 'SERVICE_ROLLED_BACK',
        action: `Rollback to ${targetImage}`,
        target: serviceName,
        outcome: 'ROLLED_BACK',
        current_hash: '2281b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb999',
        signature: 'ed25519:rollback_sig',
      });
      return { success: true, message: `Rolled back ${serviceName} to ${targetImage} (demo mode)` };
    },
    [deployments, appendDemoAudit, refresh]
  );

  const restartService = useCallback(
    async (serviceId: string): Promise<ActionResult> => {
      const res = await apiClient.restartService(serviceId);
      if (apiClient.isLiveBackend()) await refresh();
      return res;
    },
    [refresh]
  );

  const takeSnapshot = useCallback(async (): Promise<ActionResult> => {
    if (!apiClient.isLiveBackend()) return { success: true, message: 'Snapshot simulated (demo mode)' };
    const snap = await apiClient.createSnapshot();
    await refresh();
    return snap
      ? { success: true, message: `Snapshot ${snap.id} captured (sha256 ${String((snap as any).sha256 ?? '').slice(0, 12)}…)` }
      : { success: false, message: 'Snapshot failed' };
  }, [refresh]);

  const verifyAuditChain = useCallback(async (): Promise<ActionResult> => {
    if (!apiClient.isLiveBackend()) return { success: true, message: 'Audit chain verified (demo data)' };
    const res = await apiClient.verifyAuditChain();
    if (!res) return { success: false, message: 'Audit verification unavailable' };
    setAuditChain({ verified: res.valid, rows: res.records_checked });
    return res.valid
      ? { success: true, message: `Audit chain verified: ${res.records_checked} SHA-256 linked blocks intact` }
      : { success: false, message: 'Audit chain verification FAILED: tampering detected' };
  }, []);

  const runScenario = useCallback(
    async (scenarioId: ScenarioId) => {
      const targetScenario = scenarios.find((s) => s.id === scenarioId);
      if (!targetScenario) return;

      const runRes = await apiClient.runScenario(scenarioId);
      const runId = runRes.run_id || `RUN-${scenarioId}-${Date.now().toString().slice(-4)}`;

      if (apiClient.isLiveBackend()) {
        if (runRes.error) {
          setActiveScenarioRun({
            scenario_id: scenarioId,
            run_id: runId,
            status: 'failed',
            current_step: runRes.error,
            progress_percent: 100,
            log_output: [`[0.0s] ${targetScenario.name} failed to start: ${runRes.error}`],
          });
          return;
        }
        const t0 = Date.now();
        const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
        setActiveScenarioRun({
          scenario_id: scenarioId,
          run_id: runId,
          status: 'injecting',
          current_step: runRes.description || 'Scenario triggered on the live backend',
          progress_percent: 15,
          log_output: [`${stamp()} ${targetScenario.name} triggered (run ${runId})`],
        });

        // Follow the real incident the agents opened until it resolves or waits on a human
        let finalStep = 'Scenario triggered; follow the live incident timeline.';
        let lastKey = '';
        for (let i = 0; runRes.incident_id && i < 40; i++) {
          await sleep(750);
          const inc = await apiClient.getIncident(runRes.incident_id);
          if (!inc) continue;
          const key = `${inc.status}|${inc.title}|${inc.approval_required}`;
          const waitingOnHuman = inc.approval_required && inc.status !== 'resolved';
          const done = inc.status === 'resolved' || inc.status === 'escalated' || waitingOnHuman;
          const status: ScenarioRunState['status'] = done
            ? 'completed'
            : inc.status === 'open' || inc.status === 'triaged'
            ? 'detecting'
            : 'remediating';
          if (key !== lastKey) {
            lastKey = key;
            const line = `${stamp()} ${inc.owner_agent} · ${inc.status.toUpperCase()} · ${inc.title}`;
            setActiveScenarioRun((prev) =>
              prev
                ? {
                    ...prev,
                    status: done ? prev.status : status,
                    current_step: inc.summary || inc.title,
                    progress_percent: done ? prev.progress_percent : status === 'detecting' ? 45 : 75,
                    log_output: [...prev.log_output, line],
                  }
                : prev
            );
          }
          if (done) {
            finalStep = waitingOnHuman
              ? 'Agents finished; a Tier-1 action is waiting for your approval in Approvals.'
              : `Incident ${inc.status}: ${inc.title}`;
            break;
          }
        }
        setActiveScenarioRun((prev) =>
          prev
            ? {
                ...prev,
                status: 'completed',
                current_step: finalStep,
                progress_percent: 100,
                log_output: [...prev.log_output, `${stamp()} ${finalStep}`],
              }
            : prev
        );
        await refresh();
        if (runRes.incident_id) setSelectedIncidentId(runRes.incident_id);
      } else {
        setActiveScenarioRun({
          scenario_id: scenarioId,
          run_id: runId,
          status: 'starting',
          current_step: 'Initializing isolated sandbox environment...',
          progress_percent: 5,
          log_output: [`[0.0s] Initializing scenario ${scenarioId}: ${targetScenario.name}`],
        });

        // Offline walkthrough steps (no backend to observe)
        const steps = [
          { progress: 20, status: 'injecting' as const, step: 'Injecting synthetic fault into ShopLite container network...', log: `[1.2s] Injected payload: ${targetScenario.simulated_payload_info}` },
          { progress: 45, status: 'detecting' as const, step: 'Sentinel anomaly monitor triggered: Alert dispatched to Orchestrator', log: '[3.4s] Sentinel captured anomalous metric & logged telemetry event' },
          { progress: 65, status: 'remediating' as const, step: 'Integrity created state snapshot. Healer synthesizing remediation patch...', log: '[6.1s] Snapshot created; Healer querying Tavily & formulating fix plan' },
          { progress: 85, status: 'remediating' as const, step: 'Builder compiled regression tests; Deployer staging isolated canary...', log: '[9.5s] AST regression tests passing (100%); Gate validated' },
          { progress: 100, status: 'completed' as const, step: 'Scenario successfully executed! Incident verified and resolved.', log: `[12.0s] Scenario ${scenarioId} completed successfully. Audit record sealed.` },
        ];
        for (const s of steps) {
          await sleep(1400);
          setActiveScenarioRun((prev) =>
            prev ? { ...prev, status: s.status, current_step: s.step, progress_percent: s.progress, log_output: [...prev.log_output, s.log] } : null
          );
        }
      }

      setScenarios((prev) =>
        prev.map((s) =>
          s.id === scenarioId
            ? {
                ...s,
                last_run: {
                  run_id: runId,
                  timestamp: new Date().toISOString(),
                  status: 'completed',
                  incident_id: runRes.incident_id || (scenarioId === 'S6' ? 'DEMO-INC-2026-0841' : 'DEMO-INC-2026-0842'),
                },
              }
            : s
        )
      );
    },
    [scenarios, refresh]
  );

  const resetEnvironment = useCallback(async () => {
    await apiClient.resetEnvironment();
    setActiveScenarioRun(null);
    if (apiClient.isLiveBackend()) {
      await refresh();
      return;
    }
    setIncidents(INITIAL_INCIDENTS);
    setApprovals(INITIAL_APPROVALS);
    setServices(INITIAL_SERVICES);
    setDeployments(INITIAL_DEPLOYMENTS);
    setAgents(INITIAL_AGENTS);
  }, [refresh]);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  return (
    <AlexiaContext.Provider
      value={{
        currentView,
        setCurrentView,
        selectedIncidentId,
        setSelectedIncidentId,
        incidents,
        approvals,
        agents,
        orchestrator,
        services,
        deployments,
        modelCalls,
        modelSummary,
        auditLogs,
        auditChain,
        snapshots,
        scenarios,
        securityReports,
        notifications,
        autonomyState,
        toggleAutonomy,
        environment,
        setEnvironment,
        connectionState,
        isDemoMode,
        isLiveBackend,
        lastUpdated,
        pendingActionId,
        approveAction,
        rejectAction,
        activeScenarioRun,
        runScenario,
        resetEnvironment,
        rollbackDeployment,
        restartService,
        takeSnapshot,
        verifyAuditChain,
        refresh,
        markNotificationRead,
        clearNotifications,
      }}
    >
      {children}
    </AlexiaContext.Provider>
  );
};

export const useAlexia = () => {
  const context = useContext(AlexiaContext);
  if (!context) {
    throw new Error('useAlexia must be used within an AlexiaProvider');
  }
  return context;
};
