import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AlexiaProvider } from '../context/AlexiaContext';
import { ThemeProvider } from '../context/ThemeContext';
import { MobileShell, MobileBottomNav, MobileDrawer } from '../components/layout/MobileShell';
import { MobileControlsModal } from '../components/mobile/MobileControlsModal';

describe('Alexia Mobile Experience Suite', () => {
  it('renders MobileBottomNav with Home, Incidents, Approvals, and Controls', () => {
    const handleOpenControls = vi.fn();

    render(
      <AlexiaProvider>
        <MobileBottomNav onOpenControls={handleOpenControls} />
      </AlexiaProvider>
    );

    // Verify all 4 bottom tabs
    expect(screen.getByRole('button', { name: /home/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /incidents/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /approvals/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /controls/i })).toBeDefined();

    // Verify clicking controls calls onOpenControls
    const controlsBtn = screen.getByRole('button', { name: /controls/i });
    fireEvent.click(controlsBtn);
    expect(handleOpenControls).toHaveBeenCalledTimes(1);
  });

  it('renders MobileDrawer with full feature navigation and drawer actions', () => {
    const handleClose = vi.fn();
    const handleOpenControls = vi.fn();

    const { rerender } = render(
      <AlexiaProvider>
        <MobileDrawer isOpen={false} onClose={handleClose} onOpenControls={handleOpenControls} />
      </AlexiaProvider>
    );

    // Should not be visible when closed
    expect(screen.queryByText('Alexia')).toBeNull();

    // Open drawer
    rerender(
      <AlexiaProvider>
        <MobileDrawer isOpen={true} onClose={handleClose} onOpenControls={handleOpenControls} />
      </AlexiaProvider>
    );

    // Verify sections and items
    expect(screen.getByText('Alexia')).toBeDefined();
    expect(screen.getByText('Guardian Ops')).toBeDefined();
    expect(screen.getByText('Services')).toBeDefined();
    expect(screen.getByText('Deployments')).toBeDefined();
    expect(screen.getByText('Scenarios')).toBeDefined();
    expect(screen.getByText('Security Reports')).toBeDefined();
    expect(screen.getByText('Audit Log & Snapshots')).toBeDefined();
    expect(screen.getByText('Model Spend & Tokens')).toBeDefined();
    expect(screen.getByText('Settings & Kill Switch')).toBeDefined();

    // Clicking Safe Controls button
    const safeControlsBtn = screen.getByText('Catalog Safe Controls');
    fireEvent.click(safeControlsBtn);
    expect(handleClose).toHaveBeenCalled();
    expect(handleOpenControls).toHaveBeenCalled();
  });

  it('renders MobileControlsModal and executes catalog safe actions', async () => {
    const handleClose = vi.fn();

    render(
      <AlexiaProvider>
        <MobileControlsModal isOpen={true} onClose={handleClose} />
      </AlexiaProvider>
    );

    expect(screen.getByText('Catalog Safe Controls')).toBeDefined();
    expect(screen.getByText(/Pause Guardian Autonomy/i)).toBeDefined();
    expect(screen.getByText(/Roll Back shoplite-api/i)).toBeDefined();
    expect(screen.getByText(/Take Instant DB Snapshot/i)).toBeDefined();
    expect(screen.getByText(/Run Hash-Chain Verification/i)).toBeDefined();

    // Test toggle autonomy
    const autonomyBtn = screen.getByText(/Pause Guardian Autonomy/i);
    fireEvent.click(autonomyBtn);
    await waitFor(() => {
      expect(screen.getByText(/Resume Guardian Autonomy/i)).toBeDefined();
    });

    // Test close
    const closeBtn = screen.getByLabelText(/close controls modal/i);
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('renders MobileShell wrapping content with header and bottom nav', () => {
    render(
      <ThemeProvider>
        <AlexiaProvider>
          <MobileShell>
            <div data-testid="mobile-content">Test Mobile View Content</div>
          </MobileShell>
        </AlexiaProvider>
      </ThemeProvider>
    );

    // Content is rendered
    expect(screen.getByTestId('mobile-content')).toBeDefined();
    expect(screen.getByText('Test Mobile View Content')).toBeDefined();

    // Header branding & buttons are present
    expect(screen.getByText('Alexia')).toBeDefined();
    expect(screen.getByText('Guardian')).toBeDefined();
    expect(screen.getByLabelText('Open navigation menu')).toBeDefined();
    expect(screen.getByLabelText('Run Scenarios')).toBeDefined();

    // Bottom nav is present
    expect(screen.getByLabelText('Mobile Bottom Navigation')).toBeDefined();
  });
});
