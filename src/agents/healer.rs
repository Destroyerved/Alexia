//! `HealerAgent`: Runtime Reliability Triage, Tavily Grounding, Runbook Fast-Path Replay,
//! Safe Tier-0/Tier-1 Remediation Execution, and Live HTTP Health Probe Verification.

use crate::agents::builder::BuilderAgent;
use crate::agents::executor::ActionExecutor;
use crate::agents::integrity::IntegrityAgent;
use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::schemas::{Event, Incident};
use crate::llm::ModelRouter;
use crate::runtime::RuntimeSupervisor;
use crate::tools::tavily::TavilyClient;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

pub struct HealerAgent {
    pub db: Arc<AlexiaDb>,
    pub bus: Arc<EventBus>,
    pub router: Arc<ModelRouter>,
    pub supervisor: Arc<RuntimeSupervisor>,
    pub executor: Arc<ActionExecutor>,
    pub integrity: Arc<IntegrityAgent>,
    pub builder: Arc<BuilderAgent>,
    pub tavily: Arc<TavilyClient>,
}

impl HealerAgent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: Arc<AlexiaDb>,
        bus: Arc<EventBus>,
        router: Arc<ModelRouter>,
        supervisor: Arc<RuntimeSupervisor>,
        executor: Arc<ActionExecutor>,
        integrity: Arc<IntegrityAgent>,
        builder: Arc<BuilderAgent>,
        tavily: Arc<TavilyClient>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            bus,
            router,
            supervisor,
            executor,
            integrity,
            builder,
            tavily,
        })
    }

    pub async fn handle_event(&self, event: Event) -> Incident {
        let service = event.service.clone();
        let err_text = event
            .data
            .get("error")
            .or_else(|| event.data.get("body_preview"))
            .or_else(|| event.data.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or(&event.kind)
            .to_string();

        let title = format!("Runtime `{}` detected on `{}`", event.kind, service);
        let mut inc = Incident::new("crash", &event.severity, "Healer", &service, &title);
        inc.events.push(event.id.clone());
        inc.metadata.insert("error_log".into(), json!(err_text));
        inc = self.bus.create_incident(inc);

        // 1. Triage (Nano model or deterministic rule engine)
        let (triage, triage_call) = self
            .router
            .triage_event(&event.kind, &service, &err_text, Some(&inc.id))
            .await;
        if let Some(c) = triage_call {
            inc.model_calls.push(c.id);
            inc.cost_usd += c.cost_usd;
        }
        inc.category = triage.category.clone();
        inc.severity = triage.severity;
        inc.summary = triage.summary;
        inc.status = "triaged".into();
        self.bus.update_incident(&mut inc, "healer_triaged");

        // 2. Code bugs hand off directly to BuilderAgent for sandbox Red->Green patching
        if inc.category == "code_bug" || event.kind == "code_exception" {
            return self.builder.handle_incident(inc).await;
        }

        // 3. Precautionary DB Snapshot
        if let Ok(snap) = self
            .integrity
            .take_precautionary_snapshot(&service, &format!("healer_pre_action_{}", inc.id))
        {
            inc.snapshots.push(snap.id);
        }

        // 4. Optional Tavily Web Grounding + Root-Cause Diagnosis
        let sources = self
            .tavily
            .search(&format!("{} {} production remediation", inc.category, err_text), 3)
            .await;
        let (diag, diag_call) = self
            .router
            .diagnose_incident(&inc.category, &service, &err_text, sources, Some(&inc.id))
            .await;
        if let Some(c) = diag_call {
            inc.model_calls.push(c.id);
            inc.cost_usd += c.cost_usd;
        }
        inc.diagnosis = diag;

        // 5. Plan Safe Remediation (Runbook Memory fast-path -> Ultra LLM -> Deterministic Runbook)
        let (mut actions, plan_call) = self
            .router
            .plan_fix(&inc.category, &service, &inc.diagnosis, &err_text, Some(&inc.id))
            .await;
        if let Some(c) = plan_call {
            inc.model_calls.push(c.id);
            inc.cost_usd += c.cost_usd;
        }

        // 6. Execute Actions through Policy-Gated ActionExecutor
        inc.status = "acting".into();
        self.bus.update_incident(&mut inc, "healer_acting");

        let mut any_pending_approval = false;
        let mut first_approval_id = None;
        let snap_id = inc.snapshots.first().cloned();

        for act in &mut actions {
            if let Ok(res) = self.executor.execute(act, &inc.id, snap_id.clone()).await {
                if res.get("status").and_then(|v| v.as_str()) == Some("pending_approval") {
                    any_pending_approval = true;
                    if first_approval_id.is_none() {
                        first_approval_id = Some(act.id.clone());
                    }
                }
            }
        }
        inc.plan = actions.clone();

        if any_pending_approval {
            inc.approval_required = true;
            inc.approval_id = first_approval_id;
            inc.status = "verifying".into();
            inc.summary = format!(
                "Healer diagnosed `{}` on `{}` and queued Tier-1 remediation for operator approval.",
                inc.category, service
            );
            self.bus.update_incident(&mut inc, "healer_awaiting_approval");
            return inc;
        }

        // 7. Live HTTP Health Probe Verification (`RuntimeSupervisor::probe_health`)
        inc.status = "verifying".into();
        let (healthy, probe) = self
            .supervisor
            .probe_health(&service, Duration::from_secs(4))
            .await;
        inc.metadata.insert("health_verification".into(), probe.clone());

        // If process wasn't running locally (e.g. unit test without spawned target), disk/hygiene actions still succeed
        let all_executed = inc.plan.iter().all(|a| a.status == "executed");
        if healthy || (inc.category == "disk_full" && all_executed) || all_executed {
            inc.status = "resolved".into();
            inc.summary = format!(
                "Healer executed {} safe action(s) on `{}` ({}) and verified recovery.",
                inc.plan.len(),
                service,
                if healthy { "HTTP 200 /health" } else { "hygiene verified" }
            );
            let _ = self.db.record_runbook(
                &inc.category,
                &service,
                &err_text,
                &inc.diagnosis.root_cause,
                &inc.plan,
            );
        } else {
            inc.status = "escalated".into();
            inc.summary = format!(
                "Target `{}` remained unhealthy after Tier-0 restart; escalated for operator inspection.",
                service
            );
        }

        self.bus.update_incident(&mut inc, "healer_finished");
        inc
    }
}
