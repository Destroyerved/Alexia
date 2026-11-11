import React from 'react';
import {
  LayoutDashboard,
  AlertTriangle,
  CheckSquare,
  Server,
  GitCommit,
  FlaskConical,
  ShieldAlert,
  Fingerprint,
  Cpu,
  Settings,
  Shield,
  ChevronLeft,
  ChevronRight,
  Activity,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';

interface SidebarProps {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ collapsed, setCollapsed }) => {
  const { currentView, setCurrentView, approvals, incidents } = useAlexia();

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const openIncidentsCount = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;

  const navGroups = [
    {
      group: 'Monitor',
      items: [
        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
        { id: 'incidents', label: 'Incidents', icon: AlertTriangle, badge: openIncidentsCount, badgeType: 'critical' as const },
        { id: 'approvals', label: 'Approvals', icon: CheckSquare, badge: pendingApprovalsCount, badgeType: 'warning' as const },
      ],
    },
    {
      group: 'Operate',
      items: [
        { id: 'services', label: 'Services', icon: Server },
        { id: 'deployments', label: 'Deployments', icon: GitCommit },
        { id: 'scenarios', label: 'Scenarios', icon: FlaskConical },
      ],
    },
    {
      group: 'Security',
      items: [
        { id: 'security', label: 'Security & Reports', icon: ShieldAlert },
        { id: 'audit', label: 'Audit Log', icon: Fingerprint },
      ],
    },
    {
      group: 'System',
      items: [
        { id: 'usage', label: 'Model Usage', icon: Cpu },
        { id: 'settings', label: 'Settings', icon: Settings },
      ],
    },
  ];

  return (
    <aside
      className={`hidden lg:flex flex-col border-r transition-all duration-200 z-30 select-none ${
        collapsed ? 'w-[72px]' : 'w-[250px]'
      }`}
      style={{
        backgroundColor: 'var(--surface-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Brand Header */}
      <div
        className="h-16 flex items-center justify-between px-4 border-b shrink-0"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div
          onClick={() => setCurrentView('overview')}
          className="flex items-center gap-3 overflow-hidden cursor-pointer group"
          title="Alexia DevSecOps Guardian"
        >
          {/* Luminous brand mark inspired by SecureGuard reference */}
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105"
            style={{
              backgroundColor: 'var(--accent-muted)',
              border: '1px solid var(--border-highlight)',
              boxShadow: '0 0 16px -2px var(--accent-glow)',
            }}
          >
            <Shield size={20} className="text-[var(--accent-primary)] stroke-[2.2]" />
          </div>

          {!collapsed && (
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-bold tracking-tight font-mono text-[var(--text-primary)]">
                ALEXIA
              </span>
              <span className="text-[9px] font-semibold text-[var(--accent-primary)] tracking-widest uppercase font-mono">
                GUARDIAN OPS
              </span>
            </div>
          )}
        </div>

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* Navigation Groups */}
      <div className="flex-1 overflow-y-auto py-4 px-2 space-y-5">
        {navGroups.map((group) => (
          <div key={group.group} className="space-y-1">
            {!collapsed && (
              <h4 className="px-3 text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1 font-mono">
                {group.group}
              </h4>
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = currentView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer relative ${
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
                          boxShadow: '0 0 12px -2px var(--accent-glow)',
                        }
                      : { border: '1px solid transparent' }
                  }
                  title={collapsed ? item.label : undefined}
                >
                  {/* Active Indicator bar */}
                  {isActive && (
                    <span
                      className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full"
                      style={{
                        backgroundColor: 'var(--accent-primary)',
                        boxShadow: '0 0 8px var(--accent-primary)',
                      }}
                    />
                  )}

                  <Icon
                    size={18}
                    className={isActive ? 'text-[var(--accent-primary)] stroke-[2.2]' : 'text-[var(--text-secondary)]'}
                  />

                  {!collapsed && (
                    <span className="flex-1 text-left truncate">{item.label}</span>
                  )}

                  {item.badge !== undefined && item.badge > 0 && (
                    <span
                      className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded-full shrink-0 border"
                      style={{
                        backgroundColor:
                          item.badgeType === 'critical'
                            ? 'var(--status-critical-bg)'
                            : 'var(--status-warning-bg)',
                        color:
                          item.badgeType === 'critical'
                            ? 'var(--status-critical)'
                            : 'var(--status-warning)',
                        borderColor:
                          item.badgeType === 'critical'
                            ? 'var(--status-critical-border)'
                            : 'var(--status-warning-border)',
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Target Stack / Live Status Footer */}
      {!collapsed && (
        <div
          className="p-3.5 border-t shrink-0 m-2 rounded-xl"
          style={{
            backgroundColor: 'var(--surface-card)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="text-[var(--text-secondary)]">Environment</span>
            <span className="text-[var(--accent-primary)] font-mono font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
              ShopLite Docker
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] font-mono">
            <span>Fleet Architecture</span>
            <span className="text-[var(--text-secondary)]">5 Agents Active</span>
          </div>
        </div>
      )}
    </aside>
  );
};
