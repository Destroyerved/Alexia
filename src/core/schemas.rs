//! Strongly-typed domain models wire-compatible with the React 19 Control Plane & Mobile PWA.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

pub fn generate_id(prefix: &str) -> String {
    let hex = Uuid::new_v4().simple().to_string();
    format!("{}_{}", prefix, &hex[..12])
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    #[serde(default = "default_evt_id")]
    pub id: String,
    #[serde(default = "now_iso")]
    pub ts: String,
    pub source: String,
    pub kind: String,
    #[serde(default = "default_service")]
    pub service: String,
    #[serde(default = "default_severity")]
    pub severity: String,
    #[serde(default)]
    pub data: HashMap<String, Value>,
}

fn default_evt_id() -> String {
    generate_id("evt")
}
fn default_service() -> String {
    "shoplite-api".to_string()
}
fn default_severity() -> String {
    "medium".to_string()
}

impl Event {
    pub fn new(source: &str, kind: &str, service: &str, severity: &str, data: HashMap<String, Value>) -> Self {
        Self {
            id: generate_id("evt"),
            ts: now_iso(),
            source: source.to_string(),
            kind: kind.to_string(),
            service: service.to_string(),
            severity: severity.to_string(),
            data,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiagnosticSource {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnosis {
    #[serde(default)]
    pub root_cause: String,
    #[serde(default)]
    pub explanation: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub sources: Vec<DiagnosticSource>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
}

fn default_confidence() -> f64 {
    0.85
}

impl Default for Diagnosis {
    fn default() -> Self {
        Self {
            root_cause: String::new(),
            explanation: String::new(),
            evidence: Vec::new(),
            sources: Vec::new(),
            confidence: 0.85,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    #[serde(default = "default_act_id")]
    pub id: String,
    pub action: String,
    #[serde(default = "default_service")]
    pub target: String,
    #[serde(default)]
    pub params: HashMap<String, Value>,
    #[serde(default)]
    pub tier: u8,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub expected_outcome: String,
    #[serde(default)]
    pub rollback: String,
    #[serde(default = "default_requested_by")]
    pub requested_by: String,
    #[serde(default = "default_action_status")]
    pub status: String,
    #[serde(default)]
    pub approval_token: Option<String>,
    #[serde(default)]
    pub executed_at: Option<String>,
    #[serde(default)]
    pub execution_result: Option<Value>,
}

fn default_act_id() -> String {
    generate_id("act")
}
fn default_requested_by() -> String {
    "agent:orchestrator".to_string()
}
fn default_action_status() -> String {
    "pending".to_string()
}

impl Action {
    pub fn new(action: &str, target: &str, tier: u8, reason: &str, requested_by: &str) -> Self {
        Self {
            id: generate_id("act"),
            action: action.to_string(),
            target: target.to_string(),
            params: HashMap::new(),
            tier,
            reason: reason.to_string(),
            expected_outcome: String::new(),
            rollback: String::new(),
            requested_by: requested_by.to_string(),
            status: "pending".to_string(),
            approval_token: None,
            executed_at: None,
            execution_result: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Incident {
    #[serde(default = "default_inc_id")]
    pub id: String,
    #[serde(default = "default_inc_status")]
    pub status: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default = "default_owner")]
    pub owner_agent: String,
    #[serde(default = "default_severity")]
    pub severity: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default = "default_service")]
    pub affected_service: String,
    #[serde(default)]
    pub diagnosis: Diagnosis,
    #[serde(default)]
    pub plan: Vec<Action>,
    #[serde(default)]
    pub snapshots: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub model_calls: Vec<String>,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub approval_required: bool,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default = "now_iso")]
    pub created_at: String,
    #[serde(default = "now_iso")]
    pub updated_at: String,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

fn default_inc_id() -> String {
    generate_id("inc")
}
fn default_inc_status() -> String {
    "open".to_string()
}
fn default_category() -> String {
    "crash".to_string()
}
fn default_owner() -> String {
    "healer".to_string()
}

impl Incident {
    pub fn new(category: &str, severity: &str, owner_agent: &str, service: &str, title: &str) -> Self {
        let now = now_iso();
        let mut meta = HashMap::new();
        meta.insert("service".to_string(), Value::String(service.to_string()));
        Self {
            id: generate_id("inc"),
            status: "open".to_string(),
            category: category.to_string(),
            owner_agent: owner_agent.to_string(),
            severity: severity.to_string(),
            title: title.to_string(),
            summary: String::new(),
            affected_service: service.to_string(),
            diagnosis: Diagnosis::default(),
            plan: Vec::new(),
            snapshots: Vec::new(),
            events: Vec::new(),
            model_calls: Vec::new(),
            cost_usd: 0.0,
            approval_required: false,
            approval_id: None,
            created_at: now.clone(),
            updated_at: now,
            resolved_at: None,
            metadata: meta,
        }
    }

    pub fn sync_fields(&mut self) {
        if self.diagnosis.explanation.is_empty() && !self.diagnosis.root_cause.is_empty() {
            self.diagnosis.explanation = self.diagnosis.root_cause.clone();
        }
        if let Some(svc) = self.metadata.get("service").and_then(|v| v.as_str()) {
            if !svc.is_empty() {
                self.affected_service = svc.to_string();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCall {
    pub id: String,
    pub ts: String,
    pub tier: String,
    pub provider: String,
    pub model: String,
    pub task: String,
    pub incident_id: Option<String>,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub latency_ms: f64,
    pub cost_usd: f64,
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: u64,
    pub timestamp: String,
    pub event_type: String,
    pub actor: String,
    pub details: Value,
    pub prev_hash: String,
    pub entry_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_gw_host")]
    pub host: String,
    #[serde(default = "default_gw_port")]
    pub port: u16,
    #[serde(default = "default_service")]
    pub default_target: String,
    #[serde(default = "default_rate_limit")]
    pub rate_limit_per_minute: u32,
}

fn default_true() -> bool {
    true
}
fn default_gw_host() -> String {
    "0.0.0.0".to_string()
}
fn default_gw_port() -> u16 {
    8000
}
fn default_rate_limit() -> u32 {
    240
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "0.0.0.0".to_string(),
            port: 8000,
            default_target: "shoplite-api".to_string(),
            rate_limit_per_minute: 240,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetServiceConfig {
    #[serde(default = "default_svc_id")]
    pub id: String,
    pub name: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub workdir: String,
    #[serde(default)]
    pub container_name: String,
    #[serde(default)]
    pub compose_file: String,
    #[serde(default)]
    pub compose_service: String,
    #[serde(default = "default_upstream")]
    pub upstream_url: String,
    #[serde(default = "default_health_url")]
    pub health_url: String,
    #[serde(default)]
    pub log_paths: Vec<String>,
    #[serde(default)]
    pub env_file: String,
    #[serde(default)]
    pub database_url: String,
    #[serde(default)]
    pub github_repo: String,
    #[serde(default = "default_branch")]
    pub base_branch: String,
    #[serde(default = "default_mem_limit")]
    pub memory_limit_mb: u64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_svc_id() -> String {
    generate_id("svc")
}
fn default_runtime() -> String {
    "process".to_string()
}
fn default_upstream() -> String {
    "http://127.0.0.1:8001".to_string()
}
fn default_health_url() -> String {
    "http://127.0.0.1:8001/health".to_string()
}
fn default_branch() -> String {
    "main".to_string()
}
fn default_mem_limit() -> u64 {
    512
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TargetsFile {
    #[serde(default)]
    pub gateway: GatewayConfig,
    #[serde(default)]
    pub targets: Vec<TargetServiceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    pub id: String,
    pub service_name: String,
    pub version: String,
    pub commit_sha: String,
    pub author: String,
    pub status: String,
    pub pre_deploy_review: String,
    pub health_gate: String,
    pub rollback_available: bool,
    pub archive_path: String,
    pub deployed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplianceReport {
    pub id: String,
    pub incident_id: String,
    pub framework: String,
    pub framework_label: String,
    pub generated_at: String,
    pub deadline_hours: u32,
    pub status: String,
    pub summary: String,
    pub affected_records_estimate: u64,
    pub data_categories_exposed: Vec<String>,
    pub containment_actions_taken: Vec<String>,
    pub root_cause: String,
    pub remediation_status: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingApproval {
    pub id: String,
    pub action_id: String,
    pub incident_id: String,
    pub action_name: String,
    pub target: String,
    pub affected_service: String,
    pub tier: u8,
    pub params: HashMap<String, Value>,
    pub reason: String,
    pub expected_outcome: String,
    pub rollback: String,
    pub blast_radius: String,
    pub requested_by: String,
    pub snapshot_id: Option<String>,
    pub token: String,
    pub status: String,
    pub created_at: String,
    pub expires_at_epoch: f64,
    pub expires_at: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub step_up_method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequestRecord {
    pub number: u64,
    pub service: String,
    pub repo: String,
    pub branch: String,
    pub base_branch: String,
    pub commit_sha: String,
    pub title: String,
    pub body: String,
    pub patch: String,
    pub base_diff: String,
    pub failing_test: String,
    pub test_rel_path: String,
    pub state: String,
    pub mode: String,
    pub html_url: String,
    pub github_pr_number: Option<u64>,
    pub created_at: String,
    pub merged_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub id: String,
    pub service: String,
    pub db_engine: String,
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub reason: String,
    pub created_at: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunbookEntry {
    pub id: String,
    pub signature: String,
    pub category: String,
    pub service: String,
    pub error_indicator: String,
    pub root_cause: String,
    pub actions: Vec<Action>,
    pub success_count: u64,
    pub updated_at: String,
}
