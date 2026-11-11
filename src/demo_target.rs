//! Built-in Pure-Rust `ShopLite` Supervised Target Microservice (`alexia --demo-target --port 8001`).
//!
//! Eliminates any Python/FastAPI requirement even for the optional supervised sample service!
//! Dynamically honors `app/main.py` & `.env` in its working directory so live deployments,
//! secret rotations, PR merges, and `.tar.gz` rollbacks immediately reflect in HTTP behavior.

use crate::core::schemas::now_iso;
use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::Path;

fn read_spec_file() -> String {
    for candidate in ["app/main.py", "target-service/app/main.py"] {
        if Path::new(candidate).exists() {
            if let Ok(raw) = fs::read_to_string(candidate) {
                return raw;
            }
        }
    }
    String::new()
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({
        "status": "healthy",
        "service": "shoplite-api",
        "runtime": "rust-axum-native",
        "timestamp": now_iso(),
    }))
}

#[derive(Deserialize, Default)]
struct SearchParams {
    #[serde(default)]
    q: String,
}

async fn search_handler(Query(params): Query<SearchParams>) -> impl IntoResponse {
    let catalog = vec![
        json!({"id": 1, "name": "Mechanical Keyboard Pro", "price": 129.99, "stock": 42}),
        json!({"id": 2, "name": "USB-C Security Key (FIDO2)", "price": 55.00, "stock": 118}),
        json!({"id": 3, "name": "Hardware Security Module Mini", "price": 249.00, "stock": 14}),
    ];

    let q_lower = params.q.trim().to_lowercase();
    let results: Vec<Value> = if q_lower.is_empty() {
        catalog
    } else {
        catalog
            .into_iter()
            .filter(|item| {
                item["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&q_lower)
            })
            .collect()
    };

    Json(json!({
        "query": params.q,
        "count": results.len(),
        "results": results,
    }))
}

#[derive(Deserialize)]
struct OrderTotalParams {
    #[serde(default = "default_subtotal")]
    subtotal: f64,
    #[serde(default = "default_items")]
    item_count: i64,
}

fn default_subtotal() -> f64 {
    100.0
}
fn default_items() -> i64 {
    1
}

async fn order_total_handler(Query(params): Query<OrderTotalParams>) -> impl IntoResponse {
    let spec = read_spec_file();
    let unguarded = spec.contains("subtotal / item_count") && !spec.contains("if item_count == 0:");

    if params.item_count == 0 && unguarded {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "ZeroDivisionError: float division by zero in calculate_order_total",
                "subtotal": params.subtotal,
                "item_count": 0,
            })),
        )
            .into_response();
    }

    let avg = if params.item_count <= 0 {
        0.0
    } else {
        ((params.subtotal / params.item_count as f64) * 100.0).round() / 100.0
    };

    (
        StatusCode::OK,
        Json(json!({
            "subtotal": params.subtotal,
            "item_count": params.item_count,
            "average_per_item": avg,
        })),
    )
        .into_response()
}

async fn login_handler(Json(body): Json<HashMap<String, Value>>) -> impl IntoResponse {
    let user = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let pass = body
        .get("password")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let expected_pw = std::env::var("SHOPLITE_DEMO_CUSTOMER_PASSWORD")
        .unwrap_or_else(|_| "shoplite-customer-local-only".into());

    if user == "customer@shoplite.example" && pass == expected_pw {
        (
            StatusCode::OK,
            Json(json!({"authenticated": true, "user": user})),
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"authenticated": false, "error": "Invalid credentials"})),
        )
            .into_response()
    }
}

pub fn create_demo_target_router() -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/products", get(search_handler))
        .route("/search", get(search_handler))
        .route("/orders/total", get(order_total_handler))
        .route("/api/v1/auth/login", post(login_handler))
}

pub async fn run_demo_target(host: &str, port: u16) -> anyhow::Result<()> {
    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ShopLite native Rust target listening on http://{}", addr);
    axum::serve(listener, create_demo_target_router()).await?;
    Ok(())
}
