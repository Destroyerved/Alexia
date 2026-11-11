//! `alexia` v3.0 Standalone Binary Entrypoint:
//! Runs the Control Plane + Embedded React 19 UI (`:8080`), Inline WAF Gateway (`:8000`),
//! Supervised Target Processes (`RuntimeSupervisor`), Ratatui TUI (`--tui`), or Native Demo Target (`--demo-target`).

use alexia::{
    agents::AppContext,
    api::create_control_plane_router,
    demo_target::run_demo_target,
    gateway::proxy::create_gateway_router,
    tui::run_tui,
};
use anyhow::{Context, Result};
use clap::Parser;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(
    name = "alexia",
    version = "3.0.0",
    about = "Alexia v3.0 — Pure-Rust Autonomous DevSecOps Guardian (WAF + Supervisor + 5 Agents + Embedded React 19 UI + Ratatui TUI)"
)]
struct Cli {
    /// Bind host address for Control Plane & WAF Gateway
    #[arg(long, default_value = "0.0.0.0", env = "ALEXIA_HOST")]
    host: String,

    /// Control Plane & Embedded React 19 Dashboard port
    #[arg(long, default_value_t = 8080, env = "ALEXIA_PORT")]
    port: u16,

    /// Standalone Reverse-Proxy WAF Gateway port (0 disables standalone listener)
    #[arg(long, default_value_t = 8000, env = "ALEXIA_GATEWAY_PORT")]
    gateway_port: u16,

    /// Do not auto-open browser on startup
    #[arg(long)]
    no_browser: bool,

    /// Launch interactive Ratatui Terminal Command Center (`--tui` / `--cli`)
    #[arg(long, visible_alias = "cli")]
    tui: bool,

    /// Run self-verification diagnostics (`redb` ACID + SHA-256 audit chain + WAF + `sqlparser` AST) and exit 0
    #[arg(long)]
    verify_setup: bool,

    /// Run built-in native Rust `ShopLite` target microservice (used by `config/targets.yaml`)
    #[arg(long)]
    demo_target: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    // Mode 1: Built-in Native Rust `ShopLite` Supervised Target Microservice
    if cli.demo_target {
        let bind_host = if cli.host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            cli.host.as_str()
        };
        return run_demo_target(bind_host, cli.port).await;
    }

    // Initialize full Guardian context (`redb`, `EventBus`, `FirewallManager`, `RuntimeSupervisor`, 5 Agents)
    let ctx = AppContext::initialize(None, None)?;

    // Mode 2: `--verify-setup` Production Readiness Diagnostic
    if cli.verify_setup {
        return run_verify_setup(&ctx);
    }

    // Mode 3: Interactive Ratatui Terminal Command Center (`--tui` / `--cli`)
    if cli.tui {
        ctx.supervisor.start_all_enabled();
        let res = run_tui(ctx.clone()).await;
        ctx.supervisor.stop_all();
        return res;
    }

    // Mode 4: Full Production Guardian Server (Control Plane `:8080` + WAF Gateway `:8000` + Supervisor)
    let _ = ctx.db.record_audit(
        "guardian_started",
        "system:boot",
        json!({
            "version": "3.0.0",
            "control_plane_port": cli.port,
            "gateway_port": cli.gateway_port,
            "llm": ctx.llm.provider_status(),
        }),
    );

    ctx.supervisor.start_all_enabled();

    let cp_addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .context("Invalid Control Plane socket address")?;
    let cp_listener = tokio::net::TcpListener::bind(cp_addr)
        .await
        .with_context(|| format!("Failed binding Control Plane on {}", cp_addr))?;

    let gw_listener = if cli.gateway_port > 0 && cli.gateway_port != cli.port {
        let gw_addr: SocketAddr = format!("{}:{}", cli.host, cli.gateway_port)
            .parse()
            .context("Invalid WAF Gateway socket address")?;
        Some(
            tokio::net::TcpListener::bind(gw_addr)
                .await
                .with_context(|| format!("Failed binding WAF Gateway on {}", gw_addr))?,
        )
    } else {
        None
    };

    let ui_url = format!(
        "http://{}:{}",
        if cli.host == "0.0.0.0" { "127.0.0.1" } else { &cli.host },
        cli.port
    );
    tracing::info!("============================================================");
    tracing::info!("Alexia v3.0 — Pure-Rust Autonomous DevSecOps Guardian");
    tracing::info!("Control Plane & React 19 SPA : {}", ui_url);
    if gw_listener.is_some() {
        tracing::info!(
            "Inline Sentinel WAF Gateway  : http://{}:{}",
            if cli.host == "0.0.0.0" { "127.0.0.1" } else { &cli.host },
            cli.gateway_port
        );
    }
    tracing::info!(
        "LLM Provider Posture         : {}",
        ctx.llm.provider_status()["mode"].as_str().unwrap_or("rule_engine_fallback")
    );
    tracing::info!("============================================================");

    if !cli.no_browser {
        let _ = open::that(&ui_url);
    }

    let cp_router = create_control_plane_router(ctx.clone());
    let waf_state = ctx.waf.clone();

    let shutdown_ctx = ctx.clone();
    tokio::select! {
        res = axum::serve(cp_listener, cp_router) => {
            res.context("Control Plane server exited with error")?;
        }
        res = async {
            if let Some(listener) = gw_listener {
                axum::serve(listener, create_gateway_router(waf_state)).await
            } else {
                std::future::pending::<std::io::Result<()>>().await
            }
        } => {
            res.context("WAF Gateway server exited with error")?;
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Received Ctrl+C — shutting down supervised targets cleanly...");
        }
    }

    shutdown_ctx.supervisor.stop_all();
    Ok(())
}

fn run_verify_setup(ctx: &Arc<AppContext>) -> Result<()> {
    let _ = ctx.db.record_audit(
        "verify_setup_probe",
        "system:cli",
        json!({"check": "redb_acid_and_sha256_chain"}),
    );
    let (chain_ok, rows, err) = ctx.db.verify_audit_chain();
    if !chain_ok {
        anyhow::bail!("Audit hash-chain verification failed: {:?}", err);
    }

    let sqli_blocked = alexia::gateway::proxy::contains_sqli_signature(
        "q=' UNION SELECT id, email, password_hash FROM users--",
    );
    if !sqli_blocked {
        anyhow::bail!("WAF SQLi regex engine failed self-check");
    }

    let dry = alexia::tools::sql_audit::dry_run_sql_migration(
        "ALTER TABLE users DROP COLUMN phone;",
        "shoplite-api",
    );
    if dry["is_destructive"].as_bool() != Some(true) {
        anyhow::bail!("sqlparser AST destructive migration dry-run failed self-check");
    }

    println!("Alexia v3.0 (Pure-Rust) Setup Verification PASSED:");
    println!("  [OK] ACID redb persistence        : {}", ctx.db.path().display());
    println!("  [OK] SHA-256 audit hash-chain     : {} verified block(s)", rows);
    println!("  [OK] Inline WAF SQLi engine       : ACTIVE");
    println!("  [OK] sqlparser AST migration gate : ACTIVE");
    println!("  [OK] Configured targets           : {}", ctx.supervisor.list_targets(false).len());
    println!(
        "  [OK] LLM posture                  : {}",
        ctx.llm.provider_status()["mode"].as_str().unwrap_or("rule_engine_fallback")
    );
    Ok(())
}
