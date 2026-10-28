export type ActionTier = 'tier_0' | 'tier_1' | 'tier_2';

export interface ActionDefinition {
  id: string;
  name: string;
  tier: ActionTier;
  tier_label: 'Tier 0 — Automatic' | 'Tier 1 — Approval required' | 'Tier 2 — Forbidden';
  description: string;
  target_resource: string;
  is_destructive: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  incident_id: string;
  action_name: string;
  action_tier: ActionTier;
  action_tier_label: 'Tier 0 — Automatic' | 'Tier 1 — Approval required' | 'Tier 2 — Forbidden';
  affected_service: string;
  reason: string;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  expected_outcome: string;
  rollback_plan: string;
  snapshot_id?: string;
  requesting_agent: string;
  status: ApprovalStatus;
  created_at: string;
  expires_at?: string;
  rejection_reason?: string;
  decided_by?: string;
  decided_at?: string;
  is_demo?: boolean;
}
