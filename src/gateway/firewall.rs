//! Sub-microsecond DashMap + ACID `redb` IP Blocklist & Host OS Firewall Enforcement Engine.

use crate::core::db::{AlexiaDb, IpBlockRecord};
use chrono::{TimeZone, Utc};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::env;
use std::net::IpAddr;
use std::process::Command;
use std::sync::Arc;

/// Strictly parses and canonicalizes IPv4 / IPv6 addresses, preventing command or header injection.
pub fn normalize_ip(raw: &str) -> Result<String, String> {
    let cleaned = raw.trim();
    if cleaned == "testclient" || cleaned == "localhost" {
        return Ok("127.0.0.1".to_string());
    }
    cleaned
        .parse::<IpAddr>()
        .map(|ip| ip.to_string())
        .map_err(|e| format!("Invalid IP address '{}': {}", raw, e))
}

pub struct FirewallManager {
    db: Arc<AlexiaDb>,
    cache: DashMap<String, IpBlockRecord>,
}

impl FirewallManager {
    pub fn new(db: Arc<AlexiaDb>) -> Arc<Self> {
        let mgr = Arc::new(Self {
            db,
            cache: DashMap::new(),
        });
        mgr.reload_from_db();
        mgr
    }

    fn now_epoch() -> f64 {
        Utc::now().timestamp_millis() as f64 / 1000.0
    }

    pub fn reload_from_db(&self) {
        let now = Self::now_epoch();
        self.cache.clear();
        for rec in self.db.list_ip_blocks() {
            if rec.expires_at_epoch > now {
                self.cache.insert(rec.ip.clone(), rec);
            } else {
                let _ = self.db.remove_ip_block(&rec.ip);
            }
        }
    }

    pub fn block_ip(&self, raw_ip: &str, duration_minutes: u64, reason: &str) -> Result<Value, String> {
        let ip = normalize_ip(raw_ip)?;
        let mins = duration_minutes.clamp(1, 1440);
        let now = Self::now_epoch();
        let exp = now + (mins as f64 * 60.0);

        let blocked_iso = Utc
            .timestamp_opt(now as i64, 0)
            .single()
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        let expires_iso = Utc
            .timestamp_opt(exp as i64, 0)
            .single()
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();

        let rec = IpBlockRecord {
            ip: ip.clone(),
            reason: reason.to_string(),
            blocked_at_epoch: now,
            expires_at_epoch: exp,
            blocked_at: blocked_iso,
            expires_at: expires_iso.clone(),
        };

        let _ = self.db.upsert_ip_block(&rec);
        self.cache.insert(ip.clone(), rec);

        let mut layers = vec!["alexia_rust_waf_gateway".to_string()];
        if let Some(os_layer) = Self::apply_os_firewall_rule(&ip, true) {
            layers.push(os_layer);
        }

        Ok(json!({
            "ip": ip,
            "duration_minutes": mins,
            "reason": reason,
            "expires_at": expires_iso,
            "enforcement_layers": layers,
        }))
    }

    pub fn unblock_ip(&self, raw_ip: &str) -> Result<Value, String> {
        let ip = normalize_ip(raw_ip)?;
        self.cache.remove(&ip);
        let _ = self.db.remove_ip_block(&ip);
        let _ = Self::apply_os_firewall_rule(&ip, false);
        Ok(json!({"ip": ip, "unblocked": true}))
    }

    pub fn clear_all(&self) -> usize {
        let count = self.cache.len();
        let ips: Vec<String> = self.cache.iter().map(|r| r.key().clone()).collect();
        self.cache.clear();
        let _ = self.db.clear_ip_blocks();
        for ip in ips {
            let _ = Self::apply_os_firewall_rule(&ip, false);
        }
        count
    }

    pub fn get_block_entry(&self, raw_ip: &str) -> Option<Value> {
        let ip = normalize_ip(raw_ip).ok()?;
        let now = Self::now_epoch();
        if let Some(entry) = self.cache.get(&ip) {
            if entry.expires_at_epoch > now {
                let rem = (entry.expires_at_epoch - now).max(0.0) as u64;
                return Some(json!({
                    "ip": entry.ip,
                    "reason": entry.reason,
                    "blocked_at": entry.blocked_at,
                    "expires_at": entry.expires_at,
                    "seconds_remaining": rem,
                }));
            }
        }
        self.cache.remove(&ip);
        let _ = self.db.remove_ip_block(&ip);
        None
    }

    pub fn is_ip_blocked(&self, raw_ip: &str) -> bool {
        self.get_block_entry(raw_ip).is_some()
    }

    pub fn list_blocked_ips(&self) -> Vec<Value> {
        let now = Self::now_epoch();
        let mut expired = Vec::new();
        let mut active = Vec::new();
        for item in self.cache.iter() {
            let rec = item.value();
            if rec.expires_at_epoch <= now {
                expired.push(rec.ip.clone());
            } else {
                active.push(json!({
                    "ip": rec.ip,
                    "reason": rec.reason,
                    "blocked_at": rec.blocked_at,
                    "expires_at": rec.expires_at,
                    "seconds_remaining": (rec.expires_at_epoch - now).max(0.0) as u64,
                }));
            }
        }
        for ip in expired {
            self.cache.remove(&ip);
            let _ = self.db.remove_ip_block(&ip);
        }
        active
    }

    fn apply_os_firewall_rule(canonical_ip: &str, block: bool) -> Option<String> {
        let enabled = env::var("ALEXIA_ENABLE_OS_FIREWALL")
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !enabled || canonical_ip == "127.0.0.1" || canonical_ip == "::1" {
            return None;
        }
        let rule_name = format!("Alexia_Block_{}", canonical_ip.replace(':', "_"));
        if cfg!(windows) {
            let status = if block {
                Command::new("netsh")
                    .args([
                        "advfirewall",
                        "firewall",
                        "add",
                        "rule",
                        &format!("name={}", rule_name),
                        "dir=in",
                        "action=block",
                        &format!("remoteip={}", canonical_ip),
                    ])
                    .output()
            } else {
                Command::new("netsh")
                    .args([
                        "advfirewall",
                        "firewall",
                        "delete",
                        "rule",
                        &format!("name={}", rule_name),
                    ])
                    .output()
            };
            if status.map(|o| o.status.success()).unwrap_or(false) {
                return Some("windows_advfirewall".into());
            }
        } else {
            let flag = if block { "-I" } else { "-D" };
            let status = Command::new("iptables")
                .args([flag, "INPUT", "-s", canonical_ip, "-j", "DROP"])
                .output();
            if status.map(|o| o.status.success()).unwrap_or(false) {
                return Some("linux_iptables".into());
            }
        }
        None
    }
}
