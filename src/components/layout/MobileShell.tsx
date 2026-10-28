import React from 'react';
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
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenControls: () => void;
}

export const MobileDrawer: React.FC<MobileDrawerProps> = ({ isOpen, onClose }) => {
  const { currentView, setCurrentView, approvals, incidents } = useAlexia();

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
        { id: 'incidents', label: 'Incidents', icon: AlertTriangle, badge: openIncidentsCount, badgeType: 'critical' },
        { id: 'approvals', label: 'Approvals', icon: CheckSquare, badge: pendingApprovalsCount, badgeType: 'warning' },
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
    <div className="fixed inset-0 z-50 lg:hidden flex animate-in fade-in duration-200">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Content */}
      <div
        className="relative w-72 max-w-[80vw] border-r h-full flex flex-col z-10 p-4 shadow-2xl animate-in slide-in-from-left duration-200"
        style={{
          backgroundColor: 'var(--surface-primary)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      >
        <div
          className="flex items-center justify-between pb-4 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2.5">
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
              <span className="font-mono font-bold text-sm text-[var(--text-primary)] block">Alexia</span>
              <span className="text-[9px] font-mono text-[var(--accent-primary)] tracking-wider uppercase font-semibold">
                Guardian Ops
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4 space-y-5">
          {menuSections.map((sec) => (
            <div key={sec.title}>
              <p className="text-[10px] uppercase font-mono font-bold text-[var(--text-muted)] mb-1.5 px-2 tracking-wider">
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
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
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
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
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
      </div>
    </div>
  );
};

export const MobileBottomNav: React.FC<{ onOpenControls: () => void }> = ({ onOpenControls }) => {
  const { currentView, setCurrentView, approvals, incidents } = useAlexia();

  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;
  const activeIncidents = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;

  return (
    <nav
      className="lg:hidden fixed bottom-0 left-0 right-0 h-16 border-t flex items-center justify-around px-2 z-40 select-none backdrop-blur-md"
      style={{
        backgroundColor: 'var(--surface-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <button
        onClick={() => setCurrentView('overview')}
        className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-colors cursor-pointer"
        style={{
          color: currentView === 'overview' ? 'var(--accent-primary)' : 'var(--text-secondary)',
        }}
      >
        <LayoutDashboard size={18} />
        <span className="text-[10px] mt-1 font-medium">Home</span>
      </button>

      <button
        onClick={() => setCurrentView('incidents')}
        className="relative flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-colors cursor-pointer"
        style={{
          color: currentView === 'incidents' ? 'var(--accent-primary)' : 'var(--text-secondary)',
        }}
      >
        <AlertTriangle size={18} />
        {activeIncidents > 0 && (
          <span
            className="absolute top-1 right-2 w-2 h-2 rounded-full"
            style={{ backgroundColor: 'var(--status-critical)' }}
          />
        )}
        <span className="text-[10px] mt-1 font-medium">Incidents</span>
      </button>

      <button
        onClick={() => setCurrentView('approvals')}
        className="relative flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-colors cursor-pointer"
        style={{
          color: currentView === 'approvals' ? 'var(--accent-primary)' : 'var(--text-secondary)',
        }}
      >
        <CheckSquare size={18} />
        {pendingApprovals > 0 && (
          <span
            className="absolute top-1 right-2 px-1 py-0.2 rounded-full text-[9px] font-bold"
            style={{
              backgroundColor: 'var(--status-warning)',
              color: '#050806',
            }}
          >
            {pendingApprovals}
          </span>
        )}
        <span className="text-[10px] mt-1 font-medium">Approvals</span>
      </button>

      <button
        onClick={onOpenControls}
        className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl text-[var(--text-secondary)] hover:text-[var(--accent-primary)] transition-colors cursor-pointer"
      >
        <Sliders size={18} />
        <span className="text-[10px] mt-1 font-medium">Controls</span>
      </button>
    </nav>
  );
};
