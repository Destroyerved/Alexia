import React, { useState, useRef, useEffect } from 'react';
import {
  Shield,
  ChevronDown,
  Menu,
  X,
  PlayCircle,
  CheckSquare,
  FlaskConical,
  Cpu,
  Settings,
  Fingerprint,
  Bell,
  UserCheck,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { ThemeToggle } from './ThemeToggle';
import { AutonomyStatus } from '../status/AutonomyStatus';
import { ConnectionIndicator } from '../status/ConnectionIndicator';
import { formatRelativeTime } from '../../lib/formatters';

export const TopNavbar: React.FC = () => {
  const {
    currentView,
    setCurrentView,
    incidents,
    approvals,
    connectionState,
    notifications,
    markNotificationRead,
    clearNotifications,
    openAuthModal,
    sessionInfo,
  } = useAlexia();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  const openIncidentsCount = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;
  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const unreadNotifsCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const primaryNavItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'incidents', label: 'Incidents', badge: openIncidentsCount },
    { id: 'approvals', label: 'Approvals', badge: pendingApprovalsCount },
    { id: 'services', label: 'Services' },
    { id: 'security', label: 'Security' },
  ];

  const moreNavItems = [
    { id: 'scenarios', label: 'Scenarios', icon: FlaskConical },
    { id: 'usage', label: 'Model Usage', icon: Cpu },
    { id: 'audit', label: 'Audit Log', icon: Fingerprint },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const isMoreActive = moreNavItems.some((item) => item.id === currentView);

  return (
    <nav
      className="sticky top-0 z-40 border-b backdrop-blur-md"
      style={{
        backgroundColor: 'var(--surface-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Brand Logo & Name */}
          <div
            onClick={() => setCurrentView('overview')}
            className="flex items-center gap-2.5 cursor-pointer group shrink-0"
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{
                backgroundColor: 'var(--accent-muted)',
                color: 'var(--accent-primary)',
                border: '1px solid var(--border-highlight)',
              }}
            >
              <Shield size={18} className="stroke-[2.2]" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-base text-[var(--text-primary)] tracking-tight">
                Alexia
              </span>
              <span className="text-xs font-semibold text-[var(--accent-primary)] hidden sm:inline">
                Guardian
              </span>
            </div>
          </div>

          {/* Desktop Navigation Links */}
          <div className="hidden lg:flex items-center gap-6">
            {primaryNavItems.map((item) => {
              const isActive = currentView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentView(item.id)}
                  className={`relative py-1 text-sm font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'text-[var(--accent-primary)] font-semibold'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {item.label}
                    {item.badge !== undefined && item.badge > 0 && (
                      <span
                        className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold"
                        style={{
                          backgroundColor:
                            item.id === 'approvals' ? 'var(--status-warning-bg)' : 'var(--status-critical-bg)',
                          color:
                            item.id === 'approvals' ? 'var(--status-warning)' : 'var(--status-critical)',
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {isActive && (
                    <span
                      className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                      style={{ backgroundColor: 'var(--accent-primary)' }}
                    />
                  )}
                </button>
              );
            })}

            {/* "More" Dropdown */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                className={`flex items-center gap-1 py-1 text-sm font-medium transition-colors cursor-pointer ${
                  isMoreActive
                    ? 'text-[var(--accent-primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>More</span>
                <ChevronDown size={14} className={`transition-transform duration-150 ${moreMenuOpen ? 'rotate-180' : ''}`} />
                {isMoreActive && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                  />
                )}
              </button>

              {moreMenuOpen && (
                <div
                  className="absolute right-0 mt-2 w-48 py-1.5 rounded-xl border shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100"
                  style={{
                    backgroundColor: 'var(--surface-primary)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  {moreNavItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentView === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setCurrentView(item.id);
                          setMoreMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3.5 py-2 text-xs text-left transition-colors cursor-pointer ${
                          isActive
                            ? 'text-[var(--accent-primary)] font-semibold bg-[var(--surface-hover)]'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <Icon size={15} />
                          <span>{item.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Live Connection, Autonomy Switch, Notifications, Auth, Theme & Run Scenario */}
          <div className="flex items-center gap-2 sm:gap-2.5">
            <div className="hidden xl:block">
              <ConnectionIndicator state={connectionState} />
            </div>

            <div className="hidden md:block">
              <AutonomyStatus />
            </div>

            {/* Notification Bell */}
            <div className="relative" ref={notifRef}>
              <button
                type="button"
                onClick={() => setNotifOpen(!notifOpen)}
                className="relative p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                aria-label="Notifications"
                title="Alerts & Notifications"
              >
                <Bell size={17} />
                {unreadNotifsCount > 0 && (
                  <span
                    className="absolute top-1 right-1 w-4 h-4 rounded-full text-[9px] font-mono font-bold flex items-center justify-center"
                    style={{
                      backgroundColor: 'var(--status-critical)',
                      color: '#fff',
                    }}
                  >
                    {unreadNotifsCount > 9 ? '9+' : unreadNotifsCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div
                  className="absolute right-0 mt-2 w-80 rounded-xl border shadow-2xl z-50 overflow-hidden"
                  style={{
                    backgroundColor: 'var(--surface-primary)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--text-primary)]">Guardian Alerts</span>
                    {unreadNotifsCount > 0 && (
                      <button
                        type="button"
                        onClick={clearNotifications}
                        className="text-[11px] text-[var(--accent-primary)] hover:underline cursor-pointer"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-[var(--border-subtle)]">
                    {notifications.length === 0 ? (
                      <div className="p-5 text-center text-xs text-[var(--text-muted)]">
                        No recent alerts.
                      </div>
                    ) : (
                      notifications.slice(0, 12).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            markNotificationRead(n.id);
                            if (n.link_to) setCurrentView(n.link_to);
                            setNotifOpen(false);
                          }}
                          className={`w-full text-left p-3 text-xs hover:bg-[var(--surface-hover)] transition-colors cursor-pointer ${
                            n.read ? 'opacity-70' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <span className="font-semibold text-[var(--text-primary)] truncate">{n.title}</span>
                            <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">
                              {formatRelativeTime(n.timestamp)}
                            </span>
                          </div>
                          <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2">{n.description}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Operator Session / Passkey Button */}
            <button
              type="button"
              onClick={openAuthModal}
              className="p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--accent-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
              title={
                sessionInfo?.username && sessionInfo.username !== 'local_operator'
                  ? `Signed in: ${sessionInfo.username}`
                  : 'Operator Sign-In & Passkeys'
              }
              aria-label="Operator Authentication"
            >
              <UserCheck size={17} />
            </button>

            <ThemeToggle />

            <button
              onClick={() => setCurrentView('scenarios')}
              className="web-btn-primary hidden sm:inline-flex"
            >
              <PlayCircle size={15} />
              <span>Run Scenario</span>
            </button>

            {/* Mobile Hamburger Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </div>

      {/* Tablet / Compact Dropdown Drawer */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden border-t px-4 pt-3 pb-5 space-y-1 animate-in slide-in-from-top-2 duration-150"
          style={{
            backgroundColor: 'var(--surface-primary)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="pb-2 flex items-center justify-between">
            <ConnectionIndicator state={connectionState} />
            <AutonomyStatus />
          </div>
          <div className="space-y-1">
            {[...primaryNavItems, ...moreNavItems].map((item) => {
              const isActive = currentView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setCurrentView(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-[var(--accent-primary)] font-semibold bg-[var(--surface-hover)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span>{item.label}</span>
                  {'badge' in item && item.badge !== undefined && item.badge > 0 && (
                    <span
                      className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold"
                      style={{
                        backgroundColor: 'var(--status-critical-bg)',
                        color: 'var(--status-critical)',
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="pt-3 border-t border-[var(--border-subtle)] mt-3">
            <button
              onClick={() => {
                setCurrentView('scenarios');
                setMobileMenuOpen(false);
              }}
              className="web-btn-primary w-full py-2.5"
            >
              <PlayCircle size={15} />
              <span>Run Scenario</span>
            </button>
          </div>
        </div>
      )}
    </nav>
  );
};
