import { Incident } from '../types/incidents';
import { ApprovalRequest } from '../types/actions';
import { ScenarioId } from '../types/scenarios';
import { ServiceHealth } from '../types/services';
import { AuditRecord, SnapshotRecord } from '../types/audit';
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

const SESSION_STORAGE_KEY = 'alexia_session_token';
const DEVICE_STORAGE_KEY = 'alexia_device_id';

export interface BlockedIpEntry {
  ip: string;
  blocked_at: string;
  expires_at: string;
  seconds_remaining: number;
  reason: string;
}

export interface RegisteredDevice {
  device_id: string;
  user: string;
  device_name: string;
  platform: string;
  ip_address?: string;
  registered_at: string;
  last_seen: string;
  is_revoked: number | boolean;
}

export interface CollectorStatusPayload {
  enabled: boolean;
  started: boolean;
  active: string[];
  collectors: Array<{
    name: string;
    running: boolean;
    last_probe?: Record<string, any>;
    last_sample?: Record<string, any>;
  }>;
}

export interface OperatorSessionInfo {
  authenticated: boolean;
  username: string | null;
  device_id: string | null;
  role: string | null;
  require_auth: boolean;
  demo_mode: boolean;
}

export interface DashboardPayload {
  autonomy_mode: 'autonomous' | 'paused';
  settings?: Record<string, any>;
  agents?: AgentInfo[];
  is_autonomy_paused: boolean;
  open_incidents_count: number;
  pending_approvals_count: number;
  incidents: Incident[];
  approvals: ApprovalRequest[];
  services: ServiceHealth[];
  deployments: Record<string, any>[];
  snapshots: Record<string, any>[];
  reports: Record<string, any>[];
  notifications?: Record<string, any>[];
  blocked_ips?: BlockedIpEntry[];
  collectors?: CollectorStatusPayload;
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

function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

export function b64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.byteLength; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

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

  getDeviceId(): string {
    let dev = safeStorageGet(DEVICE_STORAGE_KEY);
    if (!dev) {
      const rand = Math.random().toString(36).slice(2, 10);
      const isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
      dev = `${isMobile ? 'mobile' : 'web'}_${rand}`;
      safeStorageSet(DEVICE_STORAGE_KEY, dev);
    }
    return dev;
  }

  getSessionToken(): string | null {
    return safeStorageGet(SESSION_STORAGE_KEY);
  }

  setSessionToken(token: string | null): void {
    safeStorageSet(SESSION_STORAGE_KEY, token);
  }

  getBaseUrl(): string {
    return this.activeBaseUrl;
  }

  getEventStreamUrl(): string {
    return `${this.activeBaseUrl}/api/v1/events`;
  }

  private buildHeaders(extra?: Record<string, string>, hasJsonBody: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Device-ID': this.getDeviceId(),
      ...(extra || {}),
    };
    if (hasJsonBody) {
      headers['Content-Type'] = 'application/json';
    }
    const token = this.getSessionToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const hasBody = Boolean(init?.body);
    return fetch(`${this.activeBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: this.buildHeaders(init?.headers as Record<string, string> | undefined, hasBody),
    });
  }

  async checkHealth(): Promise<{
    connected: boolean;
    version?: string;
    demo_mode?: boolean;
    require_auth?: boolean;
  }> {
    for (const base of CANDIDATE_BASES) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1800);
        const res = await fetch(`${base}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data && data.status === 'healthy') {
            this.isConnectedToRealBackend = true;
            this.activeBaseUrl = base;
            return {
              connected: true,
              version: data.version || '1.0.0',
              demo_mode: data.demo_mode,
              require_auth: data.require_auth,
            };
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

  async fetchDashboard(): Promise<{ payload: DashboardPayload | null; authRequired?: boolean; error?: string }> {
    if (!this.isConnectedToRealBackend) {
      const health = await this.checkHealth();
      if (!health.connected) return { payload: null };
    }
    try {
      const res = await this.request('/api/v1/dashboard');
      if (res.status === 401) {
        return { payload: null, authRequired: true, error: await errorDetail(res) };
      }
      if (res.ok) {
        return { payload: await res.json() };
      }
      return { payload: null, error: await errorDetail(res) };
    } catch (err: any) {
      console.warn('Dashboard hydration fetch failed', err);
      return { payload: null, error: err?.message || 'Network error' };
    }
  }

  // -----------------------------------------------------------------------
  // Operator Authentication, TOTP, WebAuthn Passkeys & Devices
  // -----------------------------------------------------------------------
  async getAuthSession(): Promise<OperatorSessionInfo | null> {
    if (!this.isConnectedToRealBackend) return null;
    try {
      const res = await this.request('/remote/auth/me');
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return null;
  }

  async login(
    username: string,
    password: string,
    deviceName: string = 'Operator Browser',
    platform: string = 'Web'
  ): Promise<{ success: boolean; username?: string; role?: string; error?: string }> {
    try {
      const res = await this.request('/remote/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password,
          device_id: this.getDeviceId(),
          device_name: deviceName,
          platform,
        }),
      });
      if (!res.ok) {
        return { success: false, error: await errorDetail(res) };
      }
      const data = await res.json();
      if (data.session_token) {
        this.setSessionToken(data.session_token);
      }
      return { success: true, username: data.username, role: data.role };
    } catch {
      return { success: false, error: 'Alexia server unreachable' };
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.isConnectedToRealBackend) {
        await this.request('/remote/auth/logout', { method: 'POST' });
      }
    } finally {
      this.setSessionToken(null);
    }
  }

  async getTotpSetup(username: string = 'operator'): Promise<{ secret: string; otpauth_uri: string } | null> {
    if (!this.isConnectedToRealBackend) return null;
    try {
      const res = await this.request(`/remote/auth/totp-setup?username=${encodeURIComponent(username)}`);
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return null;
  }

  async registerPasskey(username: string = 'demo', deviceName: string = 'Operator Passkey'): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) {
      return { success: true, message: 'Passkey registered (offline preview)' };
    }
    if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials?.create) {
      return { success: false, message: 'WebAuthn Passkeys require HTTPS or localhost in a modern browser.' };
    }
    try {
      const chRes = await this.request('/remote/auth/webauthn/challenge', {
        method: 'POST',
        body: JSON.stringify({ username, purpose: 'register' }),
      });
      if (!chRes.ok) return { success: false, message: await errorDetail(chRes) };
      const chData = await chRes.json();

      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: b64UrlDecode(chData.challenge),
          rp: { name: chData.rp_name || 'Alexia DevSecOps Guardian' },
          user: {
            id: new TextEncoder().encode(username),
            name: username,
            displayName: `${username} (Alexia Operator)`,
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { userVerification: 'preferred' },
          timeout: chData.timeout_ms || 60000,
        },
      })) as PublicKeyCredential | null;

      if (!cred) return { success: false, message: 'Passkey ceremony cancelled.' };
      const response = cred.response as AuthenticatorAttestationResponse;
      const regRes = await this.request('/remote/auth/webauthn/register', {
        method: 'POST',
        body: JSON.stringify({
          username,
          credential_id: b64UrlEncode(cred.rawId),
          client_data_json: b64UrlEncode(response.clientDataJSON),
          public_key: b64UrlEncode(response.attestationObject),
          device_name: deviceName,
        }),
      });
      if (!regRes.ok) return { success: false, message: await errorDetail(regRes) };
      return { success: true, message: 'WebAuthn Passkey registered to this device.' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Passkey registration cancelled or unsupported.' };
    }
  }

  async stepUp(
    totpCode: string,
    username: string = 'demo',
    actionId?: string
  ): Promise<{ token?: string; error?: string }> {
    try {
      const res = await this.request('/remote/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({
          totp_code: totpCode,
          username,
          device_id: this.getDeviceId(),
          action_id: actionId,
        }),
      });
      if (!res.ok) return { error: await errorDetail(res) };
      return { token: (await res.json()).step_up_token };
    } catch {
      return { error: 'Alexia server unreachable' };
    }
  }

  async stepUpWithPasskey(
    username: string = 'demo',
    actionId?: string
  ): Promise<{ token?: string; error?: string }> {
    if (!this.isConnectedToRealBackend) {
      return { token: 'offline_demo_step_up' };
    }
    try {
      if (typeof window !== 'undefined' && window.PublicKeyCredential && navigator.credentials?.get) {
        const chRes = await this.request('/remote/auth/webauthn/challenge', {
          method: 'POST',
          body: JSON.stringify({ username, purpose: 'authenticate' }),
        });
        if (chRes.ok) {
          const chData = await chRes.json();
          const allowCredentials = (chData.allow_credentials || []).map((id: string) => ({
            type: 'public-key' as const,
            id: b64UrlDecode(id),
          }));
          try {
            const assertion = (await navigator.credentials.get({
              publicKey: {
                challenge: b64UrlDecode(chData.challenge),
                allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
                userVerification: 'preferred',
                timeout: chData.timeout_ms || 60000,
              },
            })) as PublicKeyCredential | null;

            if (assertion) {
              const resp = assertion.response as AuthenticatorAssertionResponse;
              const sigPayload = JSON.stringify({
                credential_id: b64UrlEncode(assertion.rawId),
                client_data_json: b64UrlEncode(resp.clientDataJSON),
                authenticator_data: b64UrlEncode(resp.authenticatorData),
                signature: b64UrlEncode(resp.signature),
              });
              const verifyRes = await this.request('/remote/auth/step-up', {
                method: 'POST',
                body: JSON.stringify({
                  passkey_signature: sigPayload,
                  username,
                  device_id: this.getDeviceId(),
                  action_id: actionId,
                }),
              });
              if (!verifyRes.ok) return { error: await errorDetail(verifyRes) };
              return { token: (await verifyRes.json()).step_up_token };
            }
          } catch {
            // Fall through to server-policy check (allows demo passkey in dev/demo, rejects in production)
          }
        }
      }

      const fallbackRes = await this.request('/remote/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({
          passkey_signature: `webauthn_demo_${this.getDeviceId()}`,
          username,
          device_id: this.getDeviceId(),
          action_id: actionId,
        }),
      });
      if (!fallbackRes.ok) return { error: await errorDetail(fallbackRes) };
      return { token: (await fallbackRes.json()).step_up_token };
    } catch {
      return { error: 'Alexia server unreachable' };
    }
  }

  async getDevices(): Promise<RegisteredDevice[]> {
    if (!this.isConnectedToRealBackend) return [];
    try {
      const res = await this.request('/remote/devices');
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return [];
  }

  async revokeDevice(deviceId: string, stepUpToken?: string): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: `Device ${deviceId} revoked (demo)` };
    try {
      const res = await this.request(`/remote/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ step_up_token: stepUpToken }),
      });
      if (res.ok) return { success: true, message: (await res.json()).message };
      return { success: false, message: await errorDetail(res) };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  // -----------------------------------------------------------------------
  // Domain Operations
  // -----------------------------------------------------------------------
  async getIncident(id: string): Promise<Incident | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request(`/api/v1/incidents/${encodeURIComponent(id)}`);
        if (res.ok) return await res.json();
        return null;
      } catch {
        return null;
      }
    }
    return INITIAL_INCIDENTS.find((inc) => inc.id === id) || null;
  }

  async investigateIncident(incidentId: string): Promise<ActionResult & { analysis?: string }> {
    if (!this.isConnectedToRealBackend) {
      return { success: true, message: 'Investigation refreshed (offline demo)', analysis: 'Demo root-cause confirmed.' };
    }
    try {
      const res = await this.request(`/api/v1/incidents/${encodeURIComponent(incidentId)}/investigate`, {
        method: 'POST',
      });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      const data = await res.json();
      return { success: true, message: 'AI investigation updated', analysis: data.analysis };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async submitApprovalDecision(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    actor: string = 'Operator (Web Console)',
    stepUpToken?: string
  ): Promise<ActionResult> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
          method: 'POST',
          body: JSON.stringify({ decision, reason, decided_by: actor, actor, step_up_token: stepUpToken }),
        });
        if (res.ok) {
          const data = await res.json();
          return { success: true, message: data.message || `Action ${approvalId} ${decision}` };
        }
        return { success: false, message: await errorDetail(res) };
      } catch {
        return { success: false, message: 'Alexia server unreachable; decision not recorded.' };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    return { success: true, message: `Action ${approvalId} successfully ${decision}` };
  }

  async toggleAutonomy(
    pause: boolean,
    user: string = 'Operator (web dashboard)',
    stepUpToken?: string
  ): Promise<ActionResult & { is_paused: boolean }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request('/remote/autonomy', {
          method: 'POST',
          body: JSON.stringify({ pause, user, device_id: this.getDeviceId(), step_up_token: stepUpToken }),
        });
        if (res.ok) {
          const data = await res.json();
          return { success: true, message: data.message, is_paused: data.is_paused };
        }
        return { success: false, message: await errorDetail(res), is_paused: !pause };
      } catch {
        return { success: false, message: 'Alexia server unreachable', is_paused: !pause };
      }
    }
    return { success: true, message: pause ? 'Autonomy paused' : 'Autonomy resumed', is_paused: pause };
  }

  async rollbackDeployment(deploymentId: string): Promise<ActionResult> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
          method: 'POST',
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'queued_for_approval') {
            return { success: true, message: data.message || 'Rollback queued for approval (autonomy paused)' };
          }
          return { success: true, message: `Rolled back to ${data.restored_version}` };
        }
        return { success: false, message: await errorDetail(res) };
      } catch {
        return { success: false, message: 'Alexia server unreachable' };
      }
    }
    return { success: true, message: 'Rolled back (demo mode)' };
  }

  async restartService(serviceId: string): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: 'Restart simulated (demo mode)' };
    try {
      const res = await this.request(`/api/v1/services/${encodeURIComponent(serviceId)}/restart`, { method: 'POST' });
      if (res.ok) return { success: true, message: (await res.json()).message };
      return { success: false, message: await errorDetail(res) };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async createSnapshot(serviceName: string = 'shoplite-api'): Promise<SnapshotRecord | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request('/api/v1/snapshots', {
          method: 'POST',
          body: JSON.stringify({ service_name: serviceName, incident_id: 'manual_operator' }),
        });
        if (res.ok) return await res.json();
      } catch {
        // ignore
      }
    }
    return null;
  }

  async verifySnapshotById(snapshotId: string): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: `Snapshot ${snapshotId} SHA-256 verified` };
    try {
      const res = await this.request(`/api/v1/snapshots/${encodeURIComponent(snapshotId)}/verify`, { method: 'POST' });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      const data = await res.json();
      return data.ok
        ? { success: true, message: `Snapshot ${snapshotId} SHA-256 verified (${String(data.actual_sha256 || '').slice(0, 12)}…)` }
        : { success: false, message: data.error || 'Snapshot checksum mismatch!' };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async restoreSnapshotById(snapshotId: string): Promise<ActionResult & { action_id?: string }> {
    if (!this.isConnectedToRealBackend) {
      return { success: true, message: `Restore queued in Approvals (demo)` };
    }
    try {
      const res = await this.request(`/api/v1/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: 'POST' });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      const data = await res.json();
      return {
        success: true,
        action_id: data.action_id,
        message: `Tier-1 restore queued in Approvals (${data.action_id}). Authorize with step-up to execute.`,
      };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async runIntegrityCheck(): Promise<ActionResult & { tables?: Record<string, number> }> {
    if (!this.isConnectedToRealBackend) {
      return { success: true, message: 'SQLite PRAGMA quick_check: ok (demo)', tables: { users: 2, products: 3 } };
    }
    try {
      const res = await this.request('/api/v1/integrity/check', { method: 'POST' });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      const data = await res.json();
      return {
        success: Boolean(data.integrity_ok),
        message: data.integrity_ok
          ? `Database integrity OK (${Object.keys(data.tables || {}).length} table(s) verified)`
          : `Integrity check failed: ${data.error || 'corrupted'}`,
        tables: data.tables,
      };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async runMigrationGuard(migrationSql: string): Promise<{
    success: boolean;
    safe?: boolean;
    risk_summary?: string;
    estimated_records_at_risk?: number;
    dropped_columns?: string[];
    dropped_tables?: string[];
    error?: string;
  }> {
    if (!this.isConnectedToRealBackend) {
      const destructive = /drop\s+(column|table)|truncate/i.test(migrationSql);
      return {
        success: true,
        safe: !destructive,
        risk_summary: destructive ? 'Destructive DDL detected in dry-run.' : 'Migration dry-run passed with zero data loss.',
        estimated_records_at_risk: destructive ? 2 : 0,
      };
    }
    try {
      const res = await this.request('/api/v1/integrity/migration-guard', {
        method: 'POST',
        body: JSON.stringify({ migration_sql: migrationSql }),
      });
      if (!res.ok) return { success: false, error: await errorDetail(res) };
      const data = await res.json();
      return { success: true, ...data };
    } catch {
      return { success: false, error: 'Alexia server unreachable' };
    }
  }

  async getBlockedIps(): Promise<BlockedIpEntry[]> {
    if (!this.isConnectedToRealBackend) return [];
    try {
      const res = await this.request('/api/v1/security/blocked-ips');
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return [];
  }

  async blockIp(ip: string, durationMinutes: number = 60, reason: string = 'Manual operator block'): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: `Blocked ${ip} (demo)` };
    try {
      const res = await this.request('/api/v1/security/blocked-ips', {
        method: 'POST',
        body: JSON.stringify({ ip, duration_minutes: durationMinutes, reason }),
      });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      return { success: true, message: (await res.json()).message };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async unblockIp(ip: string): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) return { success: true, message: `Unblocked ${ip} (demo)` };
    try {
      const res = await this.request(`/api/v1/security/blocked-ips/${encodeURIComponent(ip)}`, { method: 'DELETE' });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      return { success: true, message: (await res.json()).message };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  getReportExportUrl(reportId: string, format: 'html' | 'md' = 'html'): string {
    return `${this.activeBaseUrl}/api/v1/reports/${encodeURIComponent(reportId)}/export?format=${format}`;
  }

  async verifyAuditChain(): Promise<{ valid: boolean; records_checked: number; head_hash: string; head_signature?: string } | null> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request('/api/v1/audit/verify');
        if (res.ok) return await res.json();
      } catch {
        // ignore
      }
    }
    return null;
  }

  async getSettings(): Promise<Record<string, any> | null> {
    if (!this.isConnectedToRealBackend) return null;
    try {
      const res = await this.request('/api/v1/settings');
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return null;
  }

  async updateSettings(updates: Record<string, any>, stepUpToken?: string): Promise<ActionResult & { settings?: Record<string, any> }> {
    if (!this.isConnectedToRealBackend) {
      return { success: true, message: 'Preferences saved locally (offline demo)' };
    }
    try {
      const payload = stepUpToken ? { ...updates, step_up_token: stepUpToken } : updates;
      const res = await this.request('/api/v1/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (!res.ok) return { success: false, message: await errorDetail(res) };
      const settings = await res.json();
      return { success: true, message: 'Platform settings persisted to SQLite.', settings };
    } catch {
      return { success: false, message: 'Alexia server unreachable' };
    }
  }

  async subscribeWebPush(): Promise<ActionResult> {
    if (!this.isConnectedToRealBackend) {
      return { success: false, message: 'Live backend required for Web Push registration.' };
    }
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { success: false, message: 'Browser does not support Service Worker Web Push.' };
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        return { success: false, message: 'Notification permission was denied by browser.' };
      }
      const keyRes = await this.request('/remote/push/vapid-public-key');
      const keyInfo = keyRes.ok ? await keyRes.json() : { configured: false, public_key: '' };
      if (!keyInfo.configured || !keyInfo.public_key) {
        return {
          success: true,
          message: 'Browser notifications enabled (SSE live alerts active; configure VAPID_PUBLIC_KEY in .env for background Web Push).',
        };
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64UrlDecode(keyInfo.public_key),
      });
      const subJson = sub.toJSON();
      const saveRes = await this.request('/remote/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          p256dh: subJson.keys?.p256dh || '',
          auth: subJson.keys?.auth || '',
          device_id: this.getDeviceId(),
        }),
      });
      if (!saveRes.ok) return { success: false, message: await errorDetail(saveRes) };
      return { success: true, message: 'Web Push VAPID subscription registered for this device!' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Could not subscribe to Web Push.' };
    }
  }

  async markNotificationsRead(notificationId?: string): Promise<void> {
    if (!this.isConnectedToRealBackend) return;
    try {
      await this.request('/api/v1/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ notification_id: notificationId || null }),
      });
    } catch {
      // ignore
    }
  }

  async runScenario(
    scenarioId: ScenarioId
  ): Promise<{ run_id: string; status: string; incident_id?: string; description?: string; error?: string }> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request(`/api/v1/scenarios/${encodeURIComponent(scenarioId)}/run`, {
          method: 'POST',
        });
        if (res.ok) return await res.json();
        return { run_id: '', status: 'failed', error: await errorDetail(res) };
      } catch {
        return { run_id: '', status: 'failed', error: 'Alexia server unreachable' };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    return {
      run_id: `RUN-${scenarioId}-${Date.now().toString().slice(-4)}`,
      status: 'starting',
    };
  }

  async getScenarios(): Promise<Record<string, any>[] | null> {
    if (!this.isConnectedToRealBackend) return null;
    try {
      const res = await this.request('/api/v1/scenarios');
      if (res.ok) return await res.json();
    } catch {
      // ignore
    }
    return null;
  }

  async resetEnvironment(stepUpToken?: string): Promise<ActionResult> {
    if (this.isConnectedToRealBackend) {
      try {
        const res = await this.request('/api/v1/scenarios/reset', {
          method: 'POST',
          body: JSON.stringify({ step_up_token: stepUpToken }),
        });
        if (res.ok) return { success: true, message: 'Environment reset.' };
        return { success: false, message: await errorDetail(res) };
      } catch {
        return { success: false, message: 'Alexia server unreachable' };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    return { success: true, message: 'Demo state reset.' };
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
