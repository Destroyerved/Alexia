//! High-Speed Axum Inline Reverse-Proxy WAF Gateway (`:8000` standalone & `/gateway/:service/*path`).
//!
//! Enforces:
//! 1. Instant `HTTP 403` blocked IP drop (`DashMap` lookup)
//! 2. `HTTP 503` service network quarantine (`RuntimeSupervisor::is_isolated`)
//! 3. `HTTP 429` sliding-window per-IP rate limiting
//! 4. `HTTP 403` SQL injection payload interception + async `sqli_pattern` telemetry to `EventBus`
//! 5. Post-forward `401`/`403` brute-force burst detection, `5xx` error spikes, and JSON row-read anomalies.

use crate::core::bus::EventBus;
use crate::core::schemas::{Event, TargetServiceConfig};
use crate::gateway::firewall::{normalize_ip, FirewallManager};
use crate::runtime::RuntimeSupervisor;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::any,
    Router,
};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Instant;

static SQLI_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)\bunion\s+(?:all\s+)?select\b").unwrap(),
        Regex::new(r"(?i)(?:'|%27|\b)\s*or\s+(?:'1'\s*=\s*'1'|1\s*=\s*1|true\b)").unwrap(),
        Regex::new(r"(?i);\s*(?:drop|alter|truncate|delete|insert|update)\s+").unwrap(),
        Regex::new(r"(?i)\b(?:sleep\s*\(\s*\d+\s*\)|waitfor\s+delay|pg_sleep\s*\()").unwrap(),
        Regex::new(r"(?i)\b(?:information_schema|sqlite_master)\b").unwrap(),
    ]
});

pub fn contains_sqli_signature(text: &str) -> bool {
    let decoded = urlencoding_decode_light(text);
    SQLI_PATTERNS.iter().any(|rx| rx.is_match(&decoded) || rx.is_match(text))
}

fn urlencoding_decode_light(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[derive(Clone)]
pub struct WafState {
    pub firewall: Arc<FirewallManager>,
    pub supervisor: Arc<RuntimeSupervisor>,
    pub bus: Arc<EventBus>,
    pub http: Client,
    pub rate_windows: Arc<DashMap<String, Vec<Instant>>>,
    pub auth_failures: Arc<DashMap<String, Vec<Instant>>>,
    pub error_5xx: Arc<DashMap<String, Vec<Instant>>>,
}

impl WafState {
    pub fn new(
        firewall: Arc<FirewallManager>,
        supervisor: Arc<RuntimeSupervisor>,
        bus: Arc<EventBus>,
    ) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            firewall,
            supervisor,
            bus,
            http,
            rate_windows: Arc::new(DashMap::new()),
            auth_failures: Arc::new(DashMap::new()),
            error_5xx: Arc::new(DashMap::new()),
        }
    }

    fn check_rate_limit(&self, ip: &str, service: &str, max_per_min: u32) -> bool {
        if max_per_min == 0 {
            return true;
        }
        let key = format!("{}:{}", service, ip);
        let now = Instant::now();
        let mut entry = self.rate_windows.entry(key).or_default();
        entry.retain(|t| now.duration_since(*t).as_secs() < 60);
        if entry.len() >= max_per_min as usize {
            return false;
        }
        entry.push(now);
        true
    }

    pub fn record_auth_attempt(&self, ip: &str, service: &str, success: bool, username: &str) -> Option<Event> {
        let key = format!("{}:{}", service, ip);
        if success {
            self.auth_failures.remove(&key);
            return None;
        }
        let now = Instant::now();
        let count = {
            let mut entry = self.auth_failures.entry(key.clone()).or_default();
            entry.retain(|t| now.duration_since(*t).as_secs() < 60);
            entry.push(now);
            entry.len()
        };
        if count == 10 {
            let evt = Event::new(
                "collector.auth",
                "bruteforce",
                service,
                "high",
                HashMap::from([
                    ("ip".into(), json!(ip)),
                    ("username".into(), json!(username)),
                    ("failed_attempts".into(), json!(count)),
                ]),
            );
            self.bus.publish(evt.clone());
            return Some(evt);
        }
        None
    }
}

pub fn extract_client_ip(headers: &HeaderMap) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = normalize_ip(first) {
                return ip;
            }
        }
    }
    if let Some(real_ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = normalize_ip(real_ip) {
            return ip;
        }
    }
    "127.0.0.1".to_string()
}

fn estimate_json_rows(bytes: &[u8]) -> usize {
    let Ok(val) = serde_json::from_slice::<Value>(bytes) else {
        return 1;
    };
    if let Some(arr) = val.as_array() {
        return arr.len();
    }
    if let Some(obj) = val.as_object() {
        for k in ["results", "items", "rows", "data", "users", "orders"] {
            if let Some(arr) = obj.get(k).and_then(|v| v.as_array()) {
                return arr.len();
            }
        }
    }
    1
}

pub async fn forward_through_waf(
    waf: &WafState,
    target: &TargetServiceConfig,
    upstream_path: &str,
    req: Request,
) -> Response {
    let headers = req.headers().clone();
    let method = req.method().clone();
    let raw_query = req.uri().query().unwrap_or("").to_string();
    let client_ip = extract_client_ip(&headers);

    // 1. Instant Firewall Blocklist Check
    if let Some(block_entry) = waf.firewall.get_block_entry(&client_ip) {
        let mut resp = (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Access denied by Alexia Sentinel WAF",
                "ip": client_ip,
                "details": block_entry,
            })),
        )
            .into_response();
        resp.headers_mut()
            .insert("X-Alexia-WAF", HeaderValue::from_static("BLOCKED-IP"));
        return resp;
    }

    // 2. Quarantine / Network Isolation Check
    if waf.supervisor.is_isolated(&target.name) {
        let mut resp = (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": format!("Service '{}' is currently quarantined by Alexia Guardian.", target.name),
                "service": target.name,
            })),
        )
            .into_response();
        resp.headers_mut()
            .insert("X-Alexia-WAF", HeaderValue::from_static("QUARANTINED"));
        return resp;
    }

    // 3. Sliding-Window Rate Limit Check
    let rate_limit = waf.supervisor.gateway_config().rate_limit_per_minute;
    if !waf.check_rate_limit(&client_ip, &target.name, rate_limit) {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": "Rate limit exceeded at Alexia WAF Gateway", "ip": client_ip})),
        )
            .into_response();
        resp.headers_mut()
            .insert("X-Alexia-WAF", HeaderValue::from_static("RATE-LIMITED"));
        return resp;
    }

    // 4. Pre-Forward SQLi Payload Inspection
    let body_bytes = to_bytes(req.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let body_preview = String::from_utf8_lossy(&body_bytes[..body_bytes.len().min(65536)]);
    let combined = format!("{}?{}\n{}", upstream_path, raw_query, body_preview);

    if contains_sqli_signature(&combined) {
        let evt = Event::new(
            "collector.waf",
            "sqli_pattern",
            &target.name,
            "critical",
            HashMap::from([
                ("ip".into(), json!(client_ip)),
                ("endpoint".into(), json!(upstream_path)),
                ("payload".into(), json!(combined.chars().take(500).collect::<String>())),
                ("query".into(), json!(raw_query)),
            ]),
        );
        waf.bus.publish(evt);

        let waf_mode = env::var("ALEXIA_WAF_MODE").unwrap_or_else(|_| "enforce".into());
        if waf_mode.trim().to_lowercase() != "detect_only" {
            let mut resp = (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "Malicious SQL injection payload blocked by Alexia Sentinel WAF",
                    "service": target.name,
                    "ip": client_ip,
                })),
            )
                .into_response();
            resp.headers_mut()
                .insert("X-Alexia-WAF", HeaderValue::from_static("BLOCKED-SQLI"));
            return resp;
        }
    }

    // 5. Proxy Request to Upstream Target
    let clean_path = if upstream_path.starts_with('/') {
        upstream_path.to_string()
    } else {
        format!("/{}", upstream_path)
    };
    let mut target_url = format!("{}{}", target.upstream_url.trim_end_matches('/'), clean_path);
    if !raw_query.is_empty() {
        target_url.push('?');
        target_url.push_str(&raw_query);
    }

    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let mut builder = waf.http.request(reqwest_method, &target_url);
    for (k, v) in headers.iter() {
        let name = k.as_str().to_lowercase();
        if !matches!(
            name.as_str(),
            "host" | "connection" | "keep-alive" | "transfer-encoding" | "upgrade" | "content-length"
        ) {
            if let Ok(val_str) = v.to_str() {
                builder = builder.header(k.as_str(), val_str);
            }
        }
    }
    builder = builder.header("X-Forwarded-For", &client_ip);

    let upstream_resp = match builder.body(body_bytes.to_vec()).send().await {
        Ok(r) => r,
        Err(e) => {
            let evt = Event::new(
                "collector.health",
                "health_failed",
                &target.name,
                "high",
                HashMap::from([("error".into(), json!(e.to_string()))]),
            );
            waf.bus.publish(evt);
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!("Upstream target '{}' is unreachable", target.name),
                    "detail": e.to_string(),
                })),
            )
                .into_response();
        }
    };

    let status_u16 = upstream_resp.status().as_u16();
    let resp_headers = upstream_resp.headers().clone();
    let resp_bytes = upstream_resp.bytes().await.unwrap_or_default();

    // 6. Post-Forward Telemetry (Auth Brute-Force, 5xx Spikes, Row Exfiltration)
    let lower_path = clean_path.to_lowercase();
    if lower_path.contains("/login") || lower_path.contains("/auth") || lower_path.contains("/signin") {
        if status_u16 == 401 || status_u16 == 403 {
            let _ = waf.record_auth_attempt(&client_ip, &target.name, false, "login_attempt");
        } else if status_u16 < 400 {
            let _ = waf.record_auth_attempt(&client_ip, &target.name, true, "login_attempt");
        }
    }

    if status_u16 >= 500 {
        let now = Instant::now();
        let cnt = {
            let mut e = waf.error_5xx.entry(target.name.clone()).or_default();
            e.retain(|t| now.duration_since(*t).as_secs() < 60);
            e.push(now);
            e.len()
        };
        if cnt == 3 {
            waf.bus.publish(Event::new(
                "collector.logs",
                "http_5xx_spike",
                &target.name,
                "high",
                HashMap::from([
                    ("endpoint".into(), json!(clean_path)),
                    ("status_code".into(), json!(status_u16)),
                    ("body_preview".into(), json!(String::from_utf8_lossy(&resp_bytes[..resp_bytes.len().min(300)]))),
                ]),
            ));
        }
    } else if status_u16 == 200 {
        let rows = estimate_json_rows(&resp_bytes);
        if rows >= 500 {
            waf.bus.publish(Event::new(
                "collector.db",
                "row_read_anomaly",
                &target.name,
                "high",
                HashMap::from([
                    ("ip".into(), json!(client_ip)),
                    ("rows_returned".into(), json!(rows)),
                    ("endpoint".into(), json!(clean_path)),
                ]),
            ));
        }
    }

    let mut out = Response::builder()
        .status(StatusCode::from_u16(status_u16).unwrap_or(StatusCode::OK));
    for (k, v) in resp_headers.iter() {
        let name = k.as_str().to_lowercase();
        if !matches!(
            name.as_str(),
            "connection" | "keep-alive" | "transfer-encoding" | "content-length"
        ) {
            out = out.header(k.as_str(), v.as_bytes());
        }
    }
    out = out
        .header("X-Protected-By", "Alexia-Guardian-WAF")
        .header("X-Alexia-Target", &target.name);

    out.body(Body::from(resp_bytes)).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "Proxy response build error").into_response()
    })
}

async fn standalone_gateway_handler(State(waf): State<WafState>, req: Request) -> Response {
    let host_hdr = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let target = match waf.supervisor.resolve_default_or_host_target(host_hdr) {
        Some(t) => t,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "No enabled target service configured in Alexia TargetRegistry."})),
            )
                .into_response();
        }
    };
    let path = req.uri().path().to_string();
    forward_through_waf(&waf, &target, &path, req).await
}

pub fn create_gateway_router(waf: WafState) -> Router {
    Router::new()
        .route("/", any(standalone_gateway_handler))
        .route("/*path", any(standalone_gateway_handler))
        .with_state(waf)
}
