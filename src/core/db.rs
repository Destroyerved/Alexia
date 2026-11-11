//! Pure-Rust ACID Transactional Persistence Engine (`redb`) + Tamper-Evident SHA-256 Audit Ledger.
//!
//! Zero C-compiler dependency (`libsqlite3-sys` not required); crash-safe copy-on-write B-tree transactions.

use crate::core::paths::db_path;
use crate::core::redact::{redact, redact_json};
use crate::core::schemas::{
    generate_id, now_iso, Action, AuditEntry, ComplianceReport, DeploymentRecord, Event, Incident,
    ModelCall, PendingApproval, PullRequestRecord, RunbookEntry, SnapshotRecord,
};
use anyhow::{Context, Result};
use parking_lot::RwLock;
use redb::{Database, ReadableTable, TableDefinition};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const TBL_EVENTS: TableDefinition<&str, &str> = TableDefinition::new("events");
const TBL_INCIDENTS: TableDefinition<&str, &str> = TableDefinition::new("incidents");
const TBL_AUDIT: TableDefinition<u64, &str> = TableDefinition::new("audit_chain");
const TBL_FIREWALL: TableDefinition<&str, &str> = TableDefinition::new("ip_blocklist");
const TBL_APPROVALS: TableDefinition<&str, &str> = TableDefinition::new("pending_approvals");
const TBL_DEPLOYMENTS: TableDefinition<&str, &str> = TableDefinition::new("deployments");
const TBL_REPORTS: TableDefinition<&str, &str> = TableDefinition::new("compliance_reports");
const TBL_PRS: TableDefinition<u64, &str> = TableDefinition::new("pull_requests");
const TBL_SNAPSHOTS: TableDefinition<&str, &str> = TableDefinition::new("snapshots");
const TBL_RUNBOOKS: TableDefinition<&str, &str> = TableDefinition::new("runbooks");
const TBL_MODEL_CALLS: TableDefinition<&str, &str> = TableDefinition::new("model_calls");
const TBL_TAVILY_CACHE: TableDefinition<&str, &str> = TableDefinition::new("tavily_cache");
const TBL_OPERATORS: TableDefinition<&str, &str> = TableDefinition::new("operators");
const TBL_DEVICES: TableDefinition<&str, &str> = TableDefinition::new("devices");
const TBL_PUSH_SUBS: TableDefinition<&str, &str> = TableDefinition::new("push_subscriptions");
const TBL_SETTINGS: TableDefinition<&str, &str> = TableDefinition::new("settings");

pub const GENESIS_PREV_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpBlockRecord {
    pub ip: String,
    pub reason: String,
    pub blocked_at_epoch: f64,
    pub expires_at_epoch: f64,
    pub blocked_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorRecord {
    pub username: String,
    pub password_scrypt: String,
    pub totp_secret: String,
    pub role: String,
    pub created_at: String,
    #[serde(default)]
    pub passkeys: Vec<PasskeyCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasskeyCredential {
    pub credential_id: String,
    pub public_key_pem: String,
    pub sign_count: u32,
    pub label: String,
    pub registered_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub device_id: String,
    pub user: String,
    pub device_name: String,
    pub platform: String,
    pub ip_address: String,
    pub last_seen: String,
    pub revoked: bool,
}

/// Canonical deterministic JSON stringifier (sorted object keys) for reproducible SHA-256 audit hashing.
pub fn canonical_json_string(val: &Value) -> String {
    match val {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let k_json = serde_json::to_string(k).unwrap_or_default();
                    format!("{}:{}", k_json, canonical_json_string(&map[k]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json_string).collect();
            format!("[{}]", parts.join(","))
        }
        _ => serde_json::to_string(val).unwrap_or_else(|_| "null".to_string()),
    }
}

pub fn compute_audit_hash(
    id: u64,
    timestamp: &str,
    event_type: &str,
    actor: &str,
    details: &Value,
    prev_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    let payload = format!(
        "{}|{}|{}|{}|{}|{}",
        id,
        timestamp,
        event_type,
        actor,
        canonical_json_string(details),
        prev_hash
    );
    hasher.update(payload.as_bytes());
    hex::encode(hasher.finalize())
}

pub struct AlexiaDb {
    path: PathBuf,
    db: RwLock<Arc<Database>>,
}

impl AlexiaDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>> {
        let p = path.as_ref().to_path_buf();
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let database = Database::create(&p)
            .with_context(|| format!("Failed to open or create redb database at {}", p.display()))?;

        // Initialize all tables in a single write transaction so reads never encounter missing tables
        {
            let write_txn = database.begin_write()?;
            let _ = write_txn.open_table(TBL_EVENTS)?;
            let _ = write_txn.open_table(TBL_INCIDENTS)?;
            let _ = write_txn.open_table(TBL_AUDIT)?;
            let _ = write_txn.open_table(TBL_FIREWALL)?;
            let _ = write_txn.open_table(TBL_APPROVALS)?;
            let _ = write_txn.open_table(TBL_DEPLOYMENTS)?;
            let _ = write_txn.open_table(TBL_REPORTS)?;
            let _ = write_txn.open_table(TBL_PRS)?;
            let _ = write_txn.open_table(TBL_SNAPSHOTS)?;
            let _ = write_txn.open_table(TBL_RUNBOOKS)?;
            let _ = write_txn.open_table(TBL_MODEL_CALLS)?;
            let _ = write_txn.open_table(TBL_TAVILY_CACHE)?;
            let _ = write_txn.open_table(TBL_OPERATORS)?;
            let _ = write_txn.open_table(TBL_DEVICES)?;
            let _ = write_txn.open_table(TBL_PUSH_SUBS)?;
            let _ = write_txn.open_table(TBL_SETTINGS)?;
            write_txn.commit()?;
        }

        Ok(Arc::new(Self {
            path: p,
            db: RwLock::new(Arc::new(database)),
        }))
    }

    pub fn open_default() -> Result<Arc<Self>> {
        Self::open(db_path())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn data_dir(&self) -> PathBuf {
        let dir = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("data"));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    pub fn subdir(&self, name: &str) -> PathBuf {
        let d = self.data_dir().join(name);
        let _ = fs::create_dir_all(&d);
        d
    }

    pub fn size_bytes(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    fn db_handle(&self) -> Arc<Database> {
        self.db.read().clone()
    }

    fn put_json<T: Serialize>(&self, table: TableDefinition<&str, &str>, key: &str, val: &T) -> Result<()> {
        let encoded = serde_json::to_string(val)?;
        let db = self.db_handle();
        let txn = db.begin_write()?;
        {
            let mut t = txn.open_table(table)?;
            t.insert(key, encoded.as_str())?;
        }
        txn.commit()?;
        Ok(())
    }

    fn get_json<T: DeserializeOwned>(&self, table: TableDefinition<&str, &str>, key: &str) -> Result<Option<T>> {
        let db = self.db_handle();
        let txn = db.begin_read()?;
        let t = txn.open_table(table)?;
        if let Some(guard) = t.get(key)? {
            let parsed = serde_json::from_str::<T>(guard.value())?;
            Ok(Some(parsed))
        } else {
            Ok(None)
        }
    }

    fn list_json_values<T: DeserializeOwned>(&self, table: TableDefinition<&str, &str>) -> Result<Vec<T>> {
        let db = self.db_handle();
        let txn = db.begin_read()?;
        let t = txn.open_table(table)?;
        let mut out = Vec::new();
        for item in t.iter()? {
            let (_, v) = item?;
            if let Ok(parsed) = serde_json::from_str::<T>(v.value()) {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------------
    // SHA-256 Tamper-Evident Cryptographic Audit Chain
    // ------------------------------------------------------------------
    pub fn record_audit(&self, event_type: &str, actor: &str, details: Value) -> Result<AuditEntry> {
        let redacted_details = redact_json(&details);
        let ts = now_iso();
        let db = self.db_handle();
        let txn = db.begin_write()?;
        let entry = {
            let mut t = txn.open_table(TBL_AUDIT)?;
            let (next_id, prev_hash) = match t.iter()?.next_back() {
                Some(Ok((seq_guard, val_guard))) => {
                    let prev: AuditEntry = serde_json::from_str(val_guard.value())?;
                    (seq_guard.value() + 1, prev.entry_hash)
                }
                _ => (1u64, GENESIS_PREV_HASH.to_string()),
            };
            let entry_hash = compute_audit_hash(next_id, &ts, event_type, actor, &redacted_details, &prev_hash);
            let e = AuditEntry {
                id: next_id,
                timestamp: ts,
                event_type: event_type.to_string(),
                actor: redact(actor),
                details: redacted_details,
                prev_hash,
                entry_hash,
            };
            let raw = serde_json::to_string(&e)?;
            t.insert(next_id, raw.as_str())?;
            e
        };
        txn.commit()?;
        Ok(entry)
    }

    /// Verifies every link and SHA-256 digest in the cryptographic audit ledger.
    /// Returns `(is_valid, verified_rows, optional_error_message)`.
    pub fn verify_audit_chain(&self) -> (bool, usize, Option<String>) {
        let db = self.db_handle();
        let Ok(txn) = db.begin_read() else {
            return (false, 0, Some("Unable to begin read transaction on audit ledger".into()));
        };
        let Ok(t) = txn.open_table(TBL_AUDIT) else {
            return (false, 0, Some("Audit ledger table missing".into()));
        };
        let Ok(iter) = t.iter() else {
            return (false, 0, Some("Unable to iterate audit ledger".into()));
        };

        let mut expected_prev = GENESIS_PREV_HASH.to_string();
        let mut count = 0usize;
        for row_res in iter {
            let Ok((seq, raw_val)) = row_res else {
                return (false, count, Some("Corrupted B-tree record in audit ledger".into()));
            };
            let Ok(entry) = serde_json::from_str::<AuditEntry>(raw_val.value()) else {
                return (false, count, Some(format!("Malformed JSON in audit block #{}", seq.value())));
            };
            if entry.prev_hash != expected_prev {
                return (
                    false,
                    count,
                    Some(format!(
                        "Broken hash-chain link at block #{}: expected prev_hash {}, found {}",
                        entry.id, expected_prev, entry.prev_hash
                    )),
                );
            }
            let recomputed = compute_audit_hash(
                entry.id,
                &entry.timestamp,
                &entry.event_type,
                &entry.actor,
                &entry.details,
                &entry.prev_hash,
            );
            if recomputed != entry.entry_hash {
                return (
                    false,
                    count,
                    Some(format!(
                        "Tamper detected at audit block #{}: SHA-256 digest mismatch (expected {}, computed {})",
                        entry.id, entry.entry_hash, recomputed
                    )),
                );
            }
            expected_prev = entry.entry_hash;
            count += 1;
        }
        (true, count, None)
    }

    pub fn list_audit_entries(&self, limit: usize) -> Vec<AuditEntry> {
        let db = self.db_handle();
        let Ok(txn) = db.begin_read() else { return Vec::new() };
        let Ok(t) = txn.open_table(TBL_AUDIT) else { return Vec::new() };
        let Ok(iter) = t.iter() else { return Vec::new() };
        let mut out = Vec::new();
        for item in iter.rev().take(limit) {
            if let Ok((_, v)) = item {
                if let Ok(parsed) = serde_json::from_str::<AuditEntry>(v.value()) {
                    out.push(parsed);
                }
            }
        }
        out
    }

    /// Low-level raw overwrite used in tamper-detection tests to prove `verify_audit_chain` catches unauthorized edits.
    pub fn raw_overwrite_audit_block(&self, id: u64, mutated: &AuditEntry) -> Result<()> {
        let db = self.db_handle();
        let txn = db.begin_write()?;
        {
            let mut t = txn.open_table(TBL_AUDIT)?;
            let raw = serde_json::to_string(mutated)?;
            t.insert(id, raw.as_str())?;
        }
        txn.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Events & Incidents
    // ------------------------------------------------------------------
    pub fn persist_event(&self, evt: &Event) -> Result<()> {
        self.put_json(TBL_EVENTS, &evt.id, evt)
    }

    pub fn upsert_incident(&self, inc: &mut Incident) -> Result<()> {
        inc.updated_at = now_iso();
        if inc.status == "resolved" && inc.resolved_at.is_none() {
            inc.resolved_at = Some(inc.updated_at.clone());
        }
        inc.sync_fields();
        self.put_json(TBL_INCIDENTS, &inc.id, inc)
    }

    pub fn get_incident(&self, id: &str) -> Option<Incident> {
        self.get_json(TBL_INCIDENTS, id).ok().flatten()
    }

    pub fn list_incidents(&self, status_filter: Option<&str>, limit: usize) -> Vec<Incident> {
        let mut all: Vec<Incident> = self.list_json_values(TBL_INCIDENTS).unwrap_or_default();
        if let Some(st) = status_filter {
            all.retain(|i| i.status == st);
        }
        all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        all.truncate(limit);
        all
    }

    // ------------------------------------------------------------------
    // WAF Firewall IP Blocklist
    // ------------------------------------------------------------------
    pub fn upsert_ip_block(&self, rec: &IpBlockRecord) -> Result<()> {
        self.put_json(TBL_FIREWALL, &rec.ip, rec)
    }

    pub fn remove_ip_block(&self, ip: &str) -> Result<()> {
        let db = self.db_handle();
        let txn = db.begin_write()?;
        {
            let mut t = txn.open_table(TBL_FIREWALL)?;
            let _ = t.remove(ip)?;
        }
        txn.commit()?;
        Ok(())
    }

    pub fn clear_ip_blocks(&self) -> Result<Vec<String>> {
        let db = self.db_handle();
        let txn = db.begin_write()?;
        let cleared = {
            let mut t = txn.open_table(TBL_FIREWALL)?;
            let keys: Vec<String> = t
                .iter()?
                .filter_map(|r| r.ok().map(|(k, _)| k.value().to_string()))
                .collect();
            for k in &keys {
                let _ = t.remove(k.as_str())?;
            }
            keys
        };
        txn.commit()?;
        Ok(cleared)
    }

    pub fn list_ip_blocks(&self) -> Vec<IpBlockRecord> {
        self.list_json_values(TBL_FIREWALL).unwrap_or_default()
    }

    // ------------------------------------------------------------------
    // Approvals, Deployments, Reports & Pull Requests
    // ------------------------------------------------------------------
    pub fn upsert_approval(&self, rec: &PendingApproval) -> Result<()> {
        self.put_json(TBL_APPROVALS, &rec.action_id, rec)
    }

    pub fn get_approval(&self, action_id: &str) -> Option<PendingApproval> {
        self.get_json(TBL_APPROVALS, action_id).ok().flatten()
    }

    pub fn list_approvals(&self, pending_only: bool) -> Vec<PendingApproval> {
        let now_ep = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
        let mut all: Vec<PendingApproval> = self.list_json_values(TBL_APPROVALS).unwrap_or_default();
        for a in &mut all {
            if a.status == "pending" && now_ep > a.expires_at_epoch {
                a.status = "expired".to_string();
                let _ = self.put_json(TBL_APPROVALS, &a.action_id, a);
            }
        }
        if pending_only {
            all.retain(|a| a.status == "pending");
        }
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        all
    }

    pub fn upsert_deployment(&self, dep: &DeploymentRecord) -> Result<()> {
        self.put_json(TBL_DEPLOYMENTS, &dep.id, dep)
    }

    pub fn get_deployment(&self, id: &str) -> Option<DeploymentRecord> {
        self.get_json(TBL_DEPLOYMENTS, id).ok().flatten()
    }

    pub fn list_deployments(&self) -> Vec<DeploymentRecord> {
        let mut all: Vec<DeploymentRecord> = self.list_json_values(TBL_DEPLOYMENTS).unwrap_or_default();
        all.sort_by(|a, b| b.deployed_at.cmp(&a.deployed_at));
        all
    }

    pub fn save_report(&self, report: &ComplianceReport) -> Result<()> {
        self.put_json(TBL_REPORTS, &report.id, report)
    }

    pub fn list_reports(&self) -> Vec<ComplianceReport> {
        let mut all: Vec<ComplianceReport> = self.list_json_values(TBL_REPORTS).unwrap_or_default();
        all.sort_by(|a, b| b.generated_at.cmp(&a.generated_at));
        all
    }

    pub fn insert_pr(&self, mut pr: PullRequestRecord) -> Result<PullRequestRecord> {
        let db = self.db_handle();
        let txn = db.begin_write()?;
        {
            let mut t = txn.open_table(TBL_PRS)?;
            let next_num = match t.iter()?.next_back() {
                Some(Ok((k, _))) => k.value() + 1,
                _ => 1,
            };
            pr.number = pr.github_pr_number.unwrap_or(next_num);
            if pr.html_url.is_empty() {
                let short_sha = &pr.commit_sha[..pr.commit_sha.len().min(10)];
                pr.html_url = format!("git://{}/branches/{}@{}", pr.service, pr.branch, short_sha);
            }
            let raw = serde_json::to_string(&pr)?;
            t.insert(next_num, raw.as_str())?;
        }
        txn.commit()?;
        Ok(pr)
    }

    pub fn get_pr(&self, number: u64, branch: Option<&str>) -> Option<PullRequestRecord> {
        let db = self.db_handle();
        let txn = db.begin_read().ok()?;
        let t = txn.open_table(TBL_PRS).ok()?;
        for item in t.iter().ok()?.rev() {
            let (_, val) = item.ok()?;
            if let Ok(rec) = serde_json::from_str::<PullRequestRecord>(val.value()) {
                if rec.number == number || rec.github_pr_number == Some(number) {
                    return Some(rec);
                }
                if let Some(br) = branch {
                    if rec.branch == br {
                        return Some(rec);
                    }
                }
            }
        }
        None
    }

    pub fn mark_pr_merged(&self, number: u64) -> Result<()> {
        let db = self.db_handle();
        let txn = db.begin_write()?;
        {
            let mut t = txn.open_table(TBL_PRS)?;
            let mut target_key = None;
            let mut updated = None;
            for item in t.iter()? {
                let (k, v) = item?;
                if let Ok(mut rec) = serde_json::from_str::<PullRequestRecord>(v.value()) {
                    if rec.number == number || rec.github_pr_number == Some(number) {
                        rec.state = "merged".to_string();
                        rec.merged_at = Some(now_iso());
                        target_key = Some(k.value());
                        updated = Some(serde_json::to_string(&rec)?);
                        break;
                    }
                }
            }
            if let (Some(k), Some(raw)) = (target_key, updated) {
                t.insert(k, raw.as_str())?;
            }
        }
        txn.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Online MVCC Database Snapshots & Restore (Windows LockFileEx-Safe)
    // ------------------------------------------------------------------
    pub fn create_snapshot(&self, service: &str, source_file: Option<&Path>, reason: &str) -> Result<SnapshotRecord> {
        let snap_id = generate_id("snap");
        let dest = self.subdir("snapshots").join(format!("{}_{}.bak", service, snap_id));

        match source_file {
            Some(ext) if ext != self.path && ext.exists() => {
                fs::copy(ext, &dest)?;
            }
            _ => {
                // Perform a crash-consistent MVCC read-transaction logical snapshot of `redb`
                // (never conflicts with Windows `LockFileEx` byte-range locks on the open `.redb` file)
                let db = self.db_handle();
                let txn = db.begin_read()?;
                let mut dump = serde_json::Map::new();
                for (name, tbl_def) in [
                    ("incidents", TBL_INCIDENTS),
                    ("ip_blocklist", TBL_FIREWALL),
                    ("deployments", TBL_DEPLOYMENTS),
                    ("runbooks", TBL_RUNBOOKS),
                    ("settings", TBL_SETTINGS),
                ] {
                    let mut rows = serde_json::Map::new();
                    if let Ok(t) = txn.open_table(tbl_def) {
                        if let Ok(iter) = t.iter() {
                            for item in iter.flatten() {
                                rows.insert(
                                    item.0.value().to_string(),
                                    Value::String(item.1.value().to_string()),
                                );
                            }
                        }
                    }
                    dump.insert(name.to_string(), Value::Object(rows));
                }
                let payload = serde_json::to_vec_pretty(&json!({
                    "format": "alexia_redb_mvcc_snapshot_v1",
                    "service": service,
                    "created_at": now_iso(),
                    "tables": dump,
                }))?;
                fs::write(&dest, payload)?;
            }
        }

        let bytes = fs::read(&dest)?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let sha = hex::encode(hasher.finalize());

        let rec = SnapshotRecord {
            id: snap_id.clone(),
            service: service.to_string(),
            db_engine: "redb".to_string(),
            path: dest.to_string_lossy().to_string(),
            sha256: sha,
            size_bytes: bytes.len() as u64,
            reason: reason.to_string(),
            created_at: now_iso(),
            verified: true,
        };
        self.put_json(TBL_SNAPSHOTS, &rec.id, &rec)?;
        let _ = self.record_audit(
            "snapshot_created",
            "agent:integrity",
            json!({"snapshot_id": rec.id, "service": service, "sha256": rec.sha256, "size_bytes": rec.size_bytes}),
        );
        Ok(rec)
    }

    pub fn restore_snapshot(&self, snap_id: &str, dest_override: Option<&Path>) -> Result<SnapshotRecord> {
        let rec: SnapshotRecord = self
            .get_json(TBL_SNAPSHOTS, snap_id)?
            .with_context(|| format!("Snapshot {} not found", snap_id))?;
        let snap_path = PathBuf::from(&rec.path);
        let bytes = fs::read(&snap_path)
            .with_context(|| format!("Snapshot file missing on disk: {}", snap_path.display()))?;

        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let current_sha = hex::encode(hasher.finalize());
        if current_sha != rec.sha256 {
            anyhow::bail!("Snapshot SHA-256 integrity check failed before restore!");
        }

        if let Some(target_file) = dest_override {
            if let Some(parent) = target_file.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(target_file, &bytes)?;
        }
        let _ = self.record_audit(
            "snapshot_restored",
            "agent:integrity",
            json!({"snapshot_id": rec.id, "service": rec.service, "sha256": rec.sha256}),
        );
        Ok(rec)
    }

    pub fn list_snapshots(&self) -> Vec<SnapshotRecord> {
        let mut all: Vec<SnapshotRecord> = self.list_json_values(TBL_SNAPSHOTS).unwrap_or_default();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        all
    }

    // ------------------------------------------------------------------
    // Runbook Memory
    // ------------------------------------------------------------------
    pub fn record_runbook(
        &self,
        category: &str,
        service: &str,
        error_indicator: &str,
        root_cause: &str,
        actions: &[Action],
    ) -> Result<RunbookEntry> {
        let norm_err = error_indicator.trim().to_lowercase();
        let sig_input = format!("{}|{}|{}", category, service, &norm_err[..norm_err.len().min(60)]);
        let mut hasher = Sha256::new();
        hasher.update(sig_input.as_bytes());
        let sig = hex::encode(hasher.finalize())[..20].to_string();

        let existing: Option<RunbookEntry> = self.get_json(TBL_RUNBOOKS, &sig)?;
        let entry = match existing {
            Some(mut prev) => {
                prev.success_count += 1;
                prev.updated_at = now_iso();
                prev
            }
            None => RunbookEntry {
                id: generate_id("rb"),
                signature: sig.clone(),
                category: category.to_string(),
                service: service.to_string(),
                error_indicator: norm_err[..norm_err.len().min(60)].to_string(),
                root_cause: root_cause.to_string(),
                actions: actions.to_vec(),
                success_count: 1,
                updated_at: now_iso(),
            },
        };
        self.put_json(TBL_RUNBOOKS, &sig, &entry)?;
        Ok(entry)
    }

    pub fn find_matching_runbook(
        &self,
        category: &str,
        service: &str,
        error_indicator: &str,
    ) -> Option<RunbookEntry> {
        let norm_err = error_indicator.trim().to_lowercase();
        let sig_input = format!("{}|{}|{}", category, service, &norm_err[..norm_err.len().min(60)]);
        let mut hasher = Sha256::new();
        hasher.update(sig_input.as_bytes());
        let sig = hex::encode(hasher.finalize())[..20].to_string();
        self.get_json(TBL_RUNBOOKS, &sig).ok().flatten()
    }

    // ------------------------------------------------------------------
    // Model Budget Guard & Tavily Cache
    // ------------------------------------------------------------------
    pub fn record_model_call(&self, call: &ModelCall) -> Result<()> {
        self.put_json(TBL_MODEL_CALLS, &call.id, call)
    }

    pub fn get_daily_budget_stats(&self, daily_ceiling_usd: f64) -> Value {
        let today = &now_iso()[..10];
        let mut calls: Vec<ModelCall> = self.list_json_values(TBL_MODEL_CALLS).unwrap_or_default();
        calls.sort_by(|a, b| b.ts.cmp(&a.ts));

        let mut total_spend = 0.0f64;
        let mut total_tokens = 0u64;
        let mut by_tier: HashMap<String, Value> = HashMap::new();
        for tier in ["nano", "super", "ultra"] {
            by_tier.insert(
                tier.to_string(),
                json!({"calls": 0, "tokens": 0, "cost_usd": 0.0}),
            );
        }

        for c in &calls {
            if c.ts.starts_with(today) {
                total_spend += c.cost_usd;
                total_tokens += c.total_tokens as u64;
                let entry = by_tier
                    .entry(c.tier.clone())
                    .or_insert_with(|| json!({"calls": 0, "tokens": 0, "cost_usd": 0.0}));
                if let Some(obj) = entry.as_object_mut() {
                    let prev_calls = obj.get("calls").and_then(|v| v.as_u64()).unwrap_or(0);
                    let prev_toks = obj.get("tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let prev_cost = obj.get("cost_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    obj.insert("calls".into(), json!(prev_calls + 1));
                    obj.insert("tokens".into(), json!(prev_toks + c.total_tokens as u64));
                    obj.insert("cost_usd".into(), json!(((prev_cost + c.cost_usd) * 1_000_000.0).round() / 1_000_000.0));
                }
            }
        }

        let recent: Vec<ModelCall> = calls.into_iter().take(40).collect();
        json!({
            "date": today,
            "daily_spend_usd": (total_spend * 1_000_000.0).round() / 1_000_000.0,
            "daily_ceiling_usd": daily_ceiling_usd,
            "remaining_budget_usd": ((daily_ceiling_usd - total_spend).max(0.0) * 1_000_000.0).round() / 1_000_000.0,
            "total_tokens": total_tokens,
            "by_tier": by_tier,
            "recent_calls": recent,
        })
    }

    pub fn get_tavily_cache(&self, query_hash: &str, now_epoch: f64) -> Option<String> {
        let val: Value = self.get_json(TBL_TAVILY_CACHE, query_hash).ok().flatten()?;
        let exp = val.get("expires_at")?.as_f64()?;
        if exp > now_epoch {
            val.get("results_json")?.as_str().map(|s| s.to_string())
        } else {
            None
        }
    }

    pub fn set_tavily_cache(&self, query_hash: &str, query: &str, results_json: &str, expires_at: f64) -> Result<()> {
        self.put_json(
            TBL_TAVILY_CACHE,
            query_hash,
            &json!({
                "query": query,
                "results_json": results_json,
                "expires_at": expires_at,
            }),
        )
    }

    // ------------------------------------------------------------------
    // Operators, Devices, Push & Settings
    // ------------------------------------------------------------------
    pub fn upsert_operator(&self, op: &OperatorRecord) -> Result<()> {
        self.put_json(TBL_OPERATORS, &op.username, op)
    }

    pub fn get_operator(&self, username: &str) -> Option<OperatorRecord> {
        self.get_json(TBL_OPERATORS, username).ok().flatten()
    }

    pub fn list_operators(&self) -> Vec<OperatorRecord> {
        self.list_json_values(TBL_OPERATORS).unwrap_or_default()
    }

    pub fn upsert_device(&self, dev: &DeviceRecord) -> Result<()> {
        self.put_json(TBL_DEVICES, &dev.device_id, dev)
    }

    pub fn list_devices(&self) -> Vec<DeviceRecord> {
        self.list_json_values(TBL_DEVICES).unwrap_or_default()
    }

    pub fn save_push_subscription(&self, endpoint: &str, sub: &Value) -> Result<()> {
        self.put_json(TBL_PUSH_SUBS, endpoint, sub)
    }

    pub fn get_settings(&self) -> HashMap<String, Value> {
        let mut defaults: HashMap<String, Value> = HashMap::from([
            ("daily_budget_usd".into(), json!(10.0)),
            ("approval_ttl_seconds".into(), json!(300)),
            ("llm_provider".into(), json!("auto")),
            ("llm_base_url".into(), json!("")),
            ("llm_fast_model".into(), json!("")),
            ("llm_coding_model".into(), json!("")),
            ("llm_reasoning_model".into(), json!("")),
            ("waf_mode".into(), json!("enforce")),
        ]);
        if let Ok(Some(saved)) = self.get_json::<HashMap<String, Value>>(TBL_SETTINGS, "global") {
            for (k, v) in saved {
                defaults.insert(k, v);
            }
        }
        defaults
    }

    pub fn update_settings(&self, updates: &HashMap<String, Value>) -> Result<HashMap<String, Value>> {
        let mut merged = self.get_settings();
        for (k, v) in updates {
            merged.insert(k.clone(), v.clone());
        }
        self.put_json(TBL_SETTINGS, "global", &merged)?;
        Ok(merged)
    }
}
