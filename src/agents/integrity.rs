//! `IntegrityAgent`: Online SHA-256 Database Snapshots, Read-Only SQL AST Exposure Audits,
//! and Non-Destructive Schema Migration Dry-Run Gates.

use crate::core::db::AlexiaDb;
use crate::core::schemas::SnapshotRecord;
use crate::tools::sql_audit::{assess_sql_exposure, dry_run_sql_migration};
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct IntegrityAgent {
    pub db: Arc<AlexiaDb>,
}

impl IntegrityAgent {
    pub fn new(db: Arc<AlexiaDb>) -> Arc<Self> {
        Arc::new(Self { db })
    }

    pub fn take_precautionary_snapshot(&self, service: &str, reason: &str) -> Result<SnapshotRecord> {
        self.db.create_snapshot(service, None, reason)
    }

    pub fn assess_exposure(&self, payload: &str, service: &str, incident_id: &str) -> Value {
        let report = assess_sql_exposure(payload, service);
        let _ = self.db.record_audit(
            "exposure_audit_completed",
            "agent:integrity",
            json!({
                "incident_id": incident_id,
                "service": service,
                "report": report,
            }),
        );
        report
    }

    pub fn review_migration(&self, sql: &str, service: &str) -> Value {
        let report = dry_run_sql_migration(sql, service);
        let _ = self.db.record_audit(
            "migration_dry_run_completed",
            "agent:integrity",
            json!({
                "service": service,
                "is_destructive": report.get("is_destructive"),
                "dropped_columns": report.get("dropped_columns"),
                "dropped_tables": report.get("dropped_tables"),
            }),
        );
        report
    }
}
