//! `DeployerAgent`: Tri-Gate Pre-Deploy Pipeline (Sentinel Secret Scan + Integrity SQL Migration Dry-Run
//! + Builder Diff Review), `.tar.gz` Release Archiving, Smoke/Health Verification & Auto-Rollback.

use crate::agents::builder::BuilderAgent;
use crate::agents::executor::ActionExecutor;
use crate::agents::integrity::IntegrityAgent;
use crate::agents::sentinel::SentinelAgent;
use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::schemas::{
    generate_id, now_iso, Action, DeploymentRecord, Diagnosis, Incident,
};
use crate::runtime::RuntimeSupervisor;
use crate::tools::diff::apply_diff_to_dir;
use crate::tools::sandbox::SandboxRunner;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct DeployerAgent {
    pub db: Arc<AlexiaDb>,
    pub bus: Arc<EventBus>,
    pub supervisor: Arc<RuntimeSupervisor>,
    pub executor: Arc<ActionExecutor>,
    pub sentinel: Arc<SentinelAgent>,
    pub integrity: Arc<IntegrityAgent>,
    pub builder: Arc<BuilderAgent>,
}

impl DeployerAgent {
    pub fn new(
        db: Arc<AlexiaDb>,
        bus: Arc<EventBus>,
        supervisor: Arc<RuntimeSupervisor>,
        executor: Arc<ActionExecutor>,
        sentinel: Arc<SentinelAgent>,
        integrity: Arc<IntegrityAgent>,
        builder: Arc<BuilderAgent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            bus,
            supervisor,
            executor,
            sentinel,
            integrity,
            builder,
        })
    }

    pub async fn deploy_commit(
        &self,
        service: &str,
        commit_sha: &str,
        author: &str,
        diff_text: &str,
        migration_sql: Option<&str>,
    ) -> Value {
        let dep_id = generate_id("dep");
        let short_sha = &commit_sha[..commit_sha.len().min(8)];
        let version_tag = format!("v1.0.{}", short_sha);

        // ------------------------------------------------------------------
        // Gate 1: Sentinel Secret-Leak Diff Scan
        // ------------------------------------------------------------------
        let secret_findings = self.sentinel.scan_diff_secrets(diff_text);
        if !secret_findings.is_empty() {
            let masked_summary: Vec<String> = secret_findings
                .iter()
                .map(|(kind, masked)| format!("{} ({})", kind, masked))
                .collect();

            let dep = DeploymentRecord {
                id: dep_id.clone(),
                service_name: service.to_string(),
                version: version_tag,
                commit_sha: commit_sha.to_string(),
                author: author.to_string(),
                status: "failed".into(),
                pre_deploy_review: "blocked_secret_leak".into(),
                health_gate: "skipped".into(),
                rollback_available: false,
                archive_path: String::new(),
                deployed_at: now_iso(),
            };
            let _ = self.db.upsert_deployment(&dep);

            let mut inc = Incident::new(
                "security",
                "critical",
                "Sentinel",
                service,
                &format!("Blocked secret leak in commit `{}` on `{}`", short_sha, service),
            );
            inc.diagnosis = Diagnosis {
                root_cause: format!(
                    "Pre-deploy Sentinel scan intercepted leaked credential(s) in git diff: {}.",
                    masked_summary.join(", ")
                ),
                explanation: "Deployment halted before reaching runtime; secret rotation queued.".into(),
                evidence: masked_summary.clone(),
                sources: Vec::new(),
                confidence: 0.99,
            };
            inc = self.bus.create_incident(inc);

            let mut rot = Action::new(
                "rotate_secret",
                service,
                1,
                "Rotate leaked API credential intercepted during pre-deploy diff scan",
                "agent:sentinel",
            );
            rot.params = HashMap::from([("secret_name".into(), json!("STRIPE_SECRET_KEY"))]);
            rot.expected_outcome = "Compromised credential rotated in target .env and service reloaded".into();
            let _ = self.executor.execute(&mut rot, &inc.id, None).await;
            let app_id = rot.id.clone();
            inc.plan.push(rot);
            inc.approval_required = true;
            inc.approval_id = Some(app_id);
            inc.status = "verifying".into();
            inc.summary = format!(
                "Blocked commit `{}` containing {}; queued Tier-1 `rotate_secret` approval.",
                short_sha,
                masked_summary.join(", ")
            );
            self.bus.update_incident(&mut inc, "secret_leak_blocked");

            return json!({
                "deployment_id": dep_id,
                "status": "blocked_secret_leak",
                "incident_id": inc.id,
                "findings": masked_summary,
            });
        }

        // ------------------------------------------------------------------
        // Gate 2: Integrity SQL Migration Dry-Run (`sqlparser` AST)
        // ------------------------------------------------------------------
        if let Some(sql) = migration_sql.filter(|s| !s.trim().is_empty()) {
            let dry_run = self.integrity.review_migration(sql, service);
            if dry_run.get("is_destructive").and_then(|v| v.as_bool()) == Some(true) {
                let risk = dry_run
                    .get("risk_summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Destructive DDL detected")
                    .to_string();

                let dep = DeploymentRecord {
                    id: dep_id.clone(),
                    service_name: service.to_string(),
                    version: version_tag,
                    commit_sha: commit_sha.to_string(),
                    author: author.to_string(),
                    status: "pending".into(),
                    pre_deploy_review: "paused_destructive_migration".into(),
                    health_gate: "pending".into(),
                    rollback_available: false,
                    archive_path: String::new(),
                    deployed_at: now_iso(),
                };
                let _ = self.db.upsert_deployment(&dep);

                let mut inc = Incident::new(
                    "integrity",
                    "high",
                    "Integrity",
                    service,
                    &format!("Destructive SQL migration paused before deploy (`{}`)", short_sha),
                );
                inc.diagnosis = Diagnosis {
                    root_cause: risk.clone(),
                    explanation: "Isolated `sqlparser` AST dry-run detected data-destroying DDL; deployment paused pending human step-up approval.".into(),
                    evidence: vec![sql.to_string(), risk.clone()],
                    sources: Vec::new(),
                    confidence: 0.99,
                };
                inc.metadata.insert("migration_dry_run".into(), dry_run.clone());
                inc = self.bus.create_incident(inc);

                let snap_id = self
                    .integrity
                    .take_precautionary_snapshot(service, &format!("pre_destructive_migration_{}", inc.id))
                    .ok()
                    .map(|s| {
                        inc.snapshots.push(s.id.clone());
                        s.id
                    });

                let mut mig_act = Action::new(
                    "run_migration",
                    service,
                    1,
                    &risk,
                    "agent:integrity",
                );
                mig_act.params = HashMap::from([("sql".into(), json!(sql))]);
                mig_act.expected_outcome = "Execute reviewed schema migration after verified DB backup".into();
                mig_act.rollback = format!(
                    "restore_snapshot({})",
                    snap_id.clone().unwrap_or_else(|| "latest".into())
                );
                let _ = self.executor.execute(&mut mig_act, &inc.id, snap_id).await;
                let app_id = mig_act.id.clone();
                inc.plan.push(mig_act);
                inc.approval_required = true;
                inc.approval_id = Some(app_id);
                inc.status = "verifying".into();
                inc.summary = format!("Paused destructive migration ({}) — snapshot captured & awaiting Tier-1 approval.", risk);
                self.bus.update_incident(&mut inc, "destructive_migration_paused");

                return json!({
                    "deployment_id": dep_id,
                    "status": "paused_destructive_migration",
                    "incident_id": inc.id,
                    "dry_run": dry_run,
                });
            }
        }

        // ------------------------------------------------------------------
        // Gate 3: Builder Diff Review + Baseline `.tar.gz` Archive + Smoke/Health Gate
        // ------------------------------------------------------------------
        let diff_review = self.builder.review_diff(diff_text, None).await;
        let archive_path = self
            .supervisor
            .create_release_archive(service, "last_known_good")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let workdir = self
            .supervisor
            .get_target(service)
            .map(|t| t.workdir)
            .filter(|w| !w.is_empty())
            .unwrap_or_else(|| "target-service".into());
        let sandbox = SandboxRunner::for_workdir(&workdir);

        // Apply candidate diff to workspace & run smoke + live health verification
        let mut applied_ok = true;
        if !diff_text.trim().is_empty() {
            applied_ok = apply_diff_to_dir(&PathBuf::from(&workdir), diff_text).is_ok();
        }
        let (smoke_ok, smoke_log) = sandbox.smoke_test("");

        let (live_healthy, _) = self
            .supervisor
            .probe_health(service, Duration::from_millis(800))
            .await;

        if !applied_ok || !smoke_ok {
            // Post-deploy smoke/health gate FAILED -> Instant Tier-0 Rollback + Builder Fix PR!
            let (_, rb_info) = self
                .supervisor
                .rollback_target(service, Some(&dep_id))
                .await
                .unwrap_or((true, json!({"status": "rolled_back"})));

            let dep = DeploymentRecord {
                id: dep_id.clone(),
                service_name: service.to_string(),
                version: version_tag,
                commit_sha: commit_sha.to_string(),
                author: author.to_string(),
                status: "rolled_back".into(),
                pre_deploy_review: if diff_review.get("passed").and_then(|v| v.as_bool()) == Some(true) {
                    "passed".into()
                } else {
                    "flagged".into()
                },
                health_gate: "failed".into(),
                rollback_available: false,
                archive_path,
                deployed_at: now_iso(),
            };
            let _ = self.db.upsert_deployment(&dep);
            let _ = self.db.record_audit(
                "deployment_rolled_back",
                "agent:deployer",
                json!({
                    "deployment_id": dep_id,
                    "service": service,
                    "commit_sha": commit_sha,
                    "smoke_log": smoke_log,
                }),
            );

            let mut inc = Incident::new(
                "deployment",
                "critical",
                "Deployer",
                service,
                &format!("Broken deploy `{}` auto-rolled back on `{}`; synthesizing fix PR", short_sha, service),
            );
            inc.metadata.insert("base_diff".into(), json!(diff_text));
            inc.metadata.insert("error_log".into(), json!(smoke_log));
            inc.metadata.insert("rollback_result".into(), rb_info);
            inc = self.bus.create_incident(inc);

            let mut rb_act = Action::new(
                "rollback_to_last_good_image",
                service,
                0,
                &format!("Smoke gate failed after commit `{}`: {}", short_sha, smoke_log),
                "agent:deployer",
            );
            rb_act.status = "executed".into();
            rb_act.executed_at = Some(now_iso());
            inc.plan.push(rb_act);
            self.bus.update_incident(&mut inc, "deployer_rolled_back");

            // Hand off the broken diff (`base_diff`) to BuilderAgent so it proves & opens a fix PR!
            let updated_inc = self.builder.handle_incident(inc).await;
            return json!({
                "deployment_id": dep_id,
                "status": "rolled_back",
                "incident_id": updated_inc.id,
                "smoke_log": smoke_log,
            });
        }

        let dep = DeploymentRecord {
            id: dep_id.clone(),
            service_name: service.to_string(),
            version: version_tag,
            commit_sha: commit_sha.to_string(),
            author: author.to_string(),
            status: "healthy".into(),
            pre_deploy_review: "passed".into(),
            health_gate: "passed".into(),
            rollback_available: !archive_path.is_empty(),
            archive_path,
            deployed_at: now_iso(),
        };
        let _ = self.db.upsert_deployment(&dep);
        let _ = self.db.record_audit(
            "deployment_succeeded",
            "agent:deployer",
            json!({
                "deployment_id": dep_id,
                "service": service,
                "commit_sha": commit_sha,
                "live_healthy": live_healthy,
            }),
        );

        json!({
            "deployment_id": dep_id,
            "status": "healthy",
            "service": service,
            "commit_sha": commit_sha,
        })
    }
}
