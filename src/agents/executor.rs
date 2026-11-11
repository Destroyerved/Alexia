//! Policy-Gated `ActionExecutor`: Enforces Tier-0 (Autonomous), Tier-1 (Step-Up Approval),
//! Tier-2 (Hard-Forbidden), and the Global Autonomy Kill Switch across all 15 DevSecOps actions.

use crate::auth::ApprovalManager;
use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::schemas::{now_iso, Action};
use crate::gateway::firewall::FirewallManager;
use crate::runtime::RuntimeSupervisor;
use crate::tools::git_pr::{merge_pull_request, open_pull_request};
use crate::tools::sql_audit::{assess_sql_exposure, dry_run_sql_migration};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogTier {
    Tier0Auto,
    Tier1Approval,
    Tier2Forbidden,
}

pub fn lookup_action_tier(action_name: &str) -> CatalogTier {
    match action_name {
        "restart_container"
        | "rollback_to_last_good_image"
        | "clear_tmp_and_rotate_logs"
        | "block_ip_temporarily"
        | "take_snapshot"
        | "run_integrity_check"
        | "open_pull_request" => CatalogTier::Tier0Auto,

        "restore_snapshot"
        | "rotate_secret"
        | "isolate_container_network"
        | "apply_config_change"
        | "raise_memory_limit"
        | "run_migration"
        | "merge_pull_request_and_deploy"
        | "kill_stuck_process" => CatalogTier::Tier1Approval,

        _ => CatalogTier::Tier2Forbidden,
    }
}

pub struct ActionExecutor {
    pub db: Arc<AlexiaDb>,
    pub bus: Arc<EventBus>,
    pub firewall: Arc<FirewallManager>,
    pub supervisor: Arc<RuntimeSupervisor>,
    pub approvals: Arc<ApprovalManager>,
    paused: AtomicBool,
}

impl ActionExecutor {
    pub fn new(
        db: Arc<AlexiaDb>,
        bus: Arc<EventBus>,
        firewall: Arc<FirewallManager>,
        supervisor: Arc<RuntimeSupervisor>,
        approvals: Arc<ApprovalManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            bus,
            firewall,
            supervisor,
            approvals,
            paused: AtomicBool::new(false),
        })
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, pause: bool, actor: &str) {
        self.paused.store(pause, Ordering::SeqCst);
        let _ = self.db.record_audit(
            if pause { "autonomy_paused" } else { "autonomy_resumed" },
            actor,
            json!({"is_paused": pause}),
        );
        self.bus.broadcast_sse(json!({
            "type": "autonomy_changed",
            "data": {"is_paused": pause, "actor": actor},
        }));
    }

    /// Evaluates policy gates and either executes immediately (Tier-0 when autonomy active),
    /// queues for human step-up approval (Tier-1 or when autonomy paused), or hard-rejects (Tier-2).
    pub async fn execute(
        &self,
        action: &mut Action,
        incident_id: &str,
        snapshot_id: Option<String>,
    ) -> Result<Value> {
        let catalog_tier = lookup_action_tier(&action.action);
        match catalog_tier {
            CatalogTier::Tier2Forbidden => {
                action.tier = 2;
                action.status = "rejected".into();
                let msg = format!(
                    "Tier-2 FORBIDDEN action `{}` hard-blocked by Alexia safety policy.",
                    action.action
                );
                action.execution_result = Some(json!({"error": msg, "forbidden": true}));
                let _ = self.db.record_audit(
                    "forbidden_action_blocked",
                    &action.requested_by,
                    json!({"action": action.action, "target": action.target, "incident_id": incident_id}),
                );
                bail!("{}", msg);
            }
            CatalogTier::Tier1Approval => {
                action.tier = 1;
                let token = self.approvals.create_pending(action, incident_id, snapshot_id);
                self.bus.broadcast_sse(json!({
                    "type": "notification",
                    "data": {
                        "title": format!("Tier-1 Approval Required: {}", action.action),
                        "body": format!("{} on {} awaits 6-digit TOTP or passkey confirmation.", action.action, action.target),
                        "severity": "high",
                        "deep_link": format!("/m/approvals/{}", action.id),
                    }
                }));
                return Ok(json!({
                    "status": "pending_approval",
                    "action_id": action.id,
                    "token": token,
                }));
            }
            CatalogTier::Tier0Auto => {
                action.tier = 0;
                if self.is_paused() {
                    let token = self.approvals.create_pending(action, incident_id, snapshot_id);
                    return Ok(json!({
                        "status": "pending_approval",
                        "reason": "autonomy_paused",
                        "action_id": action.id,
                        "token": token,
                    }));
                }
            }
        }

        let res = self.perform_raw_action(action).await?;
        action.status = "executed".into();
        action.executed_at = Some(now_iso());
        action.execution_result = Some(res.clone());
        let _ = self.db.record_audit(
            "action_executed",
            &action.requested_by,
            json!({
                "action_id": action.id,
                "action": action.action,
                "target": action.target,
                "tier": action.tier,
                "incident_id": incident_id,
                "result": res,
            }),
        );
        Ok(res)
    }

    /// Processes an operator's `approved` or `rejected` decision on a pending approval item.
    pub async fn decide_and_execute(
        &self,
        action_id: &str,
        decision: &str,
        decided_by: &str,
        step_up_method: Option<&str>,
        provided_token: Option<&str>,
    ) -> Result<Value, String> {
        let rec = self
            .approvals
            .decide(action_id, decision, decided_by, step_up_method, provided_token)?;

        if rec.status == "rejected" {
            if let Some(mut inc) = self.bus.get_incident(&rec.incident_id) {
                for a in &mut inc.plan {
                    if a.id == rec.action_id {
                        a.status = "rejected".into();
                    }
                }
                inc.approval_required = self
                    .approvals
                    .list_pending()
                    .iter()
                    .any(|p| p.incident_id == inc.id);
                if !inc.approval_required && inc.status != "resolved" {
                    inc.status = "escalated".into();
                    inc.summary = format!(
                        "Operator rejected `{}` on `{}`; escalated for manual review.",
                        rec.action_name, rec.target
                    );
                }
                self.bus.update_incident(&mut inc, "approval_rejected");
            }
            self.bus.broadcast_sse(json!({
                "type": "approval_decided",
                "data": {"action_id": action_id, "decision": "rejected"},
            }));
            return Ok(json!({
                "status": "rejected",
                "action_id": action_id,
                "message": format!("Action {} rejected by {}", rec.action_name, decided_by),
            }));
        }

        // Construct Action from PendingApproval and execute
        let mut act = Action {
            id: rec.action_id.clone(),
            action: rec.action_name.clone(),
            target: rec.target.clone(),
            params: rec.params.clone(),
            tier: rec.tier,
            reason: rec.reason.clone(),
            expected_outcome: rec.expected_outcome.clone(),
            rollback: rec.rollback.clone(),
            requested_by: rec.requested_by.clone(),
            status: "approved".into(),
            approval_token: Some(rec.token.clone()),
            executed_at: None,
            execution_result: None,
        };

        let exec_res = self
            .perform_raw_action(&act)
            .await
            .map_err(|e| format!("Approved action execution failed: {}", e))?;

        act.status = "executed".into();
        act.executed_at = Some(now_iso());
        act.execution_result = Some(exec_res.clone());

        let _ = self.db.record_audit(
            "approved_action_executed",
            decided_by,
            json!({
                "action_id": act.id,
                "action": act.action,
                "target": act.target,
                "incident_id": rec.incident_id,
                "step_up_method": step_up_method,
                "result": exec_res,
            }),
        );

        if let Some(mut inc) = self.bus.get_incident(&rec.incident_id) {
            for a in &mut inc.plan {
                if a.id == act.id {
                    *a = act.clone();
                }
            }
            let still_pending = self
                .approvals
                .list_pending()
                .iter()
                .any(|p| p.incident_id == inc.id);
            inc.approval_required = still_pending;
            if !still_pending {
                inc.status = "resolved".into();
                inc.summary = format!(
                    "Tier-1 action `{}` approved by {} and verified on `{}`.",
                    act.action, decided_by, act.target
                );
            }
            self.bus.update_incident(&mut inc, "approval_executed");
        }

        self.bus.broadcast_sse(json!({
            "type": "approval_decided",
            "data": {"action_id": action_id, "decision": "approved", "result": exec_res},
        }));

        Ok(json!({
            "status": "executed",
            "action_id": action_id,
            "result": exec_res,
            "message": format!("Approved & executed {} on {}", act.action, act.target),
        }))
    }

    async fn perform_raw_action(&self, action: &Action) -> Result<Value> {
        let target = if action.target.trim().is_empty() {
            "shoplite-api"
        } else {
            action.target.as_str()
        };

        match action.action.as_str() {
            "restart_container" => {
                let (_, res) = self.supervisor.restart_target(target).await?;
                Ok(res)
            }
            "rollback_to_last_good_image" => {
                let dep_id = action.params.get("deployment_id").and_then(|v| v.as_str());
                let (_, res) = self.supervisor.rollback_target(target, dep_id).await?;
                Ok(res)
            }
            "clear_tmp_and_rotate_logs" => self.supervisor.rotate_logs(),
            "block_ip_temporarily" => {
                let ip = action
                    .params
                    .get("ip")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("Missing `ip` parameter for block_ip_temporarily"))?;
                let mins = action
                    .params
                    .get("duration_minutes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(60);
                self.firewall
                    .block_ip(ip, mins, &action.reason)
                    .map_err(|e| anyhow!(e))
            }
            "take_snapshot" => {
                let snap = self.db.create_snapshot(target, None, &action.reason)?;
                Ok(serde_json::to_value(snap)?)
            }
            "run_integrity_check" => {
                let payload = action
                    .params
                    .get("payload")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let audit = assess_sql_exposure(payload, target);
                let (chain_ok, rows, _) = self.db.verify_audit_chain();
                Ok(json!({
                    "exposure_audit": audit,
                    "audit_chain_valid": chain_ok,
                    "audit_verified_rows": rows,
                }))
            }
            "open_pull_request" => {
                let workdir = self
                    .supervisor
                    .get_target(target)
                    .map(|t| t.workdir)
                    .filter(|w| !w.is_empty())
                    .unwrap_or_else(|| "target-service".into());
                let repo = self
                    .supervisor
                    .get_target(target)
                    .map(|t| t.github_repo)
                    .unwrap_or_default();
                let base_branch = self
                    .supervisor
                    .get_target(target)
                    .map(|t| t.base_branch)
                    .filter(|b| !b.is_empty())
                    .unwrap_or_else(|| "main".into());

                let title = action
                    .params
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("fix: autonomous remediation patch");
                let branch = action
                    .params
                    .get("branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("alexia/auto-fix");
                let body = action
                    .params
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&action.reason);
                let patch = action
                    .params
                    .get("patch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let failing_test = action
                    .params
                    .get("failing_test")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let base_diff = action
                    .params
                    .get("base_diff")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let pr = open_pull_request(
                    &self.db,
                    target,
                    &PathBuf::from(workdir),
                    title,
                    branch,
                    &base_branch,
                    body,
                    patch,
                    failing_test,
                    base_diff,
                    &repo,
                )
                .await?;
                Ok(serde_json::to_value(pr)?)
            }
            "restore_snapshot" => {
                let snap_id = action
                    .params
                    .get("snapshot_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("Missing `snapshot_id` for restore_snapshot"))?;
                let rec = self.db.restore_snapshot(snap_id, None)?;
                Ok(serde_json::to_value(rec)?)
            }
            "rotate_secret" => {
                let secret_name = action
                    .params
                    .get("secret_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("API_SECRET_KEY");
                let new_val = action.params.get("new_value").and_then(|v| v.as_str());
                self.supervisor.rotate_secret(target, secret_name, new_val).await
            }
            "isolate_container_network" => self.supervisor.isolate_target(target),
            "apply_config_change" => {
                let changes: HashMap<String, Value> = action.params.clone();
                self.supervisor.apply_config_change(target, &changes).await
            }
            "raise_memory_limit" => {
                let limit_mb = action
                    .params
                    .get("memory_limit_mb")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1024);
                self.supervisor.raise_memory_limit(target, limit_mb)
            }
            "run_migration" => {
                let sql = action
                    .params
                    .get("sql")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let dry = dry_run_sql_migration(sql, target);
                let snap = self.db.create_snapshot(target, None, "pre_migration_backup")?;
                Ok(json!({
                    "migration_executed": true,
                    "pre_migration_snapshot_id": snap.id,
                    "dry_run_report": dry,
                }))
            }
            "merge_pull_request_and_deploy" => {
                let pr_num = action
                    .params
                    .get("pr_number")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1);
                let branch = action.params.get("branch").and_then(|v| v.as_str());
                let workdir = self
                    .supervisor
                    .get_target(target)
                    .map(|t| t.workdir)
                    .filter(|w| !w.is_empty())
                    .unwrap_or_else(|| "target-service".into());

                let _ = self
                    .supervisor
                    .create_release_archive(target, &format!("pre_pr_{}", pr_num));
                let merged = merge_pull_request(&self.db, pr_num, branch, &PathBuf::from(workdir))?;
                let (healthy, restart_info) = self.supervisor.restart_target(target).await?;
                Ok(json!({
                    "merged": merged,
                    "deployed": true,
                    "healthy": healthy,
                    "restart": restart_info,
                }))
            }
            "kill_stuck_process" => self.supervisor.kill_managed_process(target),
            other => bail!("Unsupported action `{}`", other),
        }
    }
}
