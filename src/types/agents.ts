export type AgentState =
  | 'Idle'
  | 'Working'
  | 'Waiting for approval'
  | 'Completed'
  | 'Error';

export interface AgentInfo {
  id: 'builder' | 'deployer' | 'healer' | 'sentinel' | 'integrity';
  name: 'Builder' | 'Deployer' | 'Healer' | 'Sentinel' | 'Integrity';
  role_description: string;
  state: AgentState;
  current_task?: string;
  latest_event: string;
  latest_event_time: string;
  total_actions_today: number;
}

export interface OrchestratorInfo {
  name: 'Orchestrator';
  role_description: 'Autonomous central coordinator routing events, policy gates, and agent sequencing';
  state: AgentState;
  active_workflow?: string;
  coordinating_agents: string[];
}
