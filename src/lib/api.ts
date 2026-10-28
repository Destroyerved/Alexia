import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { ScenarioId, ScenarioRunState } from '../types/scenarios';
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
  SCENARIO_CATALOG,
} from './mock-data';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export class AlexiaApiClient {
  private isConnectedToRealBackend = false;

  async checkHealth(): Promise<{ connected: boolean; version?: string }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${API_BASE}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        this.isConnectedToRealBackend = true;
        return { connected: true };
      }
    } catch {
      // Backend not running; deliberate demo mode fallback
      this.isConnectedToRealBackend = false;
    }
    return { connected: false };
  }

  isLiveBackend(): boolean {
    return this.isConnectedToRealBackend;
  }

  async getIncidents(): Promise<Incident[]> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${API_BASE}/incidents`);
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
        const res = await fetch(`${API_BASE}/incidents/${id}`);
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
        const res = await fetch(`${API_BASE}/approvals`);
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('Live backend fetch approvals failed', err);
      }
    }
    return INITIAL_APPROVALS;
  }

  async submitApprovalDecision(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${API_BASE}/approvals/${approvalId}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, reason }),
        });
        if (res.ok) {
          return await res.json();
        }
      } catch (err) {
        console.error('Approval submission error', err);
        return { success: false, message: 'Backend connection error' };
      }
    }
    // Simulated demo mode handling
    await new Promise((r) => setTimeout(r, 600));
    return {
      success: true,
      message: `Action ${approvalId} successfully ${decision} (Simulated Demo Confirmation)`,
    };
  }

  async runScenario(scenarioId: ScenarioId): Promise<{ run_id: string; status: string }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${API_BASE}/scenarios/${scenarioId}/run`, {
          method: 'POST',
        });
        if (res.ok) return await res.json();
      } catch (err) {
        console.error('Scenario run error', err);
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    return {
      run_id: `RUN-${scenarioId}-${Date.now().toString().slice(-4)}`,
      status: 'starting',
    };
  }

  async resetEnvironment(): Promise<{ success: boolean }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await fetch(`${API_BASE}/environment/reset`, { method: 'POST' });
        if (res.ok) return await res.json();
      } catch (err) {
        console.error('Reset error', err);
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    return { success: true };
  }
}

export const apiClient = new AlexiaApiClient();
