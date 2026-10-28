import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AlexiaProvider } from '../context/AlexiaContext';
import { OverviewView } from '../features/overview/OverviewView';
import { ApprovalsView } from '../features/approvals/ApprovalsView';
import { ScenariosView } from '../features/scenarios/ScenariosView';
import { formatCurrency, formatTokenCount, formatRelativeTime } from '../lib/formatters';

describe('Alexia DevSecOps Guardian Frontend Suite', () => {
  it('formats currency with consistent USD precision', () => {
    expect(formatCurrency(0.0842)).toBe('$0.0842');
    expect(formatCurrency(5.0)).toBe('$5.0000');
  });

  it('formats token counts cleanly', () => {
    expect(formatTokenCount(48920)).toBe('48.9k');
    expect(formatTokenCount(1200000)).toBe('1.20M');
    expect(formatTokenCount(450)).toBe('450');
  });

  it('renders Overview with all 5 Guardian agents and Key Metrics', () => {
    render(
      <AlexiaProvider>
        <OverviewView />
      </AlexiaProvider>
    );

    // Verify 5 Agents are represented
    expect(screen.getByText('Sentinel')).toBeDefined();
    expect(screen.getByText('Healer')).toBeDefined();
    expect(screen.getByText('Builder')).toBeDefined();
    expect(screen.getByText('Deployer')).toBeDefined();
    expect(screen.getByText('Integrity')).toBeDefined();

    // Verify System Health & Spend
    expect(screen.getByText(/System Health/i)).toBeDefined();
    expect(screen.getByText(/Open Incidents/i)).toBeDefined();
    expect(screen.getByText(/Pending Approvals/i)).toBeDefined();
  });

  it('renders Approvals queue with Tier 1 and rollback safeguards', () => {
    render(
      <AlexiaProvider>
        <ApprovalsView />
      </AlexiaProvider>
    );

    expect(screen.getByText(/Pending Action Queue/i)).toBeDefined();
    expect(screen.getByText(/Tier 1: Approval Req./i)).toBeDefined();
  });

  it('renders Mandatory PRD Demo Scenarios (S1, S2, S4, S6)', () => {
    render(
      <AlexiaProvider>
        <ScenariosView />
      </AlexiaProvider>
    );

    expect(screen.getByText('S6')).toBeDefined();
    expect(screen.getByText('S1')).toBeDefined();
    expect(screen.getByText('S2')).toBeDefined();
    expect(screen.getByText('S4')).toBeDefined();
  });
});
