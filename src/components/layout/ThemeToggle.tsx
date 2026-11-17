import React, { useState, useRef, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, Theme } from '../../context/ThemeContext';

export const ThemeToggle: React.FC = () => {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const options: { id: Theme; label: string; icon: React.FC<{ size: number; className?: string }> }[] = [
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  const CurrentIcon = resolvedTheme === 'light' ? Sun : Moon;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)] transition-colors flex items-center gap-1.5"
        title={`Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}`}
        aria-label="Toggle visual theme"
      >
        <CurrentIcon size={16} className="text-[var(--accent-primary)]" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-36 py-1 bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-xl shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="px-2.5 py-1 text-[10px] font-mono uppercase font-bold text-[var(--text-muted)] tracking-wider">
            Interface Theme
          </div>
          {options.map((opt) => {
            const Icon = opt.icon;
            const isSelected = theme === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => {
                  setTheme(opt.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
                  isSelected
                    ? 'text-[var(--accent-primary)] font-semibold bg-[var(--surface-hover)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon size={14} />
                  <span>{opt.label}</span>
                </div>
                {isSelected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] shadow-[0_0_6px_var(--accent-primary)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
