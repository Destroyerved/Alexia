export type ModelTier = 'Nano' | 'Super' | 'Ultra';

export interface ModelCallRecord {
  id: string;
  incident_id?: string;
  stage?: string;
  model_name: string;
  tier: ModelTier;
  task: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_usd: number;
  status: 'success' | 'failed' | 'timeout';
  timestamp: string;
  safe_request_summary: string;
  safe_response_summary: string;
}

export interface ModelUsageSummary {
  total_spend_usd: number;
  daily_budget_usd: number;
  remaining_budget_usd: number;
  total_calls: number;
  failed_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_latency_ms: number;
  total_tavily_calls: number;
  tier_breakdown: {
    nano: { calls: number; cost_usd: number };
    super: { calls: number; cost_usd: number };
    ultra: { calls: number; cost_usd: number };
  };
}
