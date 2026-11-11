export type HashVerificationStatus =
  | 'Verified'
  | 'Verification failed'
  | 'Not yet verified'
  | 'Unavailable';

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  event: string;
  action: string;
  target: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED' | 'ROLLED_BACK';
  incident_id?: string;
  previous_hash: string;
  current_hash: string;
  signature: string;
  verification_status: HashVerificationStatus;
}

export interface SnapshotRecord {
  id: string;
  timestamp: string;
  triggering_incident_id?: string;
  trigger_action: string;
  snapshot_type: 'postgres_pg_dump' | 'container_fs' | 'git_commit_ref' | 'state_diff';
  target_resource: string;
  size_bytes: number;
  sha256_checksum: string;
  integrity_status: 'valid' | 'corrupted' | 'unverified';
  restore_eligible: boolean;
  related_audit_id: string;
}
