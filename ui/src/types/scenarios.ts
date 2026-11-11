export type ScenarioId =
  | 'S1'
  | 'S2'
  | 'S4'
  | 'S6'
  | 'S3_DISK'
  | 'S5_BRUTE'
  | 'S7'
  | 'S8'
  | 'S9';

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  category: 'Deployment' | 'Availability' | 'Security';
  is_mandatory_demo: boolean;
  demonstrates: string;
  agents_involved: Array<'Builder' | 'Deployer' | 'Healer' | 'Sentinel' | 'Integrity'>;
  expected_outcome: string;
  simulated_payload_info: string;
  estimated_duration_seconds: number;
  last_run?: {
    run_id: string;
    timestamp: string;
    status: 'completed' | 'failed' | 'running';
    incident_id?: string;
  };
}

export interface ScenarioRunState {
  scenario_id: ScenarioId;
  run_id: string;
  status: 'idle' | 'starting' | 'injecting' | 'detecting' | 'remediating' | 'completed' | 'failed';
  current_step: string;
  progress_percent: number;
  incident_id?: string;
  log_output: string[];
}
