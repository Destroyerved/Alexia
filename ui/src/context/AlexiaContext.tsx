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
import { ActionResult, BlockedIpEntry, DashboardPayload, LLMProviderStatus, apiClient } from '../lib/api';
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
  llmStatus: LLMProviderStatus | null;
  blockedIps: BlockedIpEntry[];
  authSetupRequired: boolean;

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
  lastScenarioIncidentId: string | null;
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
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);

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
  const [llmStatus, setLlmStatus] = useState<LLMProviderStatus | null>(null);
  const [blockedIps, setBlockedIps] = useState<BlockedIpEntry[]>([]);
  const [authSetupRequired, setAuthSetupRequired] = useState<boolean>(false);

  const [autonomyState, setAutonomyState] = useState<'Active' | 'Paused'>('Active');
  const [environment, setEnvironment] = useState<string>('Production Guardian (WAF + Supervisor)');
  const [connectionState, setConnectionState] = useState<ConnectionState>('Connected');
  const [isLiveBackend, setIsLiveBackend] = useState<boolean>(false);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [activeScenarioRun, setActiveScenarioRun] = useState<ScenarioRunState | null>(null);
  const [lastScenarioIncidentId, setLastScenarioIncidentId] = useState<string | null>(null);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);

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
    if (payload.agents?.length) setAgents(payload.agents);
    if (payload.llm) setLlmStatus(payload.llm);
    setBlockedIps(payload.blocked_ips ?? []);
    setAuthSetupRequired(Boolean(payload.auth_setup_required));
    setAutonomyState(payload.is_autonomy_paused ? 'Paused' : 'Active');
    setIsDemoMode(false);
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

  const toggleAutonomy = useCallback(
    async (stepUpCode?: string): Promise<ActionResult> => {
      const pause = autonomyState === 'Active';
      if (!apiClient.isLiveBackend()) {
        setAutonomyState(pause ? 'Paused' : 'Active');
        return { success: true, message: pause ? 'Autonomy paused' : 'Autonomy resumed' };
      }

      let stepUpToken: string | undefined;
      if (!pause) {
        const code =
          stepUpCode ??
          window.prompt('Resuming autonomy requires step-up authentication.\nEnter your 6-digit RFC 6238 authenticator code:') ??
          '';
        if (!code.trim()) return { success: false, message: 'Resume cancelled: 6-digit TOTP code required.' };
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
    [autonomyState, pushNotification, scheduleRefresh]
  );

  const approveAction = useCallback(
    async (approvalId: string, note?: string, stepUpCode?: string): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        if (apiClient.isLiveBackend()) {
          if (!stepUpCode?.trim()) {
            return { success: false, message: 'Enter your 6-digit TOTP code to approve a Tier-1 action.' };
          }
          const su = await apiClient.stepUp(stepUpCode.trim());
          if (!su.token) return { success: false, message: su.error || 'Step-up authentication failed' };
          const result = await apiClient.submitApprovalDecision(
            approvalId,
            'approved',
            note,
            'Operator (web dashboard)',
            su.token
          );
          await refresh();
          return result;
        }
        return { success: false, message: 'Alexia server unreachable.' };
      } finally {
        setPendingActionId(null);
      }
    },
    [refresh]
  );

  const rejectAction = useCallback(
    async (approvalId: string, reason: string): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        const result = await apiClient.submitApprovalDecision(approvalId, 'rejected', reason, 'Operator (web dashboard)');
        if (apiClient.isLiveBackend()) {
          await refresh();
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [refresh]
  );

  const rollbackDeployment = useCallback(
    async (serviceName: string, _targetImage: string, _reason: string, deploymentId?: string): Promise<ActionResult> => {
      if (apiClient.isLiveBackend()) {
        const candidate = deploymentId
          ? deployments.find((d) => d.id === deploymentId)
          : deployments.find((d) => d.service_name === serviceName && d.rollback_available);
        if (!candidate) return { success: false, message: `No rollback-eligible deployment for ${serviceName}` };
        const res = await apiClient.rollbackDeployment(candidate.id);
        await refresh();
        return res;
      }
      return { success: false, message: 'Alexia server unreachable.' };
    },
    [deployments, refresh]
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
    if (!apiClient.isLiveBackend()) return { success: false, message: 'Alexia server unreachable.' };
    const snap = await apiClient.createSnapshot();
    await refresh();
    return snap
      ? { success: true, message: `Snapshot ${snap.id} captured (sha256 ${String((snap as any).sha256 ?? '').slice(0, 12)}…)` }
      : { success: false, message: 'Snapshot failed' };
  }, [refresh]);

  const verifyAuditChain = useCallback(async (): Promise<ActionResult> => {
    if (!apiClient.isLiveBackend()) return { success: false, message: 'Alexia server unreachable.' };
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

      if (runRes.incident_id) {
        setLastScenarioIncidentId(runRes.incident_id);
      }

      const t0 = Date.now();
      const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
      setActiveScenarioRun({
        scenario_id: scenarioId,
        run_id: runId,
        status: 'injecting',
        current_step: runRes.description || 'Fault exercise injected into live runtime',
        progress_percent: 15,
        log_output: [`${stamp()} ${targetScenario.name} triggered (run ${runId})`],
      });

      let finalStep = 'Exercise triggered; follow the live incident timeline.';
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
      if (runRes.incident_id) {
        setSelectedIncidentId(runRes.incident_id);
        setScenarios((prev) =>
          prev.map((s) =>
            s.id === scenarioId
              ? {
                  ...s,
                  last_run: {
                    run_id: runId,
                    timestamp: new Date().toISOString(),
                    status: 'completed',
                    incident_id: runRes.incident_id!,
                  },
                }
              : s
          )
        );
      }
    },
    [scenarios, refresh]
  );

  const resetEnvironment = useCallback(async () => {
    await apiClient.resetEnvironment();
    setActiveScenarioRun(null);
    if (apiClient.isLiveBackend()) {
      await refresh();
    }
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
        llmStatus,
        blockedIps,
        authSetupRequired,
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
        lastScenarioIncidentId,
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
