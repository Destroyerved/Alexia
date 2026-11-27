import React from 'react';
import { AlexiaProvider, useAlexia } from './context/AlexiaContext';
import { ThemeProvider } from './context/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
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

  let content: React.ReactNode;
  switch (currentView) {
    case 'overview':
      content = <OverviewView />;
      break;
    case 'incidents':
      content = <IncidentsView />;
      break;
    case 'approvals':
      content = <ApprovalsView />;
      break;
    case 'services':
    case 'deployments':
      content = <ServicesView />;
      break;
    case 'scenarios':
      content = <ScenariosView />;
      break;
    case 'security':
    case 'audit':
      content = <SecurityView />;
      break;
    case 'usage':
      content = <ModelUsageView />;
      break;
    case 'settings':
      content = <SettingsView />;
      break;
    default:
      content = <OverviewView />;
  }

  return (
    <ErrorBoundary key={currentView} fallbackTitle={`Unable to render ${currentView} view`}>
      {content}
    </ErrorBoundary>
  );
};

export default function App() {
  const isMobile = useIsMobile();

  return (
    <ErrorBoundary fallbackTitle="Alexia Console Error">
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
    </ErrorBoundary>
  );
}
