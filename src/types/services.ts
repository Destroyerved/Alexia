export type ServiceHealth = 'healthy' | 'unhealthy' | 'degraded';

export interface ServiceItem {
  id: string;
  name: string;
  container_id: string;
  image: string;
  status: ServiceHealth;
  uptime_seconds: number;
  last_health_check: string;
  restart_count: number;
  cpu_percent: number;
  memory_mb: number;
  disk_mb: number;
  latest_incident_id?: string;
  ports: string[];
}

export type DeploymentStatus =
  | 'Pending'
  | 'Building'
  | 'Checking gates'
  | 'Deploying'
  | 'Verifying'
  | 'Successful'
  | 'Rolled back'
  | 'Failed';

export interface DeploymentGate {
  name: string;
  passed: boolean;
  details: string;
  timestamp: string;
}

export interface DeploymentRecord {
  id: string;
  service_name: string;
  image_tag: string;
  previous_known_good_image: string;
  trigger: 'git_push' | 'alexia_remediation' | 'manual' | 'rollback';
  status: DeploymentStatus;
  started_at: string;
  completed_at?: string;
  pre_deploy_gates: DeploymentGate[];
  health_gates: DeploymentGate[];
  rollback_info?: {
    is_rollback: boolean;
    target_image: string;
    reason: string;
    executed_at: string;
  };
  rollback_available?: boolean;
}
