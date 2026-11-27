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
import {
  ActionResult,
  BlockedIpEntry,
  CollectorStatusPayload,
  DashboardPayload,
  OperatorSessionInfo,
  RegisteredDevice,
  apiClient,
} from '../lib/api';
import { toDeploymentRecord, toScenarioDefinition, toSecurityReport, toSnapshotRecord } from '../lib/adapters';
import { AuthModal } from '../components/auth/AuthModal';
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
  headSignature?: string;
}

interface StepUpPromptRequest {
  title?: string;
  description?: string;
  actionId?: string;
  resolve: (token: string | null) => void;
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
  devices: RegisteredDevice[];
  blockedIps: BlockedIpEntry[];
  collectors: CollectorStatusPayload | null;
  platformSettings: Record<string, any>;

  // Auth & Hydration state
  isHydrating: boolean;
  loadError: string | null;
  sessionInfo: OperatorSessionInfo | null;
  openAuthModal: () => void;
  requestStepUp: (opts?: { title?: string; description?: string; actionId?: string }) => Promise<string | null>;

  // Global safety & environment
  autonomyState: 'Active' | 'Paused';
  toggleAutonomy: (stepUpCode?: string) => Promise<ActionResult>;
  environment: string;
  setEnvironment: (env: string) => void;
  connectionState: ConnectionState;
  isDemoMode: boolean;
  isLiveBackend: boolean;
  lastUpdated: string;

  // Actions & Operations
  pendingActionId: string | null;
  approveAction: (approvalId: string, note?: string, stepUpCode?: string, preVerifiedToken?: string) => Promise<ActionResult>;
  rejectAction: (approvalId: string, reason: string) => Promise<ActionResult>;
  reinvestigateIncident: (incidentId: string) => Promise<ActionResult>;
  activeScenarioRun: ScenarioRunState | null;
  lastScenarioIncidentId: string | null;
  runScenario: (scenarioId: ScenarioId) => Promise<void>;
  resetEnvironment: () => Promise<ActionResult>;
  rollbackDeployment: (serviceName: string, targetImage: string, reason: string, deploymentId?: string) => Promise<ActionResult>;
  restartService: (serviceId: string) => Promise<ActionResult>;
  takeSnapshot: () => Promise<ActionResult>;
  verifySnapshot: (snapshotId: string) => Promise<ActionResult>;
  restoreSnapshot: (snapshotId: string) => Promise<ActionResult>;
  runIntegrityCheck: () => Promise<ActionResult & { tables?: Record<string, number> }>;
  runMigrationGuard: (sql: string) => ReturnType<typeof apiClient.runMigrationGuard>;
  blockIp: (ip: string, durationMinutes?: number, reason?: string) => Promise<ActionResult>;
  unblockIp: (ip: string) => Promise<ActionResult>;
  revokeDevice: (deviceId: string) => Promise<ActionResult>;
  savePlatformSettings: (updates: Record<string, any>) => Promise<ActionResult>;
  subscribeWebPush: () => Promise<ActionResult>;
  verifyAuditChain: () => Promise<ActionResult>;
  refresh: () => Promise<void>;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
}

const AlexiaContext = createContext<AlexiaContextType | undefined>(undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function viewForDeepLink(link?: string): string | undefined {
  if (!link) return undefined;
  if (link.includes('/approvals')) return 'approvals';
  if (link.includes('/incident')) return 'incidents';
  if (link.includes('/security') || link.includes('/reports')) return 'security';
  return undefined;
}

function initialViewFromLocation(): string {
  if (typeof window === 'undefined') return 'overview';
  return viewForDeepLink(window.location.pathname) || 'overview';
}

export const AlexiaProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentView, setCurrentView] = useState<string>(initialViewFromLocation);
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
  const [auditChain, setAuditChain] = useState<AuditChainStatus | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>(INITIAL_SNAPSHOTS);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>(SCENARIO_CATALOG);
  const [securityReports, setSecurityReports] = useState<SecurityReport[]>(INITIAL_SECURITY_REPORTS);
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [blockedIps, setBlockedIps] = useState<BlockedIpEntry[]>([]);
  const [collectors, setCollectors] = useState<CollectorStatusPayload | null>(null);
  const [platformSettings, setPlatformSettings] = useState<Record<string, any>>({
    demo_mode: true,
    redaction_enabled: true,
    step_up_auth_required: true,
    daily_usd_budget: 10.0,
    daily_token_budget: 5000000,
    webhook_signature_verification: true,
    auto_snapshot_before_tier1: true,
    notifications_muted: false,
    quiet_hours_start: '',
    quiet_hours_end: '',
  });

  const [isHydrating, setIsHydrating] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<OperatorSessionInfo | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState<boolean>(false);
  const [stepUpPrompt, setStepUpPrompt] = useState<StepUpPromptRequest | null>(null);

  const [autonomyState, setAutonomyState] = useState<'Active' | 'Paused'>('Active');
  const [environment, setEnvironment] = useState<string>('Sandbox (ShopLite Docker)');
  const [connectionState, setConnectionState] = useState<ConnectionState>('Connected');
  const [isLiveBackend, setIsLiveBackend] = useState<boolean>(false);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toISOString());

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [activeScenarioRun, setActiveScenarioRun] = useState<ScenarioRunState | null>(null);
  const [lastScenarioIncidentId, setLastScenarioIncidentId] = useState<string | null>(null);

  const [notifications, setNotifications] = useState<AppNotification[]>([
    {
      id: 'notif-1',
      title: 'Tier 1 Approval Required',
      description: 'Deployer requested permission to merge fix PR #142.',
      severity: 'high',
      timestamp: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
      read: false,
      link_to: 'approvals',
    },
  ]);

  const requestStepUp = useCallback(
    (opts?: { title?: string; description?: string; actionId?: string }): Promise<string | null> => {
      return new Promise((resolve) => {
        setStepUpPrompt({
          title: opts?.title,
          description: opts?.description,
          actionId: opts?.actionId,
          resolve,
        });
      });
    },
    []
  );

  const openAuthModal = useCallback(() => {
    setLoginModalOpen(true);
  }, []);

  const pushNotification = useCallback((n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => {
    setNotifications((prev) =>
      [
        {
          ...n,
          id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          read: false,
        },
        ...prev,
      ].slice(0, 50)
    );
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setLastUpdated(new Date().toISOString());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

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
    setAuditChain({
      verified: Boolean(payload.audit?.chain_verified),
      rows: payload.audit?.verified_rows ?? 0,
      headSignature: payload.audit?.entries?.[0]?.signature,
    });
    if (payload.agents?.length) setAgents(payload.agents);
    if (payload.blocked_ips) setBlockedIps(payload.blocked_ips);
    if (payload.collectors) setCollectors(payload.collectors);
    if (payload.settings) {
      setPlatformSettings(payload.settings);
      if (typeof payload.settings.environment === 'string' && payload.settings.environment) {
        setEnvironment(payload.settings.environment);
      }
      setIsDemoMode(Boolean(payload.settings.demo_mode ?? false));
    }
    if (Array.isArray(payload.notifications)) {
      setNotifications(
        payload.notifications.map((n: any) => ({
          id: String(n.id),
          title: String(n.title || 'Alexia Alert'),
          description: String(n.body || n.message || ''),
          severity: n.severity === 'critical' ? 'critical' : n.severity === 'high' ? 'high' : 'info',
          timestamp: String(n.created_at || n.timestamp || new Date().toISOString()),
          read: Boolean(n.read),
          link_to: viewForDeepLink(n.deep_link),
        }))
      );
    }

    const activeCount = liveIncidents.filter((i) => i.status !== 'resolved' && i.status !== 'escalated').length;
    setOrchestrator((prev) => ({
      ...prev,
      state: payload.is_autonomy_paused
        ? 'Waiting for approval'
        : activeCount > 0
        ? 'Working'
        : 'Idle',
      active_workflow: payload.is_autonomy_paused
        ? 'Autonomy paused by operator'
        : activeCount > 0
        ? `Coordinating ${activeCount} active remediation workflow${activeCount === 1 ? '' : 's'}`
        : 'Monitoring ingress telemetry & Docker health',
    }));

    setAutonomyState(payload.is_autonomy_paused ? 'Paused' : 'Active');
    setLoadError(null);
    setLastUpdated(new Date().toISOString());
  }, []);

  const refresh = useCallback(async () => {
    const res = await apiClient.fetchDashboard();
    if (res.authRequired) {
      setIsLiveBackend(true);
      setLoginModalOpen(true);
      setLoadError('Sign in required to view production telemetry.');
      const me = await apiClient.getAuthSession();
      if (me) {
        setSessionInfo(me);
        setIsDemoMode(me.demo_mode);
      }
      return;
    }
    if (res.payload) {
      setIsLiveBackend(true);
      applyDashboard(res.payload);
      const [me, devs] = await Promise.all([apiClient.getAuthSession(), apiClient.getDevices()]);
      if (me) setSessionInfo(me);
      setDevices(devs);
    } else if (res.error && apiClient.isLiveBackend()) {
      setLoadError(res.error);
    }
  }, [applyDashboard]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 350);
  }, [refresh]);

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
        evtType === 'approval_requested' ||
        evtType === 'deployment_rolled_back' ||
        evtType === 'service_restarted' ||
        evtType === 'settings_updated' ||
        evtType === 'autonomy_changed' ||
        evtType === 'snapshot_created' ||
        evtType === 'device_revoked' ||
        evtType === 'environment_reset'
      ) {
        scheduleRefresh();
      }
    };

    setIsHydrating(true);
    apiClient
      .fetchDashboard()
      .then(async (res) => {
        if (!mounted) return;
        setIsHydrating(false);
        if (res.authRequired) {
          setIsLiveBackend(true);
          setIsDemoMode(false);
          setLoginModalOpen(true);
          const me = await apiClient.getAuthSession();
          if (mounted && me) setSessionInfo(me);
          return;
        }
        if (!res.payload) {
          setConnectionState('Offline');
          return;
        }
        setIsLiveBackend(true);
        applyDashboard(res.payload);
        const [catalog, me, devs] = await Promise.all([
          apiClient.getScenarios(),
          apiClient.getAuthSession(),
          apiClient.getDevices(),
        ]);
        if (!mounted) return;
        if (catalog?.length) setScenarios(catalog.map(toScenarioDefinition));
        if (me) setSessionInfo(me);
        setDevices(devs);

        stream = new AlexiaEventStream(apiClient.getEventStreamUrl(), () => apiClient.getSessionToken());
        stream.connect(
          handleEvent,
          (state) => setConnectionState(state),
          () => scheduleRefresh()
        );
      })
      .catch(() => {
        if (mounted) {
          setIsHydrating(false);
          setConnectionState('Offline');
        }
      });

    return () => {
      mounted = false;
      stream?.disconnect();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [applyDashboard, pushNotification, scheduleRefresh]);

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
          signature: 'hmac-sha256:demo',
        });
        return { success: true, message: pause ? 'Autonomy paused (demo mode)' : 'Autonomy resumed (demo mode)' };
      }

      let stepUpToken: string | undefined;
      if (!pause) {
        if (stepUpCode?.trim()) {
          const su = await apiClient.stepUp(stepUpCode.trim(), sessionInfo?.username || 'demo');
          if (!su.token) {
            pushNotification({ title: 'Step-up failed', description: su.error || 'Invalid code', severity: 'high' });
            return { success: false, message: su.error || 'Step-up failed' };
          }
          stepUpToken = su.token;
        } else {
          const modalToken = await requestStepUp({
            title: 'Resume Guardian Autonomy',
            description: 'Resuming autonomous Tier-0 remediation requires Passkey or TOTP step-up verification.',
          });
          if (!modalToken) {
            return { success: false, message: 'Resume cancelled: step-up verification required.' };
          }
          stepUpToken = modalToken;
        }
      }

      const res = await apiClient.toggleAutonomy(pause, sessionInfo?.username || 'Operator', stepUpToken);
      if (res.success) {
        setAutonomyState(res.is_paused ? 'Paused' : 'Active');
      } else {
        pushNotification({ title: 'Autonomy change refused', description: res.message, severity: 'high' });
      }
      scheduleRefresh();
      return res;
    },
    [autonomyState, appendDemoAudit, pushNotification, requestStepUp, scheduleRefresh, sessionInfo]
  );

  const approveAction = useCallback(
    async (
      approvalId: string,
      note?: string,
      stepUpCode?: string,
      preVerifiedToken?: string
    ): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        if (apiClient.isLiveBackend()) {
          let tokenToUse = preVerifiedToken;
          if (!tokenToUse) {
            if (stepUpCode?.trim()) {
              const su = await apiClient.stepUp(stepUpCode.trim(), sessionInfo?.username || 'demo', approvalId);
              if (!su.token) return { success: false, message: su.error || 'Step-up authentication failed' };
              tokenToUse = su.token;
            } else {
              const modalTok = await requestStepUp({
                title: `Authorize ${approvalId}`,
                description: 'Tier-1 actions require Passkey / Biometric or TOTP step-up.',
                actionId: approvalId,
              });
              if (!modalTok) return { success: false, message: 'Authorization cancelled.' };
              tokenToUse = modalTok;
            }
          }
          const result = await apiClient.submitApprovalDecision(
            approvalId,
            'approved',
            note,
            sessionInfo?.username || 'Operator (web dashboard)',
            tokenToUse
          );
          await refresh();
          return result;
        }

        const result = await apiClient.submitApprovalDecision(approvalId, 'approved', note);
        if (result.success) {
          setApprovals((prev) =>
            prev.map((app) =>
              app.id === approvalId
                ? { ...app, status: 'approved', decided_by: 'human_operator', decided_at: new Date().toISOString() }
                : app
            )
          );
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [refresh, requestStepUp, sessionInfo]
  );

  const rejectAction = useCallback(
    async (approvalId: string, reason: string): Promise<ActionResult> => {
      setPendingActionId(approvalId);
      try {
        const result = await apiClient.submitApprovalDecision(
          approvalId,
          'rejected',
          reason,
          sessionInfo?.username || 'Operator (web dashboard)'
        );
        if (apiClient.isLiveBackend()) {
          await refresh();
          return result;
        }
        if (result.success) {
          setApprovals((prev) =>
            prev.map((app) =>
              app.id === approvalId
                ? { ...app, status: 'rejected', rejection_reason: reason, decided_at: new Date().toISOString() }
                : app
            )
          );
        }
        return result;
      } finally {
        setPendingActionId(null);
      }
    },
    [refresh, sessionInfo]
  );

  const reinvestigateIncident = useCallback(
    async (incidentId: string): Promise<ActionResult> => {
      const res = await apiClient.investigateIncident(incidentId);
      if (apiClient.isLiveBackend() && res.success) {
        await refresh();
      }
      return res;
    },
    [refresh]
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
      return { success: true, message: `Rolled back ${serviceName} to ${targetImage} (demo mode)` };
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
    if (!apiClient.isLiveBackend()) return { success: true, message: 'Snapshot simulated (demo mode)' };
    const snap = await apiClient.createSnapshot();
    await refresh();
    return snap
      ? { success: true, message: `Snapshot ${snap.id} captured (sha256 ${String((snap as any).sha256 ?? '').slice(0, 12)}…)` }
      : { success: false, message: 'Snapshot failed' };
  }, [refresh]);

  const verifySnapshot = useCallback(async (snapshotId: string): Promise<ActionResult> => {
    return apiClient.verifySnapshotById(snapshotId);
  }, []);

  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<ActionResult> => {
      const res = await apiClient.restoreSnapshotById(snapshotId);
      if (apiClient.isLiveBackend() && res.success) await refresh();
      return res;
    },
    [refresh]
  );

  const runIntegrityCheck = useCallback(async () => {
    const res = await apiClient.runIntegrityCheck();
    if (apiClient.isLiveBackend() && res.success) await refresh();
    return res;
  }, [refresh]);

  const runMigrationGuard = useCallback(async (sql: string) => {
    return apiClient.runMigrationGuard(sql);
  }, []);

  const blockIp = useCallback(
    async (ip: string, durationMinutes: number = 60, reason: string = 'Manual operator containment'): Promise<ActionResult> => {
      const res = await apiClient.blockIp(ip, durationMinutes, reason);
      if (apiClient.isLiveBackend() && res.success) await refresh();
      return res;
    },
    [refresh]
  );

  const unblockIp = useCallback(
    async (ip: string): Promise<ActionResult> => {
      const res = await apiClient.unblockIp(ip);
      if (apiClient.isLiveBackend() && res.success) await refresh();
      return res;
    },
    [refresh]
  );

  const revokeDevice = useCallback(
    async (deviceId: string): Promise<ActionResult> => {
      let stepUpTok: string | undefined;
      if (sessionInfo?.require_auth) {
        const tok = await requestStepUp({
          title: `Revoke Device ${deviceId}`,
          description: 'Revoking a paired operator device requires step-up authentication.',
        });
        if (!tok) return { success: false, message: 'Device revocation cancelled.' };
        stepUpTok = tok;
      }
      const res = await apiClient.revokeDevice(deviceId, stepUpTok);
      if (apiClient.isLiveBackend() && res.success) await refresh();
      return res;
    },
    [refresh, requestStepUp, sessionInfo]
  );

  const savePlatformSettings = useCallback(
    async (updates: Record<string, any>): Promise<ActionResult> => {
      const sensitiveFalse = ['step_up_auth_required', 'redaction_enabled', 'webhook_signature_verification'].some(
        (k) => k in updates && updates[k] === false && platformSettings[k] !== false
      );
      let stepUpTok: string | undefined;
      if (apiClient.isLiveBackend() && sensitiveFalse) {
        const tok = await requestStepUp({
          title: 'Confirm Security Policy Change',
          description: 'Lowering redaction, webhook HMAC, or step-up requirements needs step-up verification.',
        });
        if (!tok) return { success: false, message: 'Settings update cancelled.' };
        stepUpTok = tok;
      }
      const res = await apiClient.updateSettings(updates, stepUpTok);
      if (res.success && apiClient.isLiveBackend()) {
        await refresh();
      }
      return res;
    },
    [platformSettings, refresh, requestStepUp]
  );

  const subscribeWebPush = useCallback(async (): Promise<ActionResult> => {
    return apiClient.subscribeWebPush();
  }, []);

  const verifyAuditChain = useCallback(async (): Promise<ActionResult> => {
    if (!apiClient.isLiveBackend()) return { success: true, message: 'Audit chain verified (demo data)' };
    const res = await apiClient.verifyAuditChain();
    if (!res) return { success: false, message: 'Audit verification unavailable' };
    setAuditChain({ verified: res.valid, rows: res.records_checked, headSignature: res.head_signature });
    return res.valid
      ? { success: true, message: `Audit chain verified: ${res.records_checked} SHA-256 + HMAC signed blocks intact` }
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
        if (runRes.incident_id) {
          setLastScenarioIncidentId(runRes.incident_id);
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
        if (runRes.incident_id) {
          setSelectedIncidentId(runRes.incident_id);
        }
      } else {
        const fallbackIncId = scenarioId === 'S6' ? 'DEMO-INC-2026-0841' : 'DEMO-INC-2026-0842';
        setLastScenarioIncidentId(fallbackIncId);
        setActiveScenarioRun({
          scenario_id: scenarioId,
          run_id: runId,
          status: 'starting',
          current_step: 'Initializing isolated sandbox environment...',
          progress_percent: 5,
          log_output: [`[0.0s] Initializing scenario ${scenarioId}: ${targetScenario.name}`],
        });

        const steps = [
          { progress: 20, status: 'injecting' as const, step: 'Injecting synthetic fault into ShopLite container network...', log: `[1.2s] Injected payload: ${targetScenario.simulated_payload_info}` },
          { progress: 45, status: 'detecting' as const, step: 'Sentinel anomaly monitor triggered: Alert dispatched to Orchestrator', log: '[3.4s] Sentinel captured anomalous metric & logged telemetry event' },
          { progress: 65, status: 'remediating' as const, step: 'Integrity created state snapshot. Healer synthesizing remediation patch...', log: '[6.1s] Snapshot created; Healer querying Tavily & formulating fix plan' },
          { progress: 85, status: 'remediating' as const, step: 'Builder compiled regression tests; Deployer staging isolated canary...', log: '[9.5s] AST regression tests passing (100%); Gate validated' },
          { progress: 100, status: 'completed' as const, step: 'Scenario successfully executed! Incident verified and resolved.', log: `[12.0s] Scenario ${scenarioId} completed successfully. Audit record sealed.` },
        ];
        for (const s of steps) {
          await sleep(800);
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

  const resetEnvironment = useCallback(async (): Promise<ActionResult> => {
    let stepUpTok: string | undefined;
    if (apiClient.isLiveBackend() && sessionInfo?.require_auth && (autonomyState === 'Paused' || !isDemoMode)) {
      const tok = await requestStepUp({
        title: 'Confirm Environment Reset',
        description: 'Resetting blocklists or kill-switch state in production requires step-up authentication.',
      });
      if (!tok) return { success: false, message: 'Reset cancelled.' };
      stepUpTok = tok;
    }
    const res = await apiClient.resetEnvironment(stepUpTok);
    if (!res.success) return res;
    setActiveScenarioRun(null);
    if (apiClient.isLiveBackend()) {
      await refresh();
      return res;
    }
    setIncidents(INITIAL_INCIDENTS);
    setApprovals(INITIAL_APPROVALS);
    setServices(INITIAL_SERVICES);
    setDeployments(INITIAL_DEPLOYMENTS);
    setAgents(INITIAL_AGENTS);
    return res;
  }, [autonomyState, isDemoMode, refresh, requestStepUp, sessionInfo]);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    void apiClient.markNotificationsRead(id);
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    void apiClient.markNotificationsRead();
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
        devices,
        blockedIps,
        collectors,
        platformSettings,
        isHydrating,
        loadError,
        sessionInfo,
        openAuthModal,
        requestStepUp,
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
        reinvestigateIncident,
        activeScenarioRun,
        lastScenarioIncidentId,
        runScenario,
        resetEnvironment,
        rollbackDeployment,
        restartService,
        takeSnapshot,
        verifySnapshot,
        restoreSnapshot,
        runIntegrityCheck,
        runMigrationGuard,
        blockIp,
        unblockIp,
        revokeDevice,
        savePlatformSettings,
        subscribeWebPush,
        verifyAuditChain,
        refresh,
        markNotificationRead,
        clearNotifications,
      }}
    >
      {children}

      <AuthModal
        isOpen={loginModalOpen}
        mode="login"
        isDemoMode={isDemoMode}
        sessionInfo={sessionInfo}
        onClose={() => setLoginModalOpen(false)}
        onLoginSuccess={() => {
          setLoginModalOpen(false);
          void refresh();
        }}
      />

      <AuthModal
        isOpen={Boolean(stepUpPrompt)}
        mode="step-up"
        title={stepUpPrompt?.title}
        description={stepUpPrompt?.description}
        actionId={stepUpPrompt?.actionId}
        isDemoMode={isDemoMode}
        sessionInfo={sessionInfo}
        onClose={() => {
          if (stepUpPrompt) {
            stepUpPrompt.resolve(null);
            setStepUpPrompt(null);
          }
        }}
        onStepUpVerified={(tok) => {
          if (stepUpPrompt) {
            stepUpPrompt.resolve(tok);
            setStepUpPrompt(null);
          }
        }}
      />
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
