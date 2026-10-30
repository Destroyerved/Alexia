import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { ScenarioId } from '../types/scenarios';
import { ServiceHealth, DeploymentRecord } from '../types/services';
import { AuditRecord, SnapshotRecord } from '../types/audit';
import { SecurityReport } from '../types/reports';
import { ModelCallRecord, ModelUsageSummary } from '../types/model-calls';
import { AgentInfo } from '../types/agents';
import {
  INITIAL_INCIDENTS,
  INITIAL_APPROVALS,
  INITIAL_SERVICES,
  INITIAL_DEPLOYMENTS,
  INITIAL_MODEL_CALLS,
  INITIAL_MODEL_SUMMARY,
  INITIAL_AUDIT_LOGS,
  INITIAL_SNAPSHOTS,
  INITIAL_SECURITY_REPORTS,
} from './mock-data';

const CANDIDATE_BASES = [
  import.meta.env.VITE_API_URL,
  '',
  'http://localhost:8080',
  'http://localhost:8000',
].filter((v): v is string => typeof v === 'string');

export interface DashboardPayload {
  autonomy_mode: 'autonomous' | 'paused';
  settings?: Record<string, unknown>;
  agents?: AgentInfo[];
  is_autonomy_paused: boolean;
  open_incidents_count: number;
  pending_approvals_count: number;
  incidents: Incident[];
  approvals: ApprovalRequest[];
  services: ServiceHealth[];
  // Raw backend records; mapped onto view models by src/lib/adapters.ts
  deployments: Record<string, any>[];
  snapshots: Record<string, any>[];
  reports: Record<string, any>[];
  model_summary: ModelUsageSummary;
  model_calls: ModelCallRecord[];
  audit: {
    chain_verified: boolean;
    verified_rows: number;
    entries: AuditRecord[];
  };
}

export interface ActionResult {
  success: boolean;
  message: string;
}

/** Pull FastAPI's `detail` out of an error response. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === 'string') return body.detail;
  } catch {
    // non-JSON error body
  }
  return `Request failed (HTTP ${res.status})`;
}

export class AlexiaApiClient {
  private isConnectedToRealBackend = false;
  private activeBaseUrl = import.meta.env.VITE_API_URL || '';

  getBaseUrl(): string {
    return this.activeBaseUrl;
  }

  /** Live SSE stream on the same backend the REST calls use. */
  getEventStreamUrl(): string {
    return `${this.activeBaseUrl}/api/v1/events`;
  }

  async checkHealth(): Promise<{ connected: boolean; version?: string }> {
    for (const base of CANDIDATE_BASES) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${base}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data && data.status === 'healthy') {
            this.isConnectedToRealBackend = true;
            this.activeBaseUrl = base;
            return { connected: true, version: '1.0.0' };
          }
        }
      } catch {
        // Try next candidate
      }
    }
    this.isConnectedToRealBackend = false;
    return { connected: false };
  }

  isLiveBackend(): boolean {
    return this.isConnectedToRealBackend;
  }

  async fetchDashboard(): Promise<DashboardPayload | null> {
    if (!this.isConnectedToRealBackend) {
      const health = await this.checkHealth();
      if (!health.connected) return null;
    }
    try {
      const res = await fetch(`${this.activeBaseUrl}/api/v1/dashboard`);
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.warn('Dashboard hydration fetch failed, using fallback data', err);
    }
    return null;
  }

  async getIncidents(): Promise<Incident[]> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/incidents`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('Live backend fetch failed, returning demo incidents', err);
      }
    }
    return INITIAL_INCIDENTS;
  }

  async getIncident(id: string): Promise<Incident | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/incidents/${id}`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn(`Failed to fetch incident ${id}`, err);
      }
    }
    const found = INITIAL_INCIDENTS.find((inc) => inc.id === id);
    return found || null;
  }

  async getApprovals(): Promise<ApprovalRequest[]> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/approvals`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('Live backend fetch approvals failed', err);
      }
    }
    return INITIAL_APPROVALS;
  }

  /** Step-up authentication (TOTP fallback for passkey/biometric) -> 5-minute elevation token. */
  async stepUp(totpCode: string, username: string = 'demo'): Promise<{ token?: string; error?: string }> {
    try {
      const res = await fetch(`${this.activeBaseUrl}/remote/auth/step-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp_code: totpCode, username }),
      });
      if (!res.ok) return { error: await errorDetail(res) };
      return { token: (await res.json()).step_up_token };
    } catch {
      return { error: 'Alexia server unreachable' };
    }
  }

  async submitApprovalDecision(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    actor: string = 'Operator (Passkey Verified)',
    stepUpToken?: string
  ): Promise<ActionResult> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/approvals/${approvalId}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, reason, decided_by: actor, actor, step_up_token: stepUpToken }),
        });
        if (res.ok) {
          const data = await res.json();
          return { success: true, message: data.message || `Action ${approvalId} ${decision}` };
        }
        return { success: false, message: await errorDetail(res) };
      } catch (err) {
        console.error('Approval submission error', err);
        return { success: false, message: 'Alexia server unreachable; decision not recorded.' };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      success: true,
      message: `Action ${approvalId} successfully ${decision}`,
    };
  }

  async toggleAutonomy(
    pause: boolean,
    user: string = 'Operator (Passkey Verified)',
    stepUpToken?: string
  ): Promise<ActionResult & { is_paused: boolean }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/remote/autonomy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pause, user, device_id: 'web_dashboard', step_up_token: stepUpToken }),
        });
        if (res.ok) {
          const data = await res.json();
          return { success: true, message: data.message, is_paused: data.is_paused };
        }
        return { success: false, message: await errorDetail(res), is_paused: !pause };
      } catch (err) {
        console.warn('Autonomy toggle error', err);
        return { success: false, message: 'Alexia server unreachable', is_paused: !pause };
      }
    }
    return { success: true, message: pause ? 'Autonomy paused' : 'Autonomy resumed', is_paused: pause };
  }

  async rollbackDeployment(deploymentId: string): Promise<ActionResult> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/deployments/${deploymentId}/rollback`, {
          method: 'POST',
        });
        if (res.ok) {
          const data = await res.json();
          return { success: true, message: `Rolled back to ${data.restored_version}` };
        }
        return { success: false, message: await errorDetail(res) };
      } catch (err) {
        console.warn('Rollback deployment error', err);
        return { success: false, message: 'Alexia server unreachable' };
      }
    }
    return { success: true, message: 'Rolled back (demo mode)' };
  }

  async restartService(serviceId: string): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: 'Restart simulated (demo mode)' };
    try {
      const res = await fetch(`${this.activeBaseUrl}/api/v1/services/${serviceId}/restart`, { method: 'POST' });
      if (res.ok) return { success: true, message: (await res.json()).message };
      return { success: false, message: await errorDetail(res) };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async createSnapshot(serviceName: string = 'shoplite-api + shoplite-db'): Promise<SnapshotRecord | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service_name: serviceName, incident_id: 'manual_operator' }),
        });
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('Snapshot creation error', err);
      }
    }
    return null;
  }

  async verifyAuditChain(): Promise<{ valid: boolean; records_checked: number; head_hash: string } | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/audit/verify`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('Audit verify error', err);
      }
    }
    return null;
  }

  async runScenario(
    scenarioId: ScenarioId
  ): Promise<{ run_id: string; status: string; incident_id?: string; description?: string; error?: string }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/scenarios/${scenarioId}/run`, {
          method: 'POST',
        });
        if (res.ok) return await res.json();
        return { run_id: '', status: 'failed', error: await errorDetail(res) };
      } catch (err) {
        console.error('Scenario run error', err);
        return { run_id: '', status: 'failed', error: 'Alexia server unreachable' };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      run_id: `RUN-${scenarioId}-${Date.now().toString().slice(-4)}`,
      status: 'starting',
    };
  }

  async getScenarios(): Promise<Record<string, any>[] | null> {
    if (!this.isConnectedToRealBackend) return null;
    try {
      const res = await fetch(`${this.activeBaseUrl}/api/v1/scenarios`);
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('Scenario catalog fetch failed', err);
    }
    return null;
  }

  async resetEnvironment(): Promise<{ success: boolean }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${this.activeBaseUrl}/api/v1/scenarios/reset`, { method: 'POST' });
        if (res.ok) return { success: true };
      } catch (err) {
        console.error('Reset error', err);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    return { success: true };
  }

  getFallbackState() {
    return {
      incidents: INITIAL_INCIDENTS,
      approvals: INITIAL_APPROVALS,
      services: INITIAL_SERVICES,
      deployments: INITIAL_DEPLOYMENTS,
      modelCalls: INITIAL_MODEL_CALLS,
      modelSummary: INITIAL_MODEL_SUMMARY,
      auditLogs: INITIAL_AUDIT_LOGS,
      snapshots: INITIAL_SNAPSHOTS,
      reports: INITIAL_SECURITY_REPORTS,
    };
  }
}

export const apiClient = new AlexiaApiClient();
