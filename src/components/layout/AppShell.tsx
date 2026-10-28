import React from 'react';
import { TopNavbar } from './TopNavbar';
import { DemoModeBanner } from '../status/DemoModeBanner';
import { SoftCursor } from '../effects/SoftCursor';
import { PerspectiveGrid } from '../effects/PerspectiveGrid';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div
      className="min-h-screen flex flex-col relative"
      style={{
        backgroundColor: 'var(--bg-main)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Full-Page Interactive 3D Perspective Grid Background Layer */}
      <PerspectiveGrid />

      {/* Subtle Soft Cursor */}
      <SoftCursor />

      {/* Content Layers (Rendered above grid) */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Demo Mode Notice */}
        <DemoModeBanner />

        {/* Main Top Navigation Website Header */}
        <TopNavbar />

        {/* Centered Main Content Area */}
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>

        {/* Clean Website Footer */}
        <footer
          className="border-t py-6 mt-12 text-xs text-[var(--text-muted)]"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--surface-primary)',
          }}
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 font-mono text-[11px]">
            <div>
              <span>Alexia DevSecOps Guardian • Protected Environment (ShopLite Docker)</span>
            </div>
            <div>
              <span>Autonomous Multi-Agent Security Operations</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};
