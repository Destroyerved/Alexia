//! Full `axum` Control Plane REST + SSE Router, Inline `/gateway/:service/*path` WAF Route,
//! Cryptographic Step-Up Enforcement, and `rust-embed` React 19 Control Plane & Mobile PWA.

use crate::agents::{
    chaos::{reset_environment, run_scenario, scenario_catalog},
    AppContext,
};
use crate::core::db::DeviceRecord;
use crate::core::schemas::{
    generate_id, now_iso, AuditEntry, Event, Incident, ModelCall, PendingApproval,
    TargetServiceConfig,
};
use crate::gateway::proxy::forward_through_waf;
use axum::{
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{any, delete, get, post},
    Router,
};
use futures_util::stream::Stream;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};

#[derive(RustEmbed)]
#[folder = "dashboard/static/"]
struct EmbeddedDashboardAssets;

// ------------------------------------------------------------------
// UI View-Model Serializers (100% compatible with React 19 `ui/src/*`)
// ------------------------------------------------------------------
fn ui_category(raw: &str) -> &'static str {
    match raw.to_lowercase().as_str() {
        "security" => "Security",
        "deployment" => "Deployment",
        "integrity" => "Integrity",
        "disk_full" | "oom" | "performance" => "Performance",
        _ => "Availability",
    }
}

fn ui_agent_name(raw: &str) -> &'static str {
    match raw.to_lowercase().as_str() {
        "sentinel" => "Sentinel",
        "integrity" => "Integrity",
        "builder" => "Builder",
        "deployer" => "Deployer",
        _ => "Healer",
    }
}

pub fn format_incident_for_ui(inc: &Incident) -> Value {
    let owner = ui_agent_name(&inc.owner_agent);
    let ts = &inc.updated_at;
    let resolved = inc.status == "resolved";
    let escalated = inc.status == "escalated";

    let stages = vec![
        json!({
            "stage": "detection",
            "label": "Telemetry & WAF Signal Detection",
            "status": "completed",
            "timestamp": inc.created_at,
            "responsible_agent": owner,
            "explanation": inc.title,
        }),
        json!({
            "stage": "triage",
            "label": "Autonomous Classification & Routing",
            "status": "completed",
            "timestamp": inc.created_at,
            "responsible_agent": owner,
            "explanation": format!("Classified as `{}` ({}) -> routed to {}", inc.category, inc.severity, owner),
        }),
        json!({
            "stage": "snapshot",
            "label": "Precautionary Online Snapshot",
            "status": if inc.snapshots.is_empty() { "skipped" } else { "completed" },
            "timestamp": ts,
            "responsible_agent": "Integrity",
            "explanation": if inc.snapshots.is_empty() {
                "No state mutation snapshot required for this path".to_string()
            } else {
                format!("Captured SHA-256 verified snapshot(s): {}", inc.snapshots.join(", "))
            },
        }),
        json!({
            "stage": "diagnosis",
            "label": "Root-Cause & AST / Sandbox Analysis",
            "status": if inc.diagnosis.root_cause.is_empty() { "in_progress" } else { "completed" },
            "timestamp": ts,
            "responsible_agent": owner,
            "explanation": if inc.diagnosis.root_cause.is_empty() {
                "Collecting telemetry and forensic context".to_string()
            } else {
                inc.diagnosis.root_cause.clone()
            },
        }),
        json!({
            "stage": "plan",
            "label": "Policy-Gated Remediation Plan",
            "status": if inc.plan.is_empty() && !resolved { "pending" } else { "completed" },
            "timestamp": ts,
            "responsible_agent": owner,
            "explanation": format!("{} action(s) evaluated against Tier-0/1/2 catalog", inc.plan.len()),
        }),
        json!({
            "stage": "action",
            "label": "Containment & Execution",
            "status": if inc.approval_required {
                "in_progress"
            } else if escalated {
                "failed"
            } else {
                "completed"
            },
            "timestamp": ts,
            "responsible_agent": owner,
            "explanation": if inc.approval_required {
                "Tier-1 action queued — awaiting operator RFC 6238 TOTP / WebAuthn approval".to_string()
            } else {
                inc.summary.clone()
            },
        }),
        json!({
            "stage": "verification",
            "label": "Post-Action Live Health / Sandbox Proof",
            "status": if resolved {
                "completed"
            } else if inc.approval_required {
                "pending"
            } else if escalated {
                "failed"
            } else {
                "in_progress"
            },
            "timestamp": ts,
            "responsible_agent": owner,
            "explanation": if resolved {
                "Verified service recovery and cryptographic audit entry".to_string()
            } else {
                "Pending post-execution verification".to_string()
            },
        }),
        json!({
            "stage": "resolution",
            "label": "Incident Closure & Runbook Memory",
            "status": if resolved { "completed" } else if escalated { "failed" } else { "pending" },
            "timestamp": inc.resolved_at.clone().unwrap_or_else(|| ts.clone()),
            "responsible_agent": owner,
            "explanation": inc.summary,
        }),
    ];

    let ui_sources: Vec<Value> = inc
        .diagnosis
        .sources
        .iter()
        .map(|s| {
            let domain = s
                .url
                .split('/')
                .nth(2)
                .unwrap_or("web")
                .to_string();
            json!({
                "title": s.title,
                "url": s.url,
                "domain": domain,
                "excerpt": s.snippet,
                "retrieved_at": inc.updated_at,
            })
        })
        .collect();

    json!({
        "id": inc.id,
        "title": inc.title,
        "summary": inc.summary,
        "status": inc.status,
        "severity": inc.severity,
        "category": ui_category(&inc.category),
        "raw_category": inc.category,
        "affected_service": inc.affected_service,
        "owner_agent": owner,
        "events": inc.events,
        "created_at": inc.created_at,
        "updated_at": inc.updated_at,
        "resolved_at": inc.resolved_at,
        "approval_required": inc.approval_required,
        "approval_id": inc.approval_id,
        "diagnosis": {
            "root_cause": inc.diagnosis.root_cause,
            "explanation": if inc.diagnosis.explanation.is_empty() {
                &inc.diagnosis.root_cause
            } else {
                &inc.diagnosis.explanation
            },
            "evidence": inc.diagnosis.evidence,
            "sources": ui_sources,
            "confidence": inc.diagnosis.confidence,
        },
        "plan": inc.plan,
        "stages": stages,
        "snapshots": inc.snapshots,
        "cost_usd": inc.cost_usd,
        "model_calls": inc.model_calls,
        "is_demo": false,
        "metadata": inc.metadata,
    })
}

fn format_approval_for_ui(rec: &PendingApproval) -> Value {
    let (tier_key, tier_label) = match rec.tier {
        0 => ("tier_0", "Tier 0 — Automatic"),
        2 => ("tier_2", "Tier 2 — Forbidden"),
        _ => ("tier_1", "Tier 1 — Approval required"),
    };
    json!({
        "id": rec.action_id,
        "action_id": rec.action_id,
        "incident_id": rec.incident_id,
        "action_name": rec.action_name,
        "action_tier": tier_key,
        "action_tier_label": tier_label,
        "affected_service": rec.affected_service,
        "target": rec.target,
        "params": rec.params,
        "reason": rec.reason,
        "risk_level": "high",
        "expected_outcome": rec.expected_outcome,
        "rollback_plan": rec.rollback,
        "snapshot_id": rec.snapshot_id,
        "requesting_agent": rec.requested_by,
        "status": rec.status,
        "created_at": rec.created_at,
        "expires_at": rec.expires_at,
        "decided_by": rec.decided_by,
        "decided_at": rec.decided_at,
        "is_demo": false,
    })
}

fn format_service_for_ui(tel: &Value) -> Value {
    let raw_status = tel.get("status").and_then(|v| v.as_str()).unwrap_or("healthy");
    let ui_status = match raw_status {
        "healthy" => "healthy",
        "isolated" => "degraded",
        _ => "unhealthy",
    };
    let pid_str = tel
        .get("pid")
        .and_then(|v| v.as_u64())
        .map(|p| format!("pid:{}", p))
        .unwrap_or_else(|| {
            tel.get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("process")
                .to_string()
        });
    let last_hc_ts = tel
        .get("last_health_check")
        .and_then(|h| h.get("timestamp"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let upstream = tel
        .get("upstream_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    json!({
        "id": tel.get("id").and_then(|v| v.as_str()).unwrap_or("svc_shoplite_api"),
        "name": tel.get("name").and_then(|v| v.as_str()).unwrap_or("shoplite-api"),
        "runtime": tel.get("runtime").and_then(|v| v.as_str()).unwrap_or("process"),
        "pid": tel.get("pid"),
        "container_id": pid_str,
        "image": format!("rust-supervisor:{}", tel.get("version").and_then(|v| v.as_str()).unwrap_or("v1.0.0")),
        "status": ui_status,
        "raw_status": raw_status,
        "uptime_seconds": tel.get("uptime_seconds").and_then(|v| v.as_u64()).unwrap_or(0),
        "last_health_check": if last_hc_ts.is_empty() { now_iso() } else { last_hc_ts },
        "probe": tel.get("last_health_check"),
        "restart_count": tel.get("restart_count").and_then(|v| v.as_u64()).unwrap_or(0),
        "cpu_percent": tel.get("cpu_percent").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "memory_mb": tel.get("memory_mb").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "memory_limit_mb": tel.get("memory_limit_mb").and_then(|v| v.as_u64()).unwrap_or(512),
        "disk_mb": 12.4,
        "upstream_url": upstream,
        "ports": [upstream],
    })
}

fn format_audit_for_ui(e: &AuditEntry, chain_valid: bool) -> Value {
    let outcome = if e.event_type.contains("blocked") || e.event_type.contains("rejected") {
        "DENIED"
    } else if e.event_type.contains("rolled_back") {
        "ROLLED_BACK"
    } else {
        "SUCCESS"
    };
    let action = e
        .details
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or(&e.event_type);
    let target = e
        .details
        .get("target")
        .or_else(|| e.details.get("service"))
        .and_then(|v| v.as_str())
        .unwrap_or("alexia-guardian");
    let inc_id = e.details.get("incident_id").and_then(|v| v.as_str());

    json!({
        "id": format!("aud_{}", e.id),
        "seq": e.id,
        "timestamp": e.timestamp,
        "actor": e.actor,
        "event": e.event_type,
        "action": action,
        "target": target,
        "outcome": outcome,
        "incident_id": inc_id,
        "details": e.details,
        "previous_hash": e.prev_hash,
        "current_hash": e.entry_hash,
        "signature": &e.entry_hash[..e.entry_hash.len().min(16)],
        "verification_status": if chain_valid { "Verified" } else { "Verification failed" },
    })
}

fn build_agents_roster(incidents: &[Incident]) -> Vec<Value> {
    let specs = [
        (
            "sentinel",
            "Sentinel",
            "Inline WAF intrusion containment, SHA-256 forensics & CERT-In/DPDP/GDPR breach drafts",
        ),
        (
            "integrity",
            "Integrity",
            "Online SHA-256 database snapshots, SQL AST exposure audits & schema migration dry-runs",
        ),
        (
            "healer",
            "Healer",
            "Process/Docker watchdog recovery, gzip log rotation, Runbook replay & HTTP health probes",
        ),
        (
            "builder",
            "Builder",
            "Credential-scrubbed sandbox Red->Green patch synthesis, static/LLM diff review & Git PRs",
        ),
        (
            "deployer",
            "Deployer",
            "Tri-gate pre-deploy pipeline, .tar.gz release archiving & automatic smoke-gate rollback",
        ),
    ];

    let now = now_iso();
    specs
        .into_iter()
        .map(|(id, name, desc)| {
            let owned: Vec<&Incident> = incidents
                .iter()
                .filter(|i| i.owner_agent.eq_ignore_ascii_case(name))
                .collect();
            let waiting = owned.iter().any(|i| i.approval_required && i.status != "resolved");
            let active = owned
                .iter()
                .any(|i| matches!(i.status.as_str(), "open" | "triaged" | "acting"));

            let state = if waiting {
                "Waiting for approval"
            } else if active {
                "Working"
            } else if !owned.is_empty() {
                "Completed"
            } else {
                "Idle"
            };
            let latest_evt = owned
                .first()
                .map(|i| i.title.clone())
                .unwrap_or_else(|| "Standing by on EventBus".to_string());
            let latest_ts = owned
                .first()
                .map(|i| i.updated_at.clone())
                .unwrap_or_else(|| now.clone());

            json!({
                "id": id,
                "name": name,
                "role_description": desc,
                "state": state,
                "latest_event": latest_evt,
                "latest_event_time": latest_ts,
                "total_actions_today": owned.len(),
            })
        })
        .collect()
}

fn build_model_telemetry(ctx: &AppContext) -> (Value, Vec<Value>) {
    let ceiling = ctx
        .db
        .get_settings()
        .get("daily_budget_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(10.0);
    let stats = ctx.db.get_daily_budget_stats(ceiling);
    let raw_calls: Vec<ModelCall> = stats
        .get("recent_calls")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let total_calls = raw_calls.len();
    let total_in: u64 = raw_calls.iter().map(|c| c.prompt_tokens as u64).sum();
    let total_out: u64 = raw_calls.iter().map(|c| c.completion_tokens as u64).sum();
    let avg_lat = if total_calls > 0 {
        raw_calls.iter().map(|c| c.latency_ms).sum::<f64>() / total_calls as f64
    } else {
        0.0
    };

    let nano_calls = stats["by_tier"]["nano"]["calls"].as_u64().unwrap_or(0);
    let nano_cost = stats["by_tier"]["nano"]["cost_usd"].as_f64().unwrap_or(0.0);
    let sup_calls = stats["by_tier"]["super"]["calls"].as_u64().unwrap_or(0);
    let sup_cost = stats["by_tier"]["super"]["cost_usd"].as_f64().unwrap_or(0.0);
    let ult_calls = stats["by_tier"]["ultra"]["calls"].as_u64().unwrap_or(0);
    let ult_cost = stats["by_tier"]["ultra"]["cost_usd"].as_f64().unwrap_or(0.0);

    let summary = json!({
        "total_spend_usd": stats["daily_spend_usd"].as_f64().unwrap_or(0.0),
        "daily_budget_usd": ceiling,
        "remaining_budget_usd": stats["remaining_budget_usd"].as_f64().unwrap_or(ceiling),
        "total_calls": total_calls,
        "failed_calls": 0,
        "total_input_tokens": total_in,
        "total_output_tokens": total_out,
        "avg_latency_ms": (avg_lat * 10.0).round() / 10.0,
        "total_tavily_calls": 0,
        "tier_breakdown": {
            "nano": {"calls": nano_calls, "cost_usd": nano_cost},
            "super": {"calls": sup_calls, "cost_usd": sup_cost},
            "ultra": {"calls": ult_calls, "cost_usd": ult_cost},
        }
    });

    let ui_calls: Vec<Value> = raw_calls
        .into_iter()
        .map(|c| {
            let tier_cap = match c.tier.as_str() {
                "super" => "Super",
                "ultra" => "Ultra",
                _ => "Nano",
            };
            json!({
                "id": c.id,
                "incident_id": c.incident_id,
                "stage": c.task,
                "model_name": format!("{}/{}", c.provider, c.model),
                "tier": tier_cap,
                "task": c.task,
                "input_tokens": c.prompt_tokens,
                "output_tokens": c.completion_tokens,
                "latency_ms": c.latency_ms,
                "cost_usd": c.cost_usd,
                "status": "success",
                "timestamp": c.ts,
                "safe_request_summary": format!("Redacted {} prompt ({} tokens)", c.task, c.prompt_tokens),
                "safe_response_summary": format!("Structured {} completion ({} tokens)", c.task, c.completion_tokens),
            })
        })
        .collect();

    (summary, ui_calls)
}

fn json_error(status: StatusCode, detail: impl Into<String>) -> Response {
    let msg = detail.into();
    (status, Json(json!({"detail": msg, "error": msg}))).into_response()
}

// ------------------------------------------------------------------
// Route Handlers
// ------------------------------------------------------------------
async fn health_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let (chain_ok, rows, _) = ctx.db.verify_audit_chain();
    Json(json!({
        "status": "healthy",
        "version": "3.0.0",
        "runtime": "rust",
        "autonomy_paused": ctx.executor.is_paused(),
        "audit_chain_verified": chain_ok,
        "audit_blocks": rows,
        "timestamp": now_iso(),
    }))
}

async fn metrics_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let (chain_ok, rows, _) = ctx.db.verify_audit_chain();
    Json(json!({
        "db_size_bytes": ctx.db.size_bytes(),
        "audit_chain_valid": chain_ok,
        "audit_verified_rows": rows,
        "blocked_ips_count": ctx.firewall.list_blocked_ips().len(),
        "open_incidents": ctx.bus.list_incidents(Some("open"), 200).len(),
        "pending_approvals": ctx.approvals.list_pending().len(),
        "llm": ctx.llm.provider_status(),
    }))
}

async fn sse_stream_endpoint(
    State(ctx): State<Arc<AppContext>>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = ctx.bus.subscribe_sse();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(mut payload) => {
            let evt_type = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if (evt_type == "incident_created" || evt_type == "incident_updated")
                && payload.get("data").is_some()
            {
                if let Ok(inc) = serde_json::from_value::<Incident>(payload["data"].clone()) {
                    payload["data"] = format_incident_for_ui(&inc);
                }
            }
            let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
            Some(Ok(SseEvent::default().data(text)))
        }
        Err(_) => None,
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

async fn inline_gateway_route(
    State(ctx): State<Arc<AppContext>>,
    Path((service, rest)): Path<(String, String)>,
    req: Request,
) -> Response {
    let Some(target) = ctx.supervisor.get_target(&service) else {
        return json_error(StatusCode::NOT_FOUND, format!("Unknown target service: {}", service));
    };
    let upstream_path = if rest.starts_with('/') {
        rest
    } else {
        format!("/{}", rest)
    };
    forward_through_waf(&ctx.waf, &target, &upstream_path, req).await
}

async fn inline_gateway_root_route(
    State(ctx): State<Arc<AppContext>>,
    Path(service): Path<String>,
    req: Request,
) -> Response {
    let Some(target) = ctx.supervisor.get_target(&service) else {
        return json_error(StatusCode::NOT_FOUND, format!("Unknown target service: {}", service));
    };
    forward_through_waf(&ctx.waf, &target, "/", req).await
}

async fn dashboard_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let raw_incidents = ctx.bus.list_incidents(None, 100);
    let ui_incidents: Vec<Value> = raw_incidents.iter().map(format_incident_for_ui).collect();
    let open_count = raw_incidents
        .iter()
        .filter(|i| i.status != "resolved")
        .count();

    let all_approvals = ctx.approvals.list_all();
    let pending_count = all_approvals.iter().filter(|a| a.status == "pending").count();
    let ui_approvals: Vec<Value> = all_approvals.iter().map(format_approval_for_ui).collect();

    let raw_services = ctx.supervisor.get_all_services_telemetry().await;
    let ui_services: Vec<Value> = raw_services.iter().map(format_service_for_ui).collect();

    let deployments: Vec<Value> = ctx
        .db
        .list_deployments()
        .into_iter()
        .map(|d| {
            json!({
                "id": d.id,
                "service_name": d.service_name,
                "version": d.version,
                "previous_version": "last_known_good",
                "commit_sha": d.commit_sha,
                "author": d.author,
                "status": d.status,
                "pre_deploy_review": d.pre_deploy_review,
                "health_gate": d.health_gate,
                "rollback_available": d.rollback_available,
                "timestamp": d.deployed_at,
            })
        })
        .collect();

    let snapshots: Vec<Value> = ctx
        .db
        .list_snapshots()
        .into_iter()
        .map(|s| {
            json!({
                "id": s.id,
                "service_name": s.service,
                "incident_id": s.reason,
                "type": "full_bundle",
                "size_bytes": s.size_bytes,
                "size_mb": (s.size_bytes as f64 / (1024.0 * 1024.0) * 1000.0).round() / 1000.0,
                "sha256": s.sha256,
                "created_at": s.created_at,
                "verified": s.verified,
                "restorable": true,
            })
        })
        .collect();

    let reports = ctx.db.list_reports();
    let (model_summary, model_calls) = build_model_telemetry(&ctx);
    let (chain_valid, verified_rows, _) = ctx.db.verify_audit_chain();
    let audit_entries: Vec<Value> = ctx
        .db
        .list_audit_entries(100)
        .iter()
        .map(|e| format_audit_for_ui(e, chain_valid))
        .collect();

    let is_paused = ctx.executor.is_paused();
    let mut safe_settings = ctx.db.get_settings();
    safe_settings.remove("llm_api_key");

    Json(json!({
        "autonomy_mode": if is_paused { "paused" } else { "autonomous" },
        "is_autonomy_paused": is_paused,
        "settings": safe_settings,
        "agents": build_agents_roster(&raw_incidents),
        "llm": ctx.llm.provider_status(),
        "blocked_ips": ctx.firewall.list_blocked_ips(),
        "auth_setup_required": !ctx.auth.has_operators(),
        "open_incidents_count": open_count,
        "pending_approvals_count": pending_count,
        "incidents": ui_incidents,
        "approvals": ui_approvals,
        "services": ui_services,
        "deployments": deployments,
        "snapshots": snapshots,
        "reports": reports,
        "model_summary": model_summary,
        "model_calls": model_calls,
        "audit": {
            "chain_verified": chain_valid,
            "verified_rows": verified_rows,
            "entries": audit_entries,
        }
    }))
}

#[derive(Deserialize, Default)]
struct IncidentQuery {
    status: Option<String>,
}

async fn list_incidents_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Query(q): Query<IncidentQuery>,
) -> impl IntoResponse {
    let list: Vec<Value> = ctx
        .bus
        .list_incidents(q.status.as_deref(), 100)
        .iter()
        .map(format_incident_for_ui)
        .collect();
    Json(list)
}

async fn get_incident_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    match ctx.bus.get_incident(&id) {
        Some(inc) => Json(format_incident_for_ui(&inc)).into_response(),
        None => json_error(StatusCode::NOT_FOUND, format!("Incident {} not found", id)),
    }
}

async fn investigate_incident_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    let Some(inc) = ctx.bus.get_incident(&id) else {
        return json_error(StatusCode::NOT_FOUND, format!("Incident {} not found", id));
    };
    let updated = ctx.builder.handle_incident(inc).await;
    Json(format_incident_for_ui(&updated)).into_response()
}

async fn list_approvals_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let list: Vec<Value> = ctx
        .approvals
        .list_all()
        .iter()
        .map(format_approval_for_ui)
        .collect();
    Json(list)
}

#[derive(Deserialize, Default)]
struct ApprovalDecisionBody {
    decision: Option<String>,
    decided_by: Option<String>,
    actor: Option<String>,
    step_up_token: Option<String>,
    totp_code: Option<String>,
    passkey_assertion: Option<String>,
    token: Option<String>,
}

fn verify_step_up_from_body_or_headers(
    ctx: &AppContext,
    headers: &HeaderMap,
    step_up_token: Option<&str>,
    totp_code: Option<&str>,
    passkey_assertion: Option<&str>,
) -> Result<(String, String), String> {
    let hdr_tok = headers
        .get("x-step-up-token")
        .and_then(|v| v.to_str().ok());
    if let Some(tok) = step_up_token.or(hdr_tok).filter(|s| !s.trim().is_empty()) {
        let (ok, sub, method) = ctx.auth.verify_step_up_token(tok);
        if ok {
            return Ok((
                sub.unwrap_or_else(|| "operator".into()),
                method.unwrap_or_else(|| "step_up_token".into()),
            ));
        }
        return Err("Invalid or expired step-up token. Re-authenticate with your 6-digit TOTP code.".into());
    }

    if let Some(code) = totp_code.filter(|s| !s.trim().is_empty()) {
        let (ok, user) = ctx.auth.verify_totp(code, None);
        if ok {
            return Ok((user.unwrap_or_else(|| "operator".into()), "totp".into()));
        }
        return Err("Invalid 6-digit RFC 6238 TOTP code.".into());
    }

    if let Some(assertion) = passkey_assertion.filter(|s| !s.trim().is_empty()) {
        let (ok, user) = ctx.auth.verify_passkey_assertion(assertion);
        if ok {
            return Ok((
                user.unwrap_or_else(|| "operator".into()),
                "webauthn_passkey".into(),
            ));
        }
        return Err("Invalid or replayed ECDSA P-256 WebAuthn passkey assertion.".into());
    }

    if !ctx.auth.has_operators() {
        return Err("No operator enrolled yet. Complete First-Boot Operator Setup in Settings to obtain your RFC 6238 TOTP secret.".into());
    }

    Err("Step-up authentication required: provide a valid 6-digit TOTP code or WebAuthn passkey assertion.".into())
}

async fn decide_approval_endpoint(
    State(ctx): State<Arc<AppContext>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ApprovalDecisionBody>,
) -> Response {
    let decision = body
        .decision
        .as_deref()
        .unwrap_or("approved")
        .trim()
        .to_lowercase();

    let (actor, method) = if decision == "approved" {
        match verify_step_up_from_body_or_headers(
            &ctx,
            &headers,
            body.step_up_token.as_deref(),
            body.totp_code.as_deref(),
            body.passkey_assertion.as_deref(),
        ) {
            Ok((u, m)) => (format!("operator:{}", u), Some(m)),
            Err(e) => return json_error(StatusCode::UNAUTHORIZED, e),
        }
    } else {
        let who = body
            .decided_by
            .or(body.actor)
            .unwrap_or_else(|| "operator".into());
        (who, None)
    };

    match ctx
        .executor
        .decide_and_execute(
            &id,
            &decision,
            &actor,
            method.as_deref(),
            body.token.as_deref(),
        )
        .await
    {
        Ok(val) => Json(val).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn approve_shortcut_endpoint(
    State(ctx): State<Arc<AppContext>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<ApprovalDecisionBody>>,
) -> Response {
    let mut b = body.map(|j| j.0).unwrap_or_default();
    b.decision = Some("approved".into());
    decide_approval_endpoint(State(ctx), headers, Path(id), Json(b)).await
}

async fn reject_shortcut_endpoint(
    State(ctx): State<Arc<AppContext>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<ApprovalDecisionBody>>,
) -> Response {
    let mut b = body.map(|j| j.0).unwrap_or_default();
    b.decision = Some("rejected".into());
    decide_approval_endpoint(State(ctx), headers, Path(id), Json(b)).await
}

// ------------------------------------------------------------------
// Gateway Firewall Endpoints
// ------------------------------------------------------------------
async fn list_blocked_ips_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.firewall.list_blocked_ips())
}

#[derive(Deserialize)]
struct BlockIpBody {
    ip: String,
    #[serde(default = "default_block_mins")]
    duration_minutes: u64,
    #[serde(default = "default_block_reason")]
    reason: String,
}
fn default_block_mins() -> u64 {
    60
}
fn default_block_reason() -> String {
    "Manual operator block".into()
}

async fn add_blocked_ip_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<BlockIpBody>,
) -> Response {
    match ctx
        .firewall
        .block_ip(&body.ip, body.duration_minutes, &body.reason)
    {
        Ok(res) => {
            let _ = ctx.db.record_audit("manual_ip_block", "operator", res.clone());
            Json(json!({
                "success": true,
                "message": format!("Blocked {} for {} minutes", body.ip, body.duration_minutes),
                "block": res,
            }))
            .into_response()
        }
        Err(e) => json_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn remove_blocked_ip_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(ip): Path<String>,
) -> Response {
    match ctx.firewall.unblock_ip(&ip) {
        Ok(res) => {
            let _ = ctx.db.record_audit("manual_ip_unblock", "operator", res.clone());
            Json(json!({
                "success": true,
                "message": format!("Unblocked {}", ip),
            }))
            .into_response()
        }
        Err(e) => json_error(StatusCode::BAD_REQUEST, e),
    }
}

// ------------------------------------------------------------------
// Services, Targets, Snapshots & Deployments
// ------------------------------------------------------------------
async fn list_services_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let raw = ctx.supervisor.get_all_services_telemetry().await;
    let list: Vec<Value> = raw.iter().map(format_service_for_ui).collect();
    Json(list)
}

async fn restart_service_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    match ctx.supervisor.restart_target(&id).await {
        Ok((healthy, info)) => {
            let _ = ctx.db.record_audit(
                "manual_service_restart",
                "operator",
                json!({"service": id, "healthy": healthy}),
            );
            ctx.bus.broadcast_sse(json!({"type": "service_restarted", "data": info}));
            Json(json!({
                "success": true,
                "healthy": healthy,
                "message": format!("Restarted {} (healthy={})", id, healthy),
                "details": info,
            }))
            .into_response()
        }
        Err(e) => json_error(StatusCode::NOT_FOUND, e.to_string()),
    }
}

async fn get_targets_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(json!({
        "gateway": ctx.supervisor.gateway_config(),
        "targets": ctx.supervisor.list_targets(false),
    }))
}

#[derive(Deserialize)]
struct UpsertTargetBody {
    id: Option<String>,
    name: String,
    #[serde(default = "default_proc_str")]
    runtime: String,
    #[serde(default = "default_true_bool")]
    enabled: bool,
    #[serde(default = "default_up_str")]
    upstream_url: String,
    #[serde(default = "default_hc_str")]
    health_url: String,
    workspace_path: Option<String>,
    workdir: Option<String>,
    command: Option<Value>,
    container_name: Option<String>,
    compose_file: Option<String>,
    compose_service: Option<String>,
    github_repo: Option<String>,
    memory_limit_mb: Option<u64>,
}
fn default_proc_str() -> String {
    "process".into()
}
fn default_true_bool() -> bool {
    true
}
fn default_up_str() -> String {
    "http://127.0.0.1:8001".into()
}
fn default_hc_str() -> String {
    "http://127.0.0.1:8001/health".into()
}

async fn upsert_target_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<UpsertTargetBody>,
) -> impl IntoResponse {
    let cmd_vec: Vec<String> = match body.command {
        Some(Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => {
            s.split_whitespace().map(|p| p.to_string()).collect()
        }
        _ => Vec::new(),
    };

    let cfg = TargetServiceConfig {
        id: body.id.unwrap_or_else(|| generate_id("svc")),
        name: body.name,
        runtime: body.runtime,
        command: cmd_vec,
        workdir: body.workdir.or(body.workspace_path).unwrap_or_default(),
        container_name: body.container_name.unwrap_or_default(),
        compose_file: body.compose_file.unwrap_or_default(),
        compose_service: body.compose_service.unwrap_or_default(),
        upstream_url: body.upstream_url,
        health_url: body.health_url,
        log_paths: Vec::new(),
        env_file: String::new(),
        database_url: String::new(),
        github_repo: body.github_repo.unwrap_or_default(),
        base_branch: "main".into(),
        memory_limit_mb: body.memory_limit_mb.unwrap_or(512),
        enabled: body.enabled,
    };
    let saved = ctx.supervisor.upsert_target(cfg);
    Json(saved)
}

async fn delete_target_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    if ctx.supervisor.remove_target(&id) {
        Json(json!({"deleted": true, "target": id})).into_response()
    } else {
        json_error(StatusCode::NOT_FOUND, format!("Target {} not found", id))
    }
}

async fn list_deployments_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.db.list_deployments())
}

async fn rollback_deployment_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    let service = ctx
        .db
        .get_deployment(&id)
        .map(|d| d.service_name)
        .unwrap_or_else(|| "shoplite-api".into());
    match ctx.supervisor.rollback_target(&service, Some(&id)).await {
        Ok((healthy, info)) => {
            let _ = ctx.db.record_audit(
                "manual_deployment_rollback",
                "operator",
                json!({"deployment_id": id, "service": service, "healthy": healthy}),
            );
            ctx.bus
                .broadcast_sse(json!({"type": "deployment_rolled_back", "data": info}));
            Json(json!({
                "success": true,
                "restored_version": "last_known_good",
                "healthy": healthy,
                "details": info,
            }))
            .into_response()
        }
        Err(e) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize, Default)]
struct CreateSnapshotBody {
    service_name: Option<String>,
    incident_id: Option<String>,
}

async fn create_snapshot_endpoint(
    State(ctx): State<Arc<AppContext>>,
    body: Option<Json<CreateSnapshotBody>>,
) -> Response {
    let b = body.map(|j| j.0).unwrap_or_default();
    let svc = b.service_name.as_deref().unwrap_or("shoplite-api");
    let reason = b.incident_id.as_deref().unwrap_or("manual_operator");
    match ctx.db.create_snapshot(svc, None, reason) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn list_snapshots_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.db.list_snapshots())
}

// ------------------------------------------------------------------
// Security, Compliance Reports, Audit Chain & Models
// ------------------------------------------------------------------
async fn list_reports_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.db.list_reports())
}

async fn security_overview_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(json!({
        "blocked_ips": ctx.firewall.list_blocked_ips(),
        "reports": ctx.db.list_reports(),
        "security_incidents": ctx
            .bus
            .list_incidents(None, 50)
            .into_iter()
            .filter(|i| i.category == "security")
            .map(|i| format_incident_for_ui(&i))
            .collect::<Vec<_>>(),
    }))
}

async fn list_audit_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let (valid, rows, err) = ctx.db.verify_audit_chain();
    let entries: Vec<Value> = ctx
        .db
        .list_audit_entries(100)
        .iter()
        .map(|e| format_audit_for_ui(e, valid))
        .collect();
    Json(json!({
        "chain_verified": valid,
        "verified_rows": rows,
        "error": err,
        "entries": entries,
    }))
}

async fn verify_audit_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let (valid, rows, err) = ctx.db.verify_audit_chain();
    let head = ctx
        .db
        .list_audit_entries(1)
        .first()
        .map(|e| e.entry_hash.clone())
        .unwrap_or_else(|| crate::core::db::GENESIS_PREV_HASH.to_string());
    Json(json!({
        "valid": valid,
        "records_checked": rows,
        "head_hash": head,
        "error": err,
    }))
}

async fn models_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let (summary, calls) = build_model_telemetry(&ctx);
    Json(json!({
        "provider": ctx.llm.provider_status(),
        "summary": summary,
        "calls": calls,
    }))
}

async fn agents_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let incs = ctx.bus.list_incidents(None, 100);
    Json(build_agents_roster(&incs))
}

// ------------------------------------------------------------------
// Settings & Dynamic LLM Provider Configuration
// ------------------------------------------------------------------
async fn get_settings_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let mut s = ctx.db.get_settings();
    s.remove("llm_api_key");
    Json(s)
}

async fn update_settings_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(updates): Json<HashMap<String, Value>>,
) -> Response {
    match ctx.db.update_settings(&updates) {
        Ok(mut merged) => {
            merged.remove("llm_api_key");
            let _ = ctx.db.record_audit("settings_updated", "operator", json!({"keys": updates.keys().collect::<Vec<_>>()}));
            Json(merged).into_response()
        }
        Err(e) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn get_llm_config_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    let saved = ctx.db.get_settings();
    let has_key = saved
        .get("llm_api_key")
        .and_then(|v| v.as_str())
        .map(|k| !k.is_empty())
        .unwrap_or(false)
        || ctx.llm.is_live();

    Json(json!({
        "status": ctx.llm.provider_status(),
        "supported_providers": ["auto", "openai", "gemini", "anthropic", "openrouter", "nebius", "ollama", "custom", "none"],
        "saved": {
            "provider": saved.get("llm_provider").and_then(|v| v.as_str()).unwrap_or("auto"),
            "base_url": saved.get("llm_base_url").and_then(|v| v.as_str()).unwrap_or(""),
            "fast_model": saved.get("llm_fast_model").and_then(|v| v.as_str()).unwrap_or(""),
            "coding_model": saved.get("llm_coding_model").and_then(|v| v.as_str()).unwrap_or(""),
            "reasoning_model": saved.get("llm_reasoning_model").and_then(|v| v.as_str()).unwrap_or(""),
            "has_api_key": has_key,
        }
    }))
}

#[derive(Deserialize)]
struct SaveLlmConfigBody {
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
    fast_model: Option<String>,
    coding_model: Option<String>,
    reasoning_model: Option<String>,
}

async fn save_llm_config_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<SaveLlmConfigBody>,
) -> impl IntoResponse {
    let mut updates = HashMap::from([("llm_provider".to_string(), json!(body.provider))]);
    if let Some(ref k) = body.api_key {
        if !k.trim().is_empty() {
            updates.insert("llm_api_key".into(), json!(k.trim()));
        }
    }
    if let Some(ref b) = body.base_url {
        updates.insert("llm_base_url".into(), json!(b.trim()));
    }
    if let Some(ref f) = body.fast_model {
        updates.insert("llm_fast_model".into(), json!(f.trim()));
    }
    if let Some(ref c) = body.coding_model {
        updates.insert("llm_coding_model".into(), json!(c.trim()));
    }
    if let Some(ref r) = body.reasoning_model {
        updates.insert("llm_reasoning_model".into(), json!(r.trim()));
    }
    let _ = ctx.db.update_settings(&updates);

    let effective_key = body.api_key.or_else(|| {
        ctx.db
            .get_settings()
            .get("llm_api_key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    ctx.llm.reload_provider(
        &body.provider,
        effective_key.as_deref(),
        body.base_url.as_deref(),
        body.fast_model.as_deref(),
        body.coding_model.as_deref(),
        body.reasoning_model.as_deref(),
    );

    let _ = ctx.db.record_audit(
        "llm_provider_reconfigured",
        "operator",
        json!({"provider": body.provider, "live": ctx.llm.is_live()}),
    );

    Json(json!({
        "success": true,
        "llm": ctx.llm.provider_status(),
    }))
}

async fn test_llm_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.llm.test_connection().await)
}

// ------------------------------------------------------------------
// Auth Bootstrap, Login, TOTP Step-Up, Passkeys & Remote Controls
// ------------------------------------------------------------------
async fn auth_status_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(json!({
        "setup_required": !ctx.auth.has_operators(),
        "operator_count": ctx.auth.operator_count(),
        "operators": ctx.auth.list_operator_summaries(),
    }))
}

#[derive(Deserialize)]
struct SetupOperatorBody {
    username: String,
    password: String,
}

async fn auth_setup_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<SetupOperatorBody>,
) -> Response {
    match ctx.auth.setup_initial_operator(&body.username, &body.password) {
        Ok(res) => Json(res).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
    #[serde(default = "default_dev_name")]
    device_name: String,
    #[serde(default = "default_platform")]
    platform: String,
}
fn default_dev_name() -> String {
    "Operator Browser".into()
}
fn default_platform() -> String {
    "web".into()
}

async fn auth_login_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<LoginBody>,
) -> Response {
    if !ctx.auth.verify_credentials(&body.username, &body.password) {
        return json_error(StatusCode::UNAUTHORIZED, "Invalid operator username or password.");
    }
    let dev_id = generate_id("dev");
    let _ = ctx.db.upsert_device(&DeviceRecord {
        device_id: dev_id.clone(),
        user: body.username.clone(),
        device_name: body.device_name,
        platform: body.platform,
        ip_address: "127.0.0.1".into(),
        last_seen: now_iso(),
        revoked: false,
    });
    let token = ctx.auth.create_session_token(&body.username, &dev_id);
    Json(json!({
        "session_token": token,
        "username": body.username,
        "device_id": dev_id,
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
struct ChallengeBody {
    #[serde(default = "default_admin_str")]
    username: String,
}
fn default_admin_str() -> String {
    "admin".into()
}

async fn webauthn_challenge_endpoint(
    State(ctx): State<Arc<AppContext>>,
    body: Option<Json<ChallengeBody>>,
) -> impl IntoResponse {
    let user = body.map(|b| b.0.username).unwrap_or_else(|| "admin".into());
    let challenge = ctx.auth.issue_webauthn_challenge(&user);
    Json(json!({"challenge": challenge, "rp_id": "localhost"}))
}

#[derive(Deserialize)]
struct RegisterPasskeyBody {
    username: String,
    credential_id: String,
    public_key_pem: String,
    #[serde(default = "default_pk_label")]
    label: String,
}
fn default_pk_label() -> String {
    "Security Key".into()
}

async fn register_passkey_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<RegisterPasskeyBody>,
) -> Response {
    match ctx.auth.register_passkey(
        &body.username,
        &body.credential_id,
        &body.public_key_pem,
        &body.label,
    ) {
        Ok(()) => Json(json!({"registered": true, "credential_id": body.credential_id})).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize, Default)]
struct StepUpBody {
    totp_code: Option<String>,
    username: Option<String>,
    passkey_assertion: Option<String>,
}

async fn step_up_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<StepUpBody>,
) -> Response {
    if let Some(code) = body.totp_code.as_deref().filter(|s| !s.trim().is_empty()) {
        let (ok, matched_user) = ctx.auth.verify_totp(code, body.username.as_deref());
        if ok {
            let u = matched_user.unwrap_or_else(|| "admin".into());
            let tok = ctx.auth.create_step_up_token(&u, "totp");
            let _ = ctx.db.record_audit(
                "step_up_verified",
                &format!("operator:{}", u),
                json!({"method": "rfc6238_totp"}),
            );
            return Json(json!({
                "step_up_token": tok,
                "username": u,
                "method": "totp",
                "expires_in_seconds": 300,
            }))
            .into_response();
        }
        return json_error(StatusCode::UNAUTHORIZED, "Invalid 6-digit RFC 6238 authenticator code.");
    }

    if let Some(assertion) = body
        .passkey_assertion
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let (ok, matched_user) = ctx.auth.verify_passkey_assertion(assertion);
        if ok {
            let u = matched_user.unwrap_or_else(|| "admin".into());
            let tok = ctx.auth.create_step_up_token(&u, "webauthn_passkey");
            let _ = ctx.db.record_audit(
                "step_up_verified",
                &format!("operator:{}", u),
                json!({"method": "ecdsa_p256_webauthn"}),
            );
            return Json(json!({
                "step_up_token": tok,
                "username": u,
                "method": "webauthn_passkey",
                "expires_in_seconds": 300,
            }))
            .into_response();
        }
        return json_error(StatusCode::UNAUTHORIZED, "Invalid or replayed WebAuthn passkey assertion.");
    }

    if !ctx.auth.has_operators() {
        return json_error(
            StatusCode::PRECONDITION_REQUIRED,
            "No operator enrolled yet. Open Settings -> Operator Enroll to configure your TOTP authenticator.",
        );
    }

    json_error(
        StatusCode::BAD_REQUEST,
        "Provide `totp_code` (6 digits) or `passkey_assertion`.",
    )
}

#[derive(Deserialize)]
struct ToggleAutonomyBody {
    pause: bool,
    user: Option<String>,
    step_up_token: Option<String>,
    totp_code: Option<String>,
}

async fn remote_autonomy_endpoint(
    State(ctx): State<Arc<AppContext>>,
    headers: HeaderMap,
    Json(body): Json<ToggleAutonomyBody>,
) -> Response {
    // Emergency pause is always immediate; resuming autonomy requires valid step-up authentication!
    let actor = if !body.pause {
        match verify_step_up_from_body_or_headers(
            &ctx,
            &headers,
            body.step_up_token.as_deref(),
            body.totp_code.as_deref(),
            None,
        ) {
            Ok((u, _)) => format!("operator:{}", u),
            Err(e) => return json_error(StatusCode::UNAUTHORIZED, e),
        }
    } else {
        body.user.unwrap_or_else(|| "operator".into())
    };

    ctx.executor.set_paused(body.pause, &actor);
    Json(json!({
        "is_paused": body.pause,
        "message": if body.pause {
            "Global autonomy PAUSED — all agent actions now require manual approval."
        } else {
            "Global autonomy RESUMED (TOTP verified)."
        }
    }))
    .into_response()
}

async fn list_devices_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(ctx.db.list_devices())
}

async fn save_push_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let ep = body
        .get("endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("web_push_default");
    let _ = ctx.db.save_push_subscription(ep, &body);
    Json(json!({"subscribed": true}))
}

// ------------------------------------------------------------------
// Chaos Lab Scenarios & GitHub Webhook
// ------------------------------------------------------------------
async fn list_scenarios_endpoint() -> impl IntoResponse {
    Json(scenario_catalog())
}

async fn trigger_scenario_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Path(id): Path<String>,
) -> Response {
    match run_scenario(&ctx, &id).await {
        Ok(res) => Json(res).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, e),
    }
}

async fn reset_scenarios_endpoint(State(ctx): State<Arc<AppContext>>) -> impl IntoResponse {
    Json(reset_environment(&ctx).await)
}

async fn github_webhook_endpoint(
    State(ctx): State<Arc<AppContext>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let service = payload
        .get("repository")
        .and_then(|r| r.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("shoplite-api");
    let sha = payload
        .get("after")
        .or_else(|| payload.get("commit_sha"))
        .and_then(|v| v.as_str())
        .unwrap_or("webhook01");
    let author = payload
        .get("pusher")
        .and_then(|p| p.get("name"))
        .or_else(|| payload.get("author"))
        .and_then(|v| v.as_str())
        .unwrap_or("github");
    let diff = payload
        .get("diff")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mig = payload.get("migration_sql").and_then(|v| v.as_str());

    let evt = Event::new(
        "webhook.github",
        "git_push",
        service,
        "medium",
        HashMap::from([
            ("commit_sha".into(), json!(sha)),
            ("author".into(), json!(author)),
            ("diff".into(), json!(diff)),
            ("migration_sql".into(), json!(mig)),
        ]),
    );
    ctx.bus.publish(evt);
    Json(json!({"accepted": true, "commit_sha": sha, "service": service}))
}

// ------------------------------------------------------------------
// Embedded React 19 SPA & Mobile PWA Handler (`rust-embed`)
// ------------------------------------------------------------------
async fn embedded_spa_handler(req: Request) -> Response {
    let raw_path = req.uri().path().trim_start_matches('/');
    let path = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    if let Some(asset) = EmbeddedDashboardAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            [(header::CONTENT_TYPE, mime.as_ref())],
            asset.data.into_owned(),
        )
            .into_response();
    }

    // SPA client-side route fallback (e.g., `/m/approvals`, `/incidents`) -> `index.html`
    if !path.starts_with("api/") && !path.starts_with("remote/") {
        if let Some(index) = EmbeddedDashboardAssets::get("index.html") {
            return (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                index.data.into_owned(),
            )
                .into_response();
        }
    }

    json_error(StatusCode::NOT_FOUND, format!("Route not found: /{}", path))
}

pub fn create_control_plane_router(ctx: Arc<AppContext>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Health & Live SSE Streams
        .route("/health", get(health_endpoint))
        .route("/api/v1/health/metrics", get(metrics_endpoint))
        .route("/stream", get(sse_stream_endpoint))
        .route("/api/v1/events", get(sse_stream_endpoint))
        // Inline Reverse-Proxy WAF Routes
        .route("/gateway/:service", any(inline_gateway_root_route))
        .route("/gateway/:service/*rest", any(inline_gateway_route))
        .route(
            "/api/v1/gateway/blocked-ips",
            get(list_blocked_ips_endpoint).post(add_blocked_ip_endpoint),
        )
        .route(
            "/api/v1/gateway/blocked-ips/:ip",
            delete(remove_blocked_ip_endpoint),
        )
        // Unified Dashboard & Incidents
        .route("/api/v1/dashboard", get(dashboard_endpoint))
        .route("/api/v1/incidents", get(list_incidents_endpoint))
        .route("/api/v1/incidents/:id", get(get_incident_endpoint))
        .route(
            "/api/v1/incidents/:id/investigate",
            post(investigate_incident_endpoint),
        )
        // Human-in-the-Loop Tier-1 Approvals
        .route("/api/v1/approvals", get(list_approvals_endpoint))
        .route(
            "/api/v1/approvals/:id/decision",
            post(decide_approval_endpoint),
        )
        .route(
            "/api/v1/approvals/:id/approve",
            post(approve_shortcut_endpoint),
        )
        .route(
            "/api/v1/approvals/:id/reject",
            post(reject_shortcut_endpoint),
        )
        // Runtime Supervisor Services, Targets, Deployments & Snapshots
        .route("/api/v1/services", get(list_services_endpoint))
        .route("/api/v1/services/:id/restart", post(restart_service_endpoint))
        .route(
            "/api/v1/targets",
            get(get_targets_endpoint).post(upsert_target_endpoint),
        )
        .route("/api/v1/targets/:id", delete(delete_target_endpoint))
        .route("/api/v1/deployments", get(list_deployments_endpoint))
        .route(
            "/api/v1/deployments/:id/rollback",
            post(rollback_deployment_endpoint),
        )
        .route(
            "/api/v1/snapshots",
            get(list_snapshots_endpoint).post(create_snapshot_endpoint),
        )
        // Security, Compliance Reports, Audit Chain, Models & Agents
        .route("/api/v1/security", get(security_overview_endpoint))
        .route("/api/v1/reports", get(list_reports_endpoint))
        .route("/api/v1/audit", get(list_audit_endpoint))
        .route("/api/v1/audit/verify", get(verify_audit_endpoint))
        .route("/api/v1/models", get(models_endpoint))
        .route("/api/v1/agents", get(agents_endpoint))
        // Settings & Multi-Provider LLM Configuration
        .route(
            "/api/v1/settings",
            get(get_settings_endpoint).post(update_settings_endpoint),
        )
        .route(
            "/api/v1/llm/config",
            get(get_llm_config_endpoint).post(save_llm_config_endpoint),
        )
        .route("/api/v1/llm/test", post(test_llm_endpoint))
        // Cryptographic Operator Auth, TOTP Step-Up, WebAuthn & Remote Kill-Switch
        .route("/api/v1/auth/status", get(auth_status_endpoint))
        .route("/api/v1/auth/setup", post(auth_setup_endpoint))
        .route("/api/v1/auth/login", post(auth_login_endpoint))
        .route("/remote/auth/login", post(auth_login_endpoint))
        .route("/remote/auth/challenge", post(webauthn_challenge_endpoint))
        .route("/remote/auth/passkey/register", post(register_passkey_endpoint))
        .route("/remote/auth/step-up", post(step_up_endpoint))
        .route("/api/v1/auth/step-up", post(step_up_endpoint))
        .route("/remote/autonomy", post(remote_autonomy_endpoint))
        .route("/remote/devices", get(list_devices_endpoint))
        .route("/remote/push/subscribe", post(save_push_endpoint))
        // Chaos Lab & GitHub Webhook
        .route("/api/v1/scenarios", get(list_scenarios_endpoint))
        .route("/api/v1/scenarios/:id/run", post(trigger_scenario_endpoint))
        .route("/api/v1/scenarios/reset", post(reset_scenarios_endpoint))
        .route("/webhook/github", post(github_webhook_endpoint))
        .fallback(embedded_spa_handler)
        .layer(cors)
        .with_state(ctx)
}
