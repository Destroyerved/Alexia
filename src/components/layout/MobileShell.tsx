import React, { useState } from 'react';
import {
  LayoutDashboard,
  AlertTriangle,
  CheckSquare,
  Sliders,
  X,
  Server,
  GitCommit,
  FlaskConical,
  ShieldAlert,
  Fingerprint,
  Cpu,
  Settings,
  Shield,
  Menu,
  PlayCircle,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { PerspectiveGrid } from '../effects/PerspectiveGrid';
import { DemoModeBanner } from '../status/DemoModeBanner';
import { MobileControlsModal } from '../mobile/MobileControlsModal';
import { ThemeToggle } from './ThemeToggle';

export interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenControls: () => void;
}

export const MobileDrawer: React.FC<MobileDrawerProps> = ({
  isOpen,
  onClose,
  onOpenControls,
}) => {
  const { currentView, setCurrentView, approvals, incidents, autonomyState } = useAlexia();

  if (!isOpen) return null;

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const openIncidentsCount = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;

  const menuSections = [
    {
      title: 'Monitor',
      items: [
        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
        { id: 'incidents', label: 'Incidents', icon: AlertTriangle, badge: openIncidentsCount, badgeType: 'critical' as const },
        { id: 'approvals', label: 'Approvals', icon: CheckSquare, badge: pendingApprovalsCount, badgeType: 'warning' as const },
      ],
    },
    {
      title: 'Operate',
      items: [
        { id: 'services', label: 'Services', icon: Server },
        { id: 'deployments', label: 'Deployments', icon: GitCommit },
        { id: 'scenarios', label: 'Scenarios', icon: FlaskConical },
      ],
    },
    {
      title: 'Security & Audit',
      items: [
        { id: 'security', label: 'Security Reports', icon: ShieldAlert },
        { id: 'audit', label: 'Audit Log & Snapshots', icon: Fingerprint },
      ],
    },
    {
      title: 'System',
      items: [
        { id: 'usage', label: 'Model Spend & Tokens', icon: Cpu },
        { id: 'settings', label: 'Settings & Kill Switch', icon: Settings },
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex animate-in fade-in duration-200" role="dialog" aria-modal="true" aria-label="Mobile Navigation Menu">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Content */}
      <div
        className="relative w-80 max-w-[85vw] border-r h-full flex flex-col z-10 p-4 shadow-2xl animate-in slide-in-from-left duration-200"
        style={{
          backgroundColor: 'var(--surface-primary)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
          paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
        }}
      >
        {/* Brand Header */}
        <div
          className="flex items-center justify-between pb-3.5 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div
            onClick={() => {
              setCurrentView('overview');
              onClose();
            }}
            className="flex items-center gap-2.5 cursor-pointer"
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{
                backgroundColor: 'var(--accent-muted)',
                border: '1px solid var(--border-highlight)',
                boxShadow: '0 0 10px var(--accent-glow)',
              }}
            >
              <Shield size={18} className="text-[var(--accent-primary)] stroke-[2.2]" />
            </div>
            <div>
              <span className="font-mono font-bold text-sm text-[var(--text-primary)] block leading-tight">Alexia</span>
              <span className="text-[9px] font-mono text-[var(--accent-primary)] tracking-wider uppercase font-semibold">
                Guardian Ops
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Navigation Sections */}
        <div className="flex-1 overflow-y-auto py-3 space-y-4 pr-1">
          {menuSections.map((sec) => (
            <div key={sec.title}>
              <p className="text-[10px] uppercase font-mono font-bold text-[var(--text-muted)] mb-1 px-2 tracking-wider">
                {sec.title}
              </p>
              <div className="space-y-1">
                {sec.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentView === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setCurrentView(item.id);
                        onClose();
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                        isActive
                          ? 'font-semibold'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                      }`}
                      style={
                        isActive
                          ? {
                              backgroundColor: 'var(--surface-hover)',
                              color: 'var(--accent-primary)',
                              border: '1px solid var(--border-highlight)',
                              boxShadow: '0 0 10px -2px var(--accent-glow)',
                            }
                          : { border: '1px solid transparent' }
                      }
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon size={16} className={isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'} />
                        <span>{item.label}</span>
                      </div>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span
                          className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full"
                          style={{
                            backgroundColor:
                              item.badgeType === 'critical'
                                ? 'var(--status-critical-bg)'
                                : 'var(--status-warning-bg)',
                            color:
                              item.badgeType === 'critical'
                                ? 'var(--status-critical)'
                                : 'var(--status-warning)',
                          }}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Drawer Footer Actions */}
        <div
          className="pt-3 border-t space-y-2 mt-auto"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {/* Quick Open Safe Controls */}
          <button
            onClick={() => {
              onClose();
              onOpenControls();
            }}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer transition-colors"
            style={{
              backgroundColor: 'var(--surface-hover)',
              border: '1px solid var(--border-highlight)',
              color: 'var(--accent-primary)',
            }}
          >
            <div className="flex items-center gap-2">
              <Sliders size={15} />
              <span>Catalog Safe Controls</span>
            </div>
            <span
              className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: autonomyState === 'Active' ? 'var(--accent-muted)' : 'var(--status-warning-bg)',
                color: autonomyState === 'Active' ? 'var(--accent-primary)' : 'var(--status-warning)',
              }}
            >
              {autonomyState}
            </span>
          </button>

          {/* Quick Environment status & Theme Switch */}
          <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-[var(--text-secondary)]">
            <span className="font-mono flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
              ShopLite Docker
            </span>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
};

export interface MobileBottomNavProps {
  onOpenControls: () => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ onOpenControls }) => {
  const { currentView, setCurrentView, approvals, incidents } = useAlexia();

  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;
  const activeIncidents = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 border-t flex items-center justify-around px-2 z-40 select-none backdrop-blur-md"
      style={{
        backgroundColor: 'var(--surface-primary)',
        borderColor: 'var(--border-subtle)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        minHeight: 'calc(3.75rem + env(safe-area-inset-bottom, 0px))',
      }}
      aria-label="Mobile Bottom Navigation"
    >
      {/* 1. Home */}
      <button
        onClick={() => setCurrentView('overview')}
        className={`flex flex-col items-center justify-center min-w-[60px] min-h-[48px] rounded-xl transition-all cursor-pointer relative ${
          currentView === 'overview'
            ? 'text-[var(--accent-primary)] font-semibold'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        aria-label="Home"
      >
        <LayoutDashboard size={19} className={currentView === 'overview' ? 'stroke-[2.2]' : ''} />
        <span className="text-[10px] mt-1 font-medium tracking-tight">Home</span>
        {currentView === 'overview' && (
          <span
            className="absolute bottom-1 w-4 h-0.5 rounded-full"
            style={{ backgroundColor: 'var(--accent-primary)' }}
          />
        )}
      </button>

      {/* 2. Incidents */}
      <button
        onClick={() => setCurrentView('incidents')}
        className={`relative flex flex-col items-center justify-center min-w-[60px] min-h-[48px] rounded-xl transition-all cursor-pointer ${
          currentView === 'incidents'
            ? 'text-[var(--accent-primary)] font-semibold'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        aria-label="Incidents"
      >
        <AlertTriangle size={19} className={currentView === 'incidents' ? 'stroke-[2.2]' : ''} />
        {activeIncidents > 0 && (
          <span
            className="absolute top-1 right-2.5 px-1.5 py-0.2 rounded-full text-[9px] font-mono font-bold leading-none"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              color: 'var(--status-critical)',
              border: '1px solid var(--status-critical-border)',
            }}
          >
            {activeIncidents}
          </span>
        )}
        <span className="text-[10px] mt-1 font-medium tracking-tight">Incidents</span>
        {currentView === 'incidents' && (
          <span
            className="absolute bottom-1 w-4 h-0.5 rounded-full"
            style={{ backgroundColor: 'var(--accent-primary)' }}
          />
        )}
      </button>

      {/* 3. Approvals */}
      <button
        onClick={() => setCurrentView('approvals')}
        className={`relative flex flex-col items-center justify-center min-w-[60px] min-h-[48px] rounded-xl transition-all cursor-pointer ${
          currentView === 'approvals'
            ? 'text-[var(--accent-primary)] font-semibold'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        aria-label="Approvals"
      >
        <CheckSquare size={19} className={currentView === 'approvals' ? 'stroke-[2.2]' : ''} />
        {pendingApprovals > 0 && (
          <span
            className="absolute top-1 right-2.5 px-1.5 py-0.2 rounded-full text-[9px] font-mono font-bold leading-none"
            style={{
              backgroundColor: 'var(--status-warning)',
              color: '#050806',
            }}
          >
            {pendingApprovals}
          </span>
        )}
        <span className="text-[10px] mt-1 font-medium tracking-tight">Approvals</span>
        {currentView === 'approvals' && (
          <span
            className="absolute bottom-1 w-4 h-0.5 rounded-full"
            style={{ backgroundColor: 'var(--accent-primary)' }}
          />
        )}
      </button>

      {/* 4. Controls / More */}
      <button
        onClick={onOpenControls}
        className="flex flex-col items-center justify-center min-w-[60px] min-h-[48px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-all cursor-pointer"
        aria-label="Safe Controls and Actions"
      >
        <Sliders size={19} />
        <span className="text-[10px] mt-1 font-medium tracking-tight">Controls</span>
      </button>
    </nav>
  );
};

export const MobileShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentView, setCurrentView, autonomyState } = useAlexia();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  return (
    <div
      className="min-h-screen flex flex-col relative text-[var(--text-primary)] overflow-x-hidden"
      style={{
        backgroundColor: 'var(--bg-main)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Perspective Grid Background Layer - reduced intensity & non-interactive on mobile */}
      <div
        className="fixed inset-0 pointer-events-none opacity-30 select-none z-0 overflow-hidden"
        aria-hidden="true"
      >
        <PerspectiveGrid />
      </div>

      {/* Content Layer (Rendered above grid) */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Demo Mode Notice Banner */}
        <DemoModeBanner />

        {/* Compact Mobile Header */}
        <header
          className="sticky top-0 z-30 border-b backdrop-blur-md flex items-center justify-between px-3 sm:px-4 h-14"
          style={{
            backgroundColor: 'var(--surface-primary)',
            borderColor: 'var(--border-subtle)',
            paddingTop: 'env(safe-area-inset-top, 0px)',
          }}
        >
          {/* Left: Hamburger menu + Brand Logo */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setDrawerOpen(true)}
              className="p-1.5 -ml-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
              aria-label="Open navigation menu"
            >
              <Menu size={20} />
            </button>

            <div
              onClick={() => setCurrentView('overview')}
              className="flex items-center gap-2 cursor-pointer select-none"
            >
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: 'var(--accent-muted)',
                  border: '1px solid var(--border-highlight)',
                  boxShadow: '0 0 10px var(--accent-glow)',
                }}
              >
                <Shield size={16} className="text-[var(--accent-primary)] stroke-[2.2]" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-sm tracking-tight text-[var(--text-primary)]">
                  Alexia
                </span>
                <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded font-mono text-[var(--accent-primary)] bg-[var(--accent-muted)] border border-[var(--border-highlight)]">
                  Guardian
                </span>
              </div>
            </div>
          </div>

          {/* Right: Quick Autonomy Pill + Scenario action + ThemeToggle */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Quick Autonomy Status Pill */}
            <button
              onClick={() => setControlsOpen(true)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-mono font-semibold border cursor-pointer transition-colors"
              style={{
                backgroundColor: autonomyState === 'Active' ? 'var(--accent-muted)' : 'var(--status-warning-bg)',
                borderColor: autonomyState === 'Active' ? 'var(--border-highlight)' : 'var(--status-warning-border)',
                color: autonomyState === 'Active' ? 'var(--accent-primary)' : 'var(--status-warning)',
              }}
              title={`Guardian Autonomy: ${autonomyState}. Tap to open controls.`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  autonomyState === 'Active'
                    ? 'bg-[var(--accent-primary)] animate-pulse'
                    : 'bg-[var(--status-warning)]'
                }`}
              />
              <span>{autonomyState}</span>
            </button>

            {/* Quick Run Scenario Icon Button */}
            <button
              onClick={() => setCurrentView('scenarios')}
              className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
              title="Run Demo Scenarios"
              aria-label="Run Scenarios"
            >
              <PlayCircle size={18} />
            </button>

            {/* Theme Toggle */}
            <ThemeToggle />
          </div>
        </header>

        {/* Main Content Area - Touch-friendly, avoids horizontal overflow */}
        <main className="flex-1 w-full px-3.5 sm:px-6 py-5 pb-28 relative z-10 overflow-x-hidden max-w-full">
          {children}
        </main>

        {/* Clean Mobile App Footer */}
        <footer
          className="border-t py-4 mb-16 text-center text-[10px] text-[var(--text-muted)] font-mono"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--surface-primary)',
          }}
        >
          <div>Alexia DevSecOps Guardian • Protected Sandbox</div>
          <div className="text-[9px] mt-0.5 text-[var(--text-secondary)] opacity-80">
            Autonomous Multi-Agent Security Operations
          </div>
        </footer>

        {/* Fixed Mobile Bottom Navigation */}
        <MobileBottomNav onOpenControls={() => setControlsOpen(true)} />

        {/* Slide-out Mobile Navigation Drawer */}
        <MobileDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onOpenControls={() => {
            setDrawerOpen(false);
            setControlsOpen(true);
          }}
        />

        {/* Catalog Safe Controls Modal */}
        <MobileControlsModal
          isOpen={controlsOpen}
          onClose={() => setControlsOpen(false)}
        />
      </div>
    </div>
  );
};
