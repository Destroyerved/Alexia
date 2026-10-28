import React, { useState, useRef, useEffect } from 'react';
import {
  Shield,
  ChevronDown,
  Menu,
  X,
  PlayCircle,
  AlertTriangle,
  CheckSquare,
  Server,
  ShieldCheck,
  FlaskConical,
  Cpu,
  Settings,
  Fingerprint,
} from 'lucide-react';
import { useAlexia } from '../../context/AlexiaContext';
import { ThemeToggle } from './ThemeToggle';

export const TopNavbar: React.FC = () => {
  const { currentView, setCurrentView, incidents, approvals } = useAlexia();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const openIncidentsCount = incidents.filter(
    (i) => i.status !== 'resolved' && i.status !== 'escalated'
  ).length;
  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const primaryNavItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'incidents', label: 'Incidents', badge: openIncidentsCount },
    { id: 'services', label: 'Services' },
    { id: 'security', label: 'Security' },
  ];

  const moreNavItems = [
    { id: 'approvals', label: 'Approvals', icon: CheckSquare, badge: pendingApprovalsCount },
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
            className="flex items-center gap-2.5 cursor-pointer group"
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

          {/* Desktop Navigation Links (Clean website style matching reference) */}
          <div className="hidden md:flex items-center gap-7">
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
                          backgroundColor: 'var(--status-critical-bg)',
                          color: 'var(--status-critical)',
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {/* Clean green active indicator underline like the reference site */}
                  {isActive && (
                    <span
                      className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                      style={{ backgroundColor: 'var(--accent-primary)' }}
                    />
                  )}
                </button>
              );
            })}

            {/* "More" Dropdown for secondary pages */}
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
                {pendingApprovalsCount > 0 && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: 'var(--status-warning)' }}
                  />
                )}
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
                        {item.badge !== undefined && item.badge > 0 && (
                          <span
                            className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold"
                            style={{
                              backgroundColor: 'var(--status-warning-bg)',
                              color: 'var(--status-warning)',
                            }}
                          >
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Theme Toggle & Primary Action Button */}
          <div className="flex items-center gap-3">
            <ThemeToggle />

            {/* Primary Action Button (Styled like reference "Get Assessment") */}
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
              className="md:hidden p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Slide-Out / Dropdown Drawer */}
      {mobileMenuOpen && (
        <div
          className="md:hidden border-t px-4 pt-3 pb-5 space-y-1 animate-in slide-in-from-top-2 duration-150"
          style={{
            backgroundColor: 'var(--surface-primary)',
            borderColor: 'var(--border-subtle)',
          }}
        >
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
                  {item.badge !== undefined && item.badge > 0 && (
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
