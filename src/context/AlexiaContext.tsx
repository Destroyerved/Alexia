import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { AgentInfo, OrchestratorInfo } from '../types/agents';
import { ServiceItem, DeploymentRecord } from '../types/services';
import { ModelCallRecord, ModelUsageSummary } from '../types/model-calls';
import { AuditRecord, SnapshotRecord } from '../types/audit';
import { ScenarioDefinition, ScenarioId, ScenarioRunState } from '../types/scenarios';
import { SecurityReport } from '../types/reports';
import { ConnectionState, AlexiaEventStream } from '../lib/event-stream';
import { apiClient } from '../lib/api';
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
  snapshots: SnapshotRecord[];
  scenarios: ScenarioDefinition[];
  securityReports: SecurityReport[];
  notifications: AppNotification[];

  // Global safety & environment
  autonomyState: 'Active' | 'Paused';
  toggleAutonomy: () => void;
  environment: string;
  setEnvironment: (env: string) => void;
  connectionState: ConnectionState;
  isDemoMode: boolean;
  lastUpdated: string;

  // Actions & Operations
  pendingActionId: string | null;
  approveAction: (approvalId: string, note?: string) => Promise<{ success: boolean; message: string }>;
  rejectAction: (approvalId: string, reason: string) => Promise<{ success: boolean; message: string }>;
  activeScenarioRun: ScenarioRunState | null;
  runScenario: (scenarioId: ScenarioId) => Promise<void>;
  resetEnvironment: () => Promise<void>;
  rollbackDeployment: (serviceName: string, targetImage: string, reason: string) => Promise<boolean>;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
}

const AlexiaContext = createContext<AlexiaContextType | undefined>(undefined);

export const AlexiaProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentView, setCurrentView] = useState<string>('overview');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>('DEMO-INC-2026-0841');

  const [incidents, setIncidents] = useState<Incident[]>(INITIAL_INCIDENTS);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>(INITIAL_APPROVALS);
  const [agents, setAgents] = useState<AgentInfo[]>(INITIAL_AGENTS);
  const [orchestrator, setOrchestrator] = useState<OrchestratorInfo>(INITIAL_ORCHESTRATOR);
  const [services, setServices] = useState<ServiceItem[]>(INITIAL_SERVICES);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>(INITIAL_DEPLOYMENTS);
  const [modelCalls, setModelCalls] = useState<ModelCallRecord[]>(INITIAL_MODEL_CALLS);
  const [modelSummary, setModelSummary] = useState<ModelUsageSummary>(INITIAL_MODEL_SUMMARY);
  const [auditLogs, setAuditLogs] = useState<AuditRecord[]>(INITIAL_AUDIT_LOGS);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>(INITIAL_SNAPSHOTS);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>(SCENARIO_CATALOG);
  const [securityReports, setSecurityReports] = useState<SecurityReport[]>(INITIAL_SECURITY_REPORTS);

  const [autonomyState, setAutonomyState] = useState<'Active' | 'Paused'>('Active');
  const [environment, setEnvironment] = useState<string>('Sandbox (ShopLite Docker)');
  const [connectionState, setConnectionState] = useState<ConnectionState>('Connected');
  const [isDemoMode] = useState<boolean>(true);
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

  // Periodic heartbeat / timestamp update
  useEffect(() => {
    const timer = setInterval(() => {
      setLastUpdated(new Date().toISOString());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Hydrate from live backend when available and subscribe to SSE stream
  useEffect(() => {
    let mounted = true;
    apiClient.fetchDashboard().then((payload) => {
      if (!mounted || !payload) return;
      if (payload.incidents && payload.incidents.length > 0) {
        setIncidents(payload.incidents);
        setSelectedIncidentId((prev) => prev || payload.incidents[0].id);
      }
      if (payload.approvals && payload.approvals.length > 0) {
        setApprovals(payload.approvals);
      }
      if (payload.services && payload.services.length > 0) {
        setServices(payload.services as unknown as ServiceItem[]);
      }
      if (payload.model_calls && payload.model_calls.length > 0) {
        setModelCalls(payload.model_calls);
      }
      if (payload.model_summary && payload.model_summary.total_calls > 0) {
        setModelSummary(payload.model_summary);
      }
      if (payload.audit && payload.audit.entries && payload.audit.entries.length > 0) {
        setAuditLogs(payload.audit.entries);
      }
      setAutonomyState(payload.is_autonomy_paused ? 'Paused' : 'Active');
    }).catch(() => {
      // Fallback to initial demo state
    });

    const stream = new AlexiaEventStream('/stream');
    stream.connect(
      (event) => {
        setLastUpdated(new Date().toISOString());
        const evtType = event.type || event.event;
        if ((evtType === 'incident_created' || evtType === 'incident_updated') && event.data) {
          const inc = event.data as Incident;
          setIncidents((prev) => {
            const exists = prev.some((i) => i.id === inc.id);
            return exists ? prev.map((i) => (i.id === inc.id ? inc : i)) : [inc, ...prev];
          });
        } else if (evtType === 'approval_decided' && event.data) {
          const { id, action_id, decision, decided_by, reason } = event.data;
          const targetId = id || action_id;
          setApprovals((prev) =>
            prev.map((a) =>
              a.id === targetId
                ? {
                    ...a,
                    status: decision,
                    decided_by: decided_by || 'operator',
                    decided_at: new Date().toISOString(),
                    rejection_reason: reason,
                  }
                : a
            )
          );
        }
      },
      (state) => {
        setConnectionState(state);
      }
    );
    return () => {
      mounted = false;
      stream.disconnect();
    };
  }, []);

  const toggleAutonomy = useCallback(() => {
    setAutonomyState((prev) => {
      const next = prev === 'Active' ? 'Paused' : 'Active';
      void apiClient.toggleAutonomy(next === 'Paused');
      // Record in audit log
      const auditEntry: AuditRecord = {
        id: `AUD-${(auditLogs.length + 1483).toString().padStart(6, '0')}`,
        timestamp: new Date().toISOString(),
        actor: 'human_operator (demo@alexia.local)',
        event: next === 'Paused' ? 'AUTONOMY_PAUSED' : 'AUTONOMY_RESUMED',
        action: next === 'Paused' ? 'PauseAutonomousActions' : 'ResumeAutonomousActions',
        target: 'GlobalGuardianEngine',
        outcome: 'SUCCESS',
        previous_hash: auditLogs[0]?.current_hash || '00000000000000000000000000000000',
        current_hash: 'f9410ea821bb40219410ea821bb40219410ea821bb40219410ea821bb40219',
        signature: 'ed25519:safety_lock_sig...',
        verification_status: 'Verified',
      };
      setAuditLogs((logs) => [auditEntry, ...logs]);
      return next;
    });
  }, [auditLogs]);

  const approveAction = useCallback(
    async (approvalId: string, note?: string): Promise<{ success: boolean; message: string }> => {
      setPendingActionId(approvalId);
      try {
        const result = await apiClient.submitApprovalDecision(approvalId, 'approved', note);
        if (result.success) {
          // Update approval in state
          setApprovals((prev) =>
            prev.map((app) =>
              app.id === approvalId
                ? {
                    ...app,
                    status: 'approved',
                    decided_by: 'human_operator (demo@alexia.local)',
                    decided_at: new Date().toISOString(),
                  }
                : app
            )
          );

          // If linked to an incident, advance its lifecycle
          const targetApproval = approvals.find((a) => a.id === approvalId);
          if (targetApproval) {
            setIncidents((prev) =>
              prev.map((inc) => {
                if (inc.id === targetApproval.incident_id) {
                  return {
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
                  };
                }
                return inc;
              })
            );

            // Add verified audit record
            const newAudit: AuditRecord = {
              id: `AUD-${(auditLogs.length + 1483).toString().padStart(6, '0')}`,
              timestamp: new Date().toISOString(),
              actor: 'human_operator (demo@alexia.local)',
              event: 'APPROVAL_GRANTED',
              action: targetApproval.action_name,
              target: targetApproval.affected_service,
              outcome: 'SUCCESS',
              incident_id: targetApproval.incident_id,
              previous_hash: auditLogs[0]?.current_hash || '00000000',
              current_hash: '9a81b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb9c1',
              signature: 'ed25519:operator_approval_sig',
              verification_status: 'Verified',
            };
            setAuditLogs((logs) => [newAudit, ...logs]);
          }
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [approvals, auditLogs]
  );

  const rejectAction = useCallback(
    async (approvalId: string, reason: string): Promise<{ success: boolean; message: string }> => {
      setPendingActionId(approvalId);
      try {
        const result = await apiClient.submitApprovalDecision(approvalId, 'rejected', reason);
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
              prev.map((inc) => {
                if (inc.id === targetApproval.incident_id) {
                  return {
                    ...inc,
                    status: 'escalated',
                    stages: inc.stages.map((s) =>
                      s.stage === 'action'
                        ? { ...s, status: 'failed', explanation: `Action rejected by operator: ${reason}` }
                        : s
                    ),
                  };
                }
                return inc;
              })
            );

            const newAudit: AuditRecord = {
              id: `AUD-${(auditLogs.length + 1483).toString().padStart(6, '0')}`,
              timestamp: new Date().toISOString(),
              actor: 'human_operator (demo@alexia.local)',
              event: 'APPROVAL_REJECTED',
              action: targetApproval.action_name,
              target: targetApproval.affected_service,
              outcome: 'DENIED',
              incident_id: targetApproval.incident_id,
              previous_hash: auditLogs[0]?.current_hash || '00000000',
              current_hash: '7781b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb9c9',
              signature: 'ed25519:operator_rejection_sig',
              verification_status: 'Verified',
            };
            setAuditLogs((logs) => [newAudit, ...logs]);
          }
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [approvals, auditLogs]
  );

  const rollbackDeployment = useCallback(
    async (serviceName: string, targetImage: string, reason: string): Promise<boolean> => {
      // Execute rollback on service
      setServices((prev) =>
        prev.map((s) =>
          s.name === serviceName
            ? { ...s, image: targetImage, status: 'healthy', uptime_seconds: 60 }
            : s
        )
      );

      // Record deployment
      const newDep: DeploymentRecord = {
        id: `DEP-${Date.now().toString().slice(-6)}`,
        service_name: serviceName,
        image_tag: targetImage,
        previous_known_good_image: targetImage,
        trigger: 'rollback',
        status: 'Successful',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        pre_deploy_gates: [
          { name: 'Target Image Verification', passed: true, details: `Validated ${targetImage} in local cache`, timestamp: new Date().toISOString() },
        ],
        health_gates: [
          { name: 'Healthz Endpoint', passed: true, details: 'HTTP 200 OK received in 3.4ms', timestamp: new Date().toISOString() },
        ],
        rollback_info: {
          is_rollback: true,
          target_image: targetImage,
          reason,
          executed_at: new Date().toISOString(),
        },
      };
      setDeployments((prev) => [newDep, ...prev]);

      const newAudit: AuditRecord = {
        id: `AUD-${(auditLogs.length + 1483).toString().padStart(6, '0')}`,
        timestamp: new Date().toISOString(),
        actor: 'Deployer',
        event: 'SERVICE_ROLLED_BACK',
        action: `Rollback to ${targetImage}`,
        target: serviceName,
        outcome: 'ROLLED_BACK',
        previous_hash: auditLogs[0]?.current_hash || '00000000',
        current_hash: '2281b4c7320fa9230571bc8819024a1b0924ec7108914b10549d88201a4fb999',
        signature: 'ed25519:rollback_sig',
        verification_status: 'Verified',
      };
      setAuditLogs((logs) => [newAudit, ...logs]);

      return true;
    },
    [auditLogs]
  );

  const runScenario = useCallback(
    async (scenarioId: ScenarioId) => {
      const targetScenario = scenarios.find((s) => s.id === scenarioId);
      if (!targetScenario) return;

      const runRes = await apiClient.runScenario(scenarioId);
      const runId = runRes.run_id || `RUN-${scenarioId}-${Date.now().toString().slice(-4)}`;
      setActiveScenarioRun({
        scenario_id: scenarioId,
        run_id: runId,
        status: 'starting',
        current_step: 'Initializing isolated sandbox environment...',
        progress_percent: 5,
        log_output: [`[0.0s] Initializing scenario ${scenarioId}: ${targetScenario.name}`],
      });

      // Simulation steps for hackathon demo
      const steps = [
        { progress: 20, status: 'injecting' as const, step: 'Injecting synthetic fault into ShopLite container network...', log: `[1.2s] Injected payload: ${targetScenario.simulated_payload_info}` },
        { progress: 45, status: 'detecting' as const, step: 'Sentinel anomaly monitor triggered: Alert dispatched to Orchestrator', log: '[3.4s] Sentinel captured anomalous metric & logged telemetry event' },
        { progress: 65, status: 'remediating' as const, step: 'Integrity created state snapshot. Healer synthesizing remediation patch...', log: '[6.1s] Snapshot created; Healer querying Tavily & formulating fix plan' },
        { progress: 85, status: 'remediating' as const, step: 'Builder compiled regression tests; Deployer staging isolated canary...', log: '[9.5s] AST regression tests passing (100%); Gate validated' },
        { progress: 100, status: 'completed' as const, step: 'Scenario successfully executed! Incident verified and resolved.', log: `[12.0s] Scenario ${scenarioId} completed successfully. Audit record sealed.` },
      ];

      for (let i = 0; i < steps.length; i++) {
        await new Promise((r) => setTimeout(r, 1400));
        const s = steps[i];
        setActiveScenarioRun((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: s.status,
            current_step: s.step,
            progress_percent: s.progress,
            log_output: [...prev.log_output, s.log],
          };
        });
      }

      if (apiClient.isLiveBackend()) {
        const dash = await apiClient.fetchDashboard();
        if (dash) {
          if (dash.incidents?.length) setIncidents(dash.incidents);
          if (dash.approvals?.length) setApprovals(dash.approvals);
          if (dash.model_calls?.length) setModelCalls(dash.model_calls);
          if (dash.model_summary) setModelSummary(dash.model_summary);
          if (dash.audit?.entries?.length) setAuditLogs(dash.audit.entries);
        }
      }

      // Update scenario last run
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
    [scenarios]
  );

  const resetEnvironment = useCallback(async () => {
    await apiClient.resetEnvironment();
    setIncidents(INITIAL_INCIDENTS);
    setApprovals(INITIAL_APPROVALS);
    setServices(INITIAL_SERVICES);
    setDeployments(INITIAL_DEPLOYMENTS);
    setAgents(INITIAL_AGENTS);
    setActiveScenarioRun(null);
  }, []);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
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
        lastUpdated,
        pendingActionId,
        approveAction,
        rejectAction,
        activeScenarioRun,
        runScenario,
        resetEnvironment,
        rollbackDeployment,
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
