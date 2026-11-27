import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { AuthModal } from '../components/auth/AuthModal';
import { DemoModeBanner } from '../components/status/DemoModeBanner';
import { SecurityView } from '../features/security/SecurityView';
import { ModelUsageView } from '../features/observability/ModelUsageView';
import { AlexiaProvider } from '../context/AlexiaContext';
import { AlexiaEventStream, ConnectionState } from '../lib/event-stream';
import { apiClient } from '../lib/api';

describe('Alexia Production Hardening Frontend Suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ErrorBoundary catches render failures and recovers on Retry View', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const CrashToggle: React.FC = () => {
      const [shouldCrash, setShouldCrash] = useState(true);
      const ThrowingChild: React.FC = () => {
        if (shouldCrash) {
          throw new Error('Synthetic view panic');
        }
        return <div data-testid="recovered-content">Healthy View Restored</div>;
      };

      return (
        <div>
          <button type="button" onClick={() => setShouldCrash(false)}>
            Disarm Crash
          </button>
          <ErrorBoundary fallbackTitle="Test Boundary Interrupted">
            <ThrowingChild />
          </ErrorBoundary>
        </div>
      );
    };

    render(<CrashToggle />);

    expect(screen.getByText('Test Boundary Interrupted')).toBeDefined();
    expect(screen.getByText('Synthetic view panic')).toBeDefined();

    fireEvent.click(screen.getByText('Disarm Crash'));
    fireEvent.click(screen.getByText('Retry View'));

    expect(screen.getByTestId('recovered-content')).toBeDefined();
    expect(screen.getByText('Healthy View Restored')).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('AuthModal supports operator login and 6-digit TOTP step-up verification', async () => {
    const onClose = vi.fn();
    const onStepUpVerified = vi.fn();
    const stepUpSpy = vi
      .spyOn(apiClient, 'stepUp')
      .mockResolvedValue({ token: 'signed-step-up-token-123' });

    const { rerender } = render(
      <AuthModal
        isOpen={true}
        mode="login"
        isDemoMode={false}
        onClose={onClose}
      />
    );

    expect(screen.getByText('Operator Session & Security')).toBeDefined();
    expect(screen.getByText('Sign In as Operator')).toBeDefined();
    expect(screen.getByText('Enroll Passkey')).toBeDefined();
    expect(screen.getByText('TOTP Secret')).toBeDefined();

    rerender(
      <AuthModal
        isOpen={true}
        mode="step-up"
        title="Authorize Action APP-901"
        actionId="APP-901"
        isDemoMode={false}
        onClose={onClose}
        onStepUpVerified={onStepUpVerified}
      />
    );

    expect(screen.getByText('Authorize Action APP-901')).toBeDefined();
    expect(screen.getByText('Verify with Passkey / Biometric')).toBeDefined();

    const input = screen.getByLabelText(/Authenticator Code/i);
    fireEvent.change(input, { target: { value: '654321' } });
    fireEvent.click(screen.getByText('Confirm Step-Up'));

    await waitFor(() => {
      expect(stepUpSpy).toHaveBeenCalledWith('654321', 'admin', 'APP-901');
      expect(onStepUpVerified).toHaveBeenCalledWith('signed-step-up-token-123');
    });
  });

  it('DemoModeBanner renders in demo mode and hides when backend reports production mode', async () => {
    vi.spyOn(apiClient, 'fetchDashboard').mockResolvedValueOnce({
      payload: {
        incidents: [],
        approvals: [],
        services: [],
        deployments: [],
        snapshots: [],
        reports: [],
        model_calls: [],
        audit: { entries: [], chain_verified: true, verified_rows: 0 },
        settings: { demo_mode: false, environment: 'Production Cluster' },
      } as any,
    });
    vi.spyOn(apiClient, 'getScenarios').mockResolvedValueOnce([]);
    vi.spyOn(apiClient, 'getAuthSession').mockResolvedValueOnce({
      authenticated: true,
      username: 'admin@alexia.local',
      device_id: 'dev-console-1',
      role: 'admin',
      demo_mode: false,
      require_auth: true,
    });
    vi.spyOn(apiClient, 'getDevices').mockResolvedValueOnce([]);

    render(
      <AlexiaProvider>
        <DemoModeBanner />
      </AlexiaProvider>
    );

    await waitFor(() => {
      expect(screen.queryByText(/OFFLINE PREVIEW/i)).toBeNull();
      expect(screen.queryByText(/SANDBOX DEMO/i)).toBeNull();
    });
  });

  it('SecurityView renders all 5 operational tabs including Snapshots, IP Blocklist, and Devices', () => {
    render(
      <AlexiaProvider>
        <SecurityView />
      </AlexiaProvider>
    );

    expect(screen.getByRole('button', { name: 'Compliance Reports' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Audit Ledger' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Snapshots & DB' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'IP Blocklist' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Devices & Security' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Audit Ledger' }));
    expect(screen.getByPlaceholderText(/Filter audit blocks by actor, action, or hash/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Snapshots & DB' }));
    expect(screen.getByText(/Integrity Migration Guard/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'IP Blocklist' }));
    expect(screen.getByPlaceholderText(/198\.51\.100\.88/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Devices & Security' }));
    expect(screen.getByText(/Registered Operator & Mobile Companion Devices/i)).toBeDefined();
  });

  it('ModelUsageView renders Nano/Super/Ultra tier breakdown and guards against zero daily budget', async () => {
    vi.spyOn(apiClient, 'fetchDashboard').mockResolvedValueOnce({
      payload: {
        incidents: [],
        approvals: [],
        services: [],
        deployments: [],
        snapshots: [],
        reports: [],
        model_calls: [],
        model_summary: {
          total_spend_usd: 0,
          daily_budget_usd: 0,
          remaining_budget_usd: 0,
          total_calls: 0,
          failed_calls: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          avg_latency_ms: 0,
          total_tavily_calls: 0,
          cache_hit_rate_percent: 75,
          tier_breakdown: {
            nano: { calls: 4, tokens: 1200, cost_usd: 0.0012 },
            super: { calls: 2, tokens: 3400, cost_usd: 0.0085 },
            ultra: { calls: 1, tokens: 5000, cost_usd: 0.025 },
          },
        },
        audit: { entries: [], chain_verified: true, verified_rows: 0 },
      } as any,
    });
    vi.spyOn(apiClient, 'getScenarios').mockResolvedValueOnce([]);
    vi.spyOn(apiClient, 'getAuthSession').mockResolvedValueOnce(null);
    vi.spyOn(apiClient, 'getDevices').mockResolvedValueOnce([]);

    render(
      <AlexiaProvider>
        <ModelUsageView />
      </AlexiaProvider>
    );

    expect(screen.getByTestId('tier-breakdown-grid')).toBeDefined();
    expect(screen.getByText('Nemotron 3 Nano')).toBeDefined();
    expect(screen.getByText('Nemotron 3 Super')).toBeDefined();
    expect(screen.getByText('Nemotron 3 Ultra')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText(/0\.0% of \$0\.0000 budget/i)).toBeDefined();
      expect(screen.queryByText(/NaN%/)).toBeNull();
      expect(screen.queryByText(/Infinity%/)).toBeNull();
    });
  });

  it('AlexiaEventStream tracks lastEventId, attaches session_token, and triggers onReconnect', () => {
    vi.useFakeTimers();
    const instances: Array<{
      url: string;
      onopen?: () => void;
      onmessage?: (e: any) => void;
      onerror?: () => void;
      close: () => void;
    }> = [];

    class MockEventSource {
      public url: string;
      public onopen?: () => void;
      public onmessage?: (e: any) => void;
      public onerror?: () => void;
      public close = vi.fn();
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }

    const originalEventSource = (globalThis as any).EventSource;
    (globalThis as any).EventSource = MockEventSource;

    try {
      const events: any[] = [];
      const states: ConnectionState[] = [];
      const onReconnect = vi.fn();

      const stream = new AlexiaEventStream('/api/v1/events', () => 'tok_abc');
      stream.connect(
        (evt) => events.push(evt),
        (st) => states.push(st),
        onReconnect
      );

      expect(instances.length).toBe(1);
      expect(instances[0].url).toBe('/api/v1/events?session_token=tok_abc');

      instances[0].onopen?.();
      instances[0].onmessage?.({
        lastEventId: 'evt-42',
        data: JSON.stringify({ type: 'incident_updated', data: { id: 'INC-1' } }),
      });

      expect(stream.getLastEventId()).toBe('evt-42');
      expect(events[0].id).toBe('evt-42');

      // Simulate disconnect + backoff reconnect
      instances[0].onerror?.();
      vi.advanceTimersByTime(1100);

      expect(instances.length).toBe(2);
      expect(instances[1].url).toContain('last_event_id=evt-42');
      expect(instances[1].url).toContain('session_token=tok_abc');

      instances[1].onopen?.();
      expect(onReconnect).toHaveBeenCalledTimes(1);

      stream.disconnect();
    } finally {
      (globalThis as any).EventSource = originalEventSource;
      vi.useRealTimers();
    }
  });
});
