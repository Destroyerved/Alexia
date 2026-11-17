import React from 'react';
import { AlexiaProvider, useAlexia } from './context/AlexiaContext';
import { ThemeProvider } from './context/ThemeContext';
import { AppShell } from './components/layout/AppShell';
import { MobileShell } from './components/layout/MobileShell';
import { useIsMobile } from './hooks/useIsMobile';
import { OverviewView } from './features/overview/OverviewView';
import { IncidentsView } from './features/incidents/IncidentsView';
import { ApprovalsView } from './features/approvals/ApprovalsView';
import { ServicesView } from './features/services/ServicesView';
import { ScenariosView } from './features/scenarios/ScenariosView';
import { SecurityView } from './features/security/SecurityView';
import { ModelUsageView } from './features/observability/ModelUsageView';
import { SettingsView } from './features/settings/SettingsView';

const ViewRouter: React.FC = () => {
  const { currentView } = useAlexia();

  switch (currentView) {
    case 'overview':
      return <OverviewView />;
    case 'incidents':
      return <IncidentsView />;
    case 'approvals':
      return <ApprovalsView />;
    case 'services':
    case 'deployments':
      return <ServicesView />;
    case 'scenarios':
      return <ScenariosView />;
    case 'security':
    case 'audit':
      return <SecurityView />;
    case 'usage':
      return <ModelUsageView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <OverviewView />;
  }
};

export default function App() {
  const isMobile = useIsMobile();

  return (
    <ThemeProvider>
      <AlexiaProvider>
        {isMobile ? (
          <MobileShell>
            <ViewRouter />
          </MobileShell>
        ) : (
          <AppShell>
            <ViewRouter />
          </AppShell>
        )}
      </AlexiaProvider>
    </ThemeProvider>
  );
}
