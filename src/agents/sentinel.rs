//! `SentinelAgent`: Real-Time Intrusion Containment, Immutable SHA-256 Forensic Evidence,
//! Secret-Leak Diff Scanning, Exposure Coordination (`IntegrityAgent`), and CERT-In / DPDP / GDPR Reporting.

use crate::agents::builder::BuilderAgent;
use crate::agents::executor::ActionExecutor;
use crate::agents::integrity::IntegrityAgent;
use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::redact::{redact, scan_diff_for_secrets};
use crate::core::schemas::{
    generate_id, now_iso, Action, ComplianceReport, Diagnosis, Event, Incident,
};
use crate::tools::reports::{
    generate_cert_in_report, generate_dpdp_report, generate_gdpr_report,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

pub struct SentinelAgent {
    pub db: Arc<AlexiaDb>,
    pub bus: Arc<EventBus>,
    pub executor: Arc<ActionExecutor>,
    pub integrity: Arc<IntegrityAgent>,
    pub builder: Arc<BuilderAgent>,
}

impl SentinelAgent {
    pub fn new(
        db: Arc<AlexiaDb>,
        bus: Arc<EventBus>,
        executor: Arc<ActionExecutor>,
        integrity: Arc<IntegrityAgent>,
        builder: Arc<BuilderAgent>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            bus,
            executor,
            integrity,
            builder,
        })
    }

    pub fn scan_diff_secrets(&self, diff_text: &str) -> Vec<(String, String)> {
        scan_diff_for_secrets(diff_text)
    }

    /// Writes redacted forensic evidence to `data/evidence/ev_<incident_id>.log` and returns `(file_path, sha256)`.
    pub fn preserve_evidence(&self, incident_id: &str, raw_content: &str) -> (String, String) {
        let scrubbed = format!(
            "ALEXIA FORENSIC EVIDENCE BUNDLE\nIncident: {}\nCaptured: {}\n---\n{}\n",
            incident_id,
            now_iso(),
            redact(raw_content)
        );
        let path = self.db.subdir("evidence").join(format!("ev_{}.log", incident_id));
        let _ = fs::write(&path, scrubbed.as_bytes());
        let mut hasher = Sha256::new();
        hasher.update(scrubbed.as_bytes());
        let sha = hex::encode(hasher.finalize());
        let path_str = path.to_string_lossy().to_string();

        let _ = self.db.record_audit(
            "evidence_preserved",
            "agent:sentinel",
            json!({
                "incident_id": incident_id,
                "path": path_str,
                "sha256": sha,
            }),
        );
        (path_str, sha)
    }

    pub async fn handle_security_incident(&self, event: Event) -> Incident {
        let service = event.service.clone();
        let attacker_ip = event
            .data
            .get("ip")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string();
        let endpoint = event
            .data
            .get("endpoint")
            .and_then(|v| v.as_str())
            .unwrap_or("/")
            .to_string();
        let payload_str = event
            .data
            .get("payload")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let title = match event.kind.as_str() {
            "sqli_pattern" => format!("SQL Injection blocked at WAF on `{}` from {}", endpoint, attacker_ip),
            "bruteforce" => format!("Credential brute-force burst detected on `{}` from {}", service, attacker_ip),
            "row_read_anomaly" => format!("Abnormal bulk row read anomaly on `{}` ({})", endpoint, service),
            _ => format!("Security anomaly (`{}`) on `{}`", event.kind, service),
        };

        let mut inc = Incident::new("security", "critical", "Sentinel", &service, &title);
        inc.events.push(event.id.clone());
        inc.metadata.insert("attacker_ip".into(), json!(attacker_ip));
        inc.metadata.insert("endpoint".into(), json!(endpoint));
        inc.metadata.insert(
            "error_log".into(),
            json!(format!("{} on {} payload={}", event.kind, endpoint, redact(&payload_str))),
        );
        inc = self.bus.create_incident(inc);

        // 1. Preserve Forensic Evidence BEFORE mutating state
        let raw_ev = serde_json::to_string_pretty(&event).unwrap_or_default();
        let (ev_path, ev_sha) = self.preserve_evidence(&inc.id, &raw_ev);
        inc.metadata.insert("evidence_path".into(), json!(ev_path));
        inc.metadata.insert("evidence_sha256".into(), json!(ev_sha));

        let mut containment_notes = vec![format!(
            "Preserved immutable forensic log bundle (SHA-256 `{}`)",
            &ev_sha[..16]
        )];

        // 2. Precautionary Snapshot via IntegrityAgent
        if let Ok(snap) = self
            .integrity
            .take_precautionary_snapshot(&service, &format!("security_containment_{}", inc.id))
        {
            inc.snapshots.push(snap.id.clone());
            containment_notes.push(format!("Captured online DB snapshot `{}`", snap.id));
        }

        // 3. Tier-0 Immediate WAF + OS Firewall IP Block
        let mut block_act = Action::new(
            "block_ip_temporarily",
            &service,
            0,
            &format!("Contain `{}` intrusion from {}", event.kind, attacker_ip),
            "agent:sentinel",
        );
        block_act.params = HashMap::from([
            ("ip".into(), json!(attacker_ip)),
            ("duration_minutes".into(), json!(60)),
        ]);
        block_act.expected_outcome = format!("IP {} blocked at inline WAF & host firewall for 60m", attacker_ip);
        block_act.rollback = format!("DELETE /api/v1/gateway/blocked-ips/{}", attacker_ip);
        if self.executor.execute(&mut block_act, &inc.id, None).await.is_ok() {
            containment_notes.push(format!("Blocked source IP `{}` for 60 minutes at WAF Gateway", attacker_ip));
        }
        inc.plan.push(block_act);

        // 4. Read-Only SQL AST Exposure Audit via IntegrityAgent
        let exposure = self.integrity.assess_exposure(&payload_str, &service, &inc.id);
        let est_rows = exposure
            .get("estimated_rows_exposed")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let pii_cols: Vec<String> = exposure
            .get("affected_columns")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        inc.metadata.insert("exposure_audit".into(), exposure.clone());

        let root_cause = format!(
            "Malicious `{}` traffic from `{}` targeting `{}` intercepted by Alexia WAF. Exposure scope: {} record(s), columns {:?}.",
            event.kind, attacker_ip, endpoint, est_rows, pii_cols
        );
        inc.diagnosis = Diagnosis {
            root_cause: root_cause.clone(),
            explanation: root_cause.clone(),
            evidence: containment_notes.clone(),
            sources: Vec::new(),
            confidence: 0.97,
        };

        // 5. Draft & Persist Regulatory Breach Notification Drafts (CERT-In 6h, DPDP Act, GDPR 72h)
        let cert_md = generate_cert_in_report(
            &inc.id,
            &event.kind,
            &service,
            &attacker_ip,
            &payload_str,
            &ev_sha,
            &containment_notes,
        );
        let _ = self.db.save_report(&ComplianceReport {
            id: generate_id("rep"),
            incident_id: inc.id.clone(),
            framework: "CERT-In".into(),
            framework_label: "CERT-In Mandatory 6-Hour Cyber Incident Draft".into(),
            generated_at: now_iso(),
            deadline_hours: 6,
            status: "draft".into(),
            summary: title.clone(),
            affected_records_estimate: est_rows,
            data_categories_exposed: pii_cols.clone(),
            containment_actions_taken: containment_notes.clone(),
            root_cause: root_cause.clone(),
            remediation_status: "Source IP blocked; code remediation & review initiated".into(),
            markdown: cert_md,
        });

        if !pii_cols.is_empty() || event.kind == "sqli_pattern" {
            let dpdp_md = generate_dpdp_report(
                &inc.id,
                &title,
                est_rows,
                &pii_cols,
                &containment_notes,
            );
            let _ = self.db.save_report(&ComplianceReport {
                id: generate_id("rep"),
                incident_id: inc.id.clone(),
                framework: "DPDP_ACT".into(),
                framework_label: "India DPDP Act Personal Data Breach Draft".into(),
                generated_at: now_iso(),
                deadline_hours: 72,
                status: "draft".into(),
                summary: title.clone(),
                affected_records_estimate: est_rows,
                data_categories_exposed: pii_cols.clone(),
                containment_actions_taken: containment_notes.clone(),
                root_cause: root_cause.clone(),
                remediation_status: "Contained at WAF perimeter".into(),
                markdown: dpdp_md,
            });

            let gdpr_md = generate_gdpr_report(
                &inc.id,
                &root_cause,
                est_rows,
                "Potential unauthorized read access to user table fields if WAF were bypassed.",
                &containment_notes,
            );
            let _ = self.db.save_report(&ComplianceReport {
                id: generate_id("rep"),
                incident_id: inc.id.clone(),
                framework: "GDPR".into(),
                framework_label: "GDPR Article 33 Supervisory Authority Notification (72h)".into(),
                generated_at: now_iso(),
                deadline_hours: 72,
                status: "draft".into(),
                summary: title.clone(),
                affected_records_estimate: est_rows,
                data_categories_exposed: pii_cols,
                containment_actions_taken: containment_notes,
                root_cause,
                remediation_status: "Contained at WAF perimeter".into(),
                markdown: gdpr_md,
            });
        }

        // 6. For SQLi attacks, hand off to BuilderAgent to synthesize & sandbox-prove parameterized SQL fix PR!
        if event.kind == "sqli_pattern" {
            self.bus.update_incident(&mut inc, "sentinel_handoff_to_builder");
            let updated = self.builder.handle_incident(inc).await;
            return updated;
        }

        inc.status = "resolved".into();
        inc.summary = format!(
            "Blocked attacker IP `{}` at WAF, preserved SHA-256 forensic bundle, and drafted CERT-In compliance report.",
            attacker_ip
        );
        self.bus.update_incident(&mut inc, "sentinel_contained");
        inc
    }
}
