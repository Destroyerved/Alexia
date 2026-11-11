//! Live Tavily Web Search Grounding Client with 24-hour SHA-256 `redb` Cache.

use crate::core::db::AlexiaDb;
use crate::core::schemas::DiagnosticSource;
use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::sync::Arc;

pub struct TavilyClient {
    db: Arc<AlexiaDb>,
    http: Client,
    pub api_key: String,
    pub endpoint: String,
}

impl TavilyClient {
    pub fn new(db: Arc<AlexiaDb>, api_key: Option<String>, endpoint: Option<String>) -> Arc<Self> {
        let key = api_key
            .unwrap_or_else(|| env::var("TAVILY_API_KEY").unwrap_or_default())
            .trim()
            .to_string();
        let ep = endpoint
            .unwrap_or_else(|| {
                env::var("TAVILY_API_URL")
                    .unwrap_or_else(|_| "https://api.tavily.com/search".to_string())
            })
            .trim()
            .to_string();
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        Arc::new(Self {
            db,
            http,
            api_key: key,
            endpoint: ep,
        })
    }

    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
            && !self.api_key.starts_with("tvly-your")
            && !self.api_key.starts_with("your_")
    }

    pub async fn search(&self, query: &str, max_results: usize) -> Vec<DiagnosticSource> {
        if !self.is_configured() {
            return Vec::new();
        }

        let mut hasher = Sha256::new();
        hasher.update(query.trim().to_lowercase().as_bytes());
        let q_hash = hex::encode(hasher.finalize());
        let now_ep = Utc::now().timestamp_millis() as f64 / 1000.0;

        if let Some(cached_raw) = self.db.get_tavily_cache(&q_hash, now_ep) {
            if let Ok(parsed) = serde_json::from_str::<Vec<DiagnosticSource>>(&cached_raw) {
                return parsed;
            }
        }

        let Ok(resp) = self
            .http
            .post(&self.endpoint)
            .json(&json!({
                "api_key": self.api_key,
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
            }))
            .send()
            .await
        else {
            return Vec::new();
        };

        if !resp.status().is_success() {
            return Vec::new();
        }
        let Ok(body) = resp.json::<Value>().await else {
            return Vec::new();
        };

        let mut sources = Vec::new();
        if let Some(arr) = body.get("results").and_then(|v| v.as_array()) {
            for item in arr {
                let Some(url) = item.get("url").and_then(|v| v.as_str()) else {
                    continue;
                };
                let title = item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Web Reference")
                    .to_string();
                let snippet: String = item
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(400)
                    .collect();
                sources.push(DiagnosticSource {
                    title,
                    url: url.to_string(),
                    snippet,
                });
            }
        }

        if let Ok(serialized) = serde_json::to_string(&sources) {
            let _ = self
                .db
                .set_tavily_cache(&q_hash, query, &serialized, now_ep + 86400.0);
        }
        sources
    }
}
