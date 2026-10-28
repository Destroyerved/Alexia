import React, { useState, useRef, useEffect } from 'react';
import {
  Bell,
  Box,
  Clock,
  Menu,
  X,
  CheckCheck,
  ChevronDown,
  Shield,
  Search,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { ConnectionIndicator } from '../status/ConnectionIndicator';
import { AutonomyStatus } from '../status/AutonomyStatus';
import { ThemeToggle } from './ThemeToggle';
import { formatRelativeTime } from '../../lib/formatters';

interface TopBarProps {
  onOpenMobileMenu: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onOpenMobileMenu }) => {
  const {
    currentView,
    environment,
    setEnvironment,
    connectionState,
    lastUpdated,
    notifications,
    markNotificationRead,
    clearNotifications,
    setCurrentView,
  } = useAlexia();

  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const notifRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const viewTitles: Record<string, { title: string; subtitle: string }> = {
    overview: { title: 'Overview', subtitle: 'Autonomous DevSecOps monitoring active' },
    incidents: { title: 'Incidents & Forensics', subtitle: 'Real-time telemetry, diagnosis & verification' },
    approvals: { title: 'Action Approvals', subtitle: 'Tier 1 Human-in-the-loop authorization gates' },
    services: { title: 'Services & Containers', subtitle: 'Docker container telemetry & rollback gates' },
    deployments: { title: 'Deployments Pipeline', subtitle: 'Pre-deploy gates and blue/green rollbacks' },
    scenarios: { title: 'Scenario Launcher', subtitle: 'Judge-ready fault injection & remediation benchmarks' },
    security: { title: 'Security & Compliance', subtitle: 'Automated compliance reports & audit ledger' },
    audit: { title: 'Audit Ledger', subtitle: 'Cryptographic SHA-256 tamper-evident event log' },
    usage: { title: 'Model Cost Intelligence', subtitle: 'Token spend, multi-tier economics & latency telemetry' },
    settings: { title: 'Guardian Settings', subtitle: 'Autonomous kill switch & safety policies' },
  };

  const activeHeader = viewTitles[currentView] || { title: currentView, subtitle: 'Command Center' };

  return (
    <header
      className="h-16 border-b px-4 lg:px-6 flex items-center justify-between z-20 shrink-0"
      style={{
        backgroundColor: 'var(--surface-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Left: Mobile trigger & Page Title */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          title="Open mobile menu"
          aria-label="Open navigation menu"
        >
          <Menu size={20} />
        </button>

        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold font-mono tracking-tight text-[var(--text-primary)]">
              {activeHeader.title}
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--surface-card)] text-[var(--text-muted)] border border-[var(--border-subtle)] hidden sm:inline">
              LIVE
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-secondary)] hidden md:block truncate max-w-sm">
            {activeHeader.subtitle}
          </span>
        </div>
      </div>

      {/* Middle: Environment Selector */}
      <div className="hidden lg:flex items-center gap-2 bg-[var(--surface-card)] border border-[var(--border-subtle)] rounded-xl px-3 py-1.5 text-xs">
        <Box size={14} className="text-[var(--accent-primary)]" />
        <span className="text-[var(--text-muted)] font-mono text-[11px]">Env:</span>
        <select
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          className="bg-transparent text-[var(--text-primary)] font-medium font-mono text-xs focus:outline-none cursor-pointer"
        >
          <option value="Sandbox (ShopLite Docker)" style={{ backgroundColor: 'var(--surface-primary)', color: 'var(--text-primary)' }}>
            Sandbox (ShopLite Docker)
          </option>
          <option value="Staging (Isolated Cluster)" style={{ backgroundColor: 'var(--surface-primary)', color: 'var(--text-primary)' }}>
            Staging (Isolated Cluster)
          </option>
        </select>
      </div>

      {/* Right: Autonomy Switch, Connection, Theme, Notifications, Profile */}
      <div className="flex items-center gap-2.5">
        {/* Global Safety Autonomy Switch */}
        <AutonomyStatus />

        {/* Connection State */}
        <div className="hidden sm:block">
          <ConnectionIndicator state={connectionState} />
        </div>

        {/* Theme Toggle Button */}
        <ThemeToggle />

        {/* Notification Bell */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)] transition-colors cursor-pointer"
            title="System alerts & notifications"
            aria-label="System notifications"
          >
            <Bell size={17} />
            {unreadCount > 0 && (
              <span
                className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full animate-pulse"
                style={{
                  backgroundColor: 'var(--status-critical)',
                  boxShadow: '0 0 6px var(--status-critical)',
                }}
              />
            )}
          </button>

          {/* Notifications Flyout */}
          {showNotifications && (
            <div
              className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border shadow-2xl p-4 z-50 animate-in fade-in zoom-in-95 duration-100"
              style={{
                backgroundColor: 'var(--surface-primary)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div
                className="flex items-center justify-between pb-3 border-b"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">System Alerts</span>
                  {unreadCount > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold"
                      style={{
                        backgroundColor: 'var(--status-critical-bg)',
                        color: 'var(--status-critical)',
                      }}
                    >
                      {unreadCount} unread
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={clearNotifications}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                  >
                    <CheckCheck size={12} /> Clear all
                  </button>
                  <button
                    onClick={() => setShowNotifications(false)}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                    aria-label="Close notifications"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>

              <div className="py-2 space-y-2 max-h-72 overflow-y-auto">
                {notifications.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)] py-6 text-center">
                    No active notifications
                  </p>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => {
                        markNotificationRead(n.id);
                        if (n.link_to) {
                          setCurrentView(n.link_to);
                          setShowNotifications(false);
                        }
                      }}
                      className="p-3 rounded-xl cursor-pointer transition-colors border"
                      style={{
                        backgroundColor: n.read ? 'var(--surface-card)' : 'var(--surface-hover)',
                        borderColor: n.read ? 'var(--border-subtle)' : 'var(--border-highlight)',
                        opacity: n.read ? 0.7 : 1,
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{n.title}</span>
                        <span className="text-[10px] text-[var(--text-muted)] font-mono">
                          {formatRelativeTime(n.timestamp)}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] line-clamp-2">{n.description}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Demo User Badge */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-[var(--surface-hover)] transition-colors border border-[var(--border-subtle)] cursor-pointer"
            aria-label="User profile menu"
          >
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-xs"
              style={{
                backgroundColor: 'var(--accent-muted)',
                color: 'var(--accent-primary)',
                border: '1px solid var(--border-highlight)',
              }}
            >
              OP
            </div>
            <div className="hidden md:flex flex-col text-left">
              <span className="text-xs font-semibold text-[var(--text-primary)]">demo@alexia.local</span>
              <span className="text-[9px] text-[var(--text-muted)] font-mono uppercase">Lead Operator</span>
            </div>
            <ChevronDown size={14} className="text-[var(--text-muted)] hidden md:block" />
          </button>

          {showUserMenu && (
            <div
              className="absolute right-0 mt-2 w-52 rounded-xl border shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-100"
              style={{
                backgroundColor: 'var(--surface-primary)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="px-3 py-2 border-b border-[var(--border-subtle)] mb-1">
                <p className="text-xs font-semibold text-[var(--text-primary)]">Demonstration Session</p>
                <p className="text-[10px] text-[var(--text-muted)] font-mono">Role: Super Operator</p>
              </div>
              <button
                onClick={() => {
                  setCurrentView('settings');
                  setShowUserMenu(false);
                }}
                className="w-full text-left px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors cursor-pointer"
              >
                Guardian Settings
              </button>
              <button
                onClick={() => {
                  setCurrentView('audit');
                  setShowUserMenu(false);
                }}
                className="w-full text-left px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] rounded-lg transition-colors cursor-pointer"
              >
                Audit Signature Keys
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
