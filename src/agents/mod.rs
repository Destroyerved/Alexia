//! Central `AppContext` & Autonomous `Orchestrator` wiring all 5 specialized DevSecOps agents
//! (`Sentinel`, `Integrity`, `Healer`, `Builder`, `Deployer`) onto the async `EventBus`.

pub mod builder;
pub mod chaos;
pub mod deployer;
pub mod executor;
pub mod healer;
pub mod integrity;
pub mod sentinel;

use crate::agents::{
    builder::BuilderAgent, deployer::DeployerAgent, executor::ActionExecutor, healer::HealerAgent,
    integrity::IntegrityAgent, sentinel::SentinelAgent,
};
use crate::auth::{ApprovalManager, AuthManager};
use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::paths::ensure_runtime_dirs;
use crate::core::schemas::Event;
use crate::gateway::firewall::FirewallManager;
use crate::gateway::proxy::WafState;
use crate::llm::{LlmClient, ModelRouter};
use crate::runtime::RuntimeSupervisor;
use crate::tools::tavily::TavilyClient;
use anyhow::Result;
use dashmap::DashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone)]
pub struct AppContext {
    pub db: Arc<AlexiaDb>,
    pub bus: Arc<EventBus>,
    pub llm: Arc<LlmClient>,
    pub router: Arc<ModelRouter>,
    pub firewall: Arc<FirewallManager>,
    pub supervisor: Arc<RuntimeSupervisor>,
    pub waf: WafState,
    pub auth: Arc<AuthManager>,
    pub approvals: Arc<ApprovalManager>,
    pub tavily: Arc<TavilyClient>,
    pub executor: Arc<ActionExecutor>,
    pub integrity: Arc<IntegrityAgent>,
    pub builder: Arc<BuilderAgent>,
    pub sentinel: Arc<SentinelAgent>,
    pub healer: Arc<HealerAgent>,
    pub deployer: Arc<DeployerAgent>,
    dedup_window: Arc<DashMap<String, Instant>>,
}

impl AppContext {
    pub fn initialize(
        db_file: Option<&Path>,
        targets_yaml: Option<&Path>,
    ) -> Result<Arc<Self>> {
        if db_file.is_none() {
            ensure_runtime_dirs();
        }

        let db = match db_file {
            Some(p) => AlexiaDb::open(p)?,
            None => AlexiaDb::open_default()?,
        };
        let bus = EventBus::new(db.clone());
        let llm = LlmClient::new(db.clone());

        // Hydrate saved LLM configuration from `redb` settings if previously configured via UI
        let saved_settings = db.get_settings();
        if let Some(prov) = saved_settings
            .get("llm_provider")
            .and_then(|v| v.as_str())
            .filter(|p| *p != "auto" && !p.is_empty())
        {
            let key = saved_settings.get("llm_api_key").and_then(|v| v.as_str());
            let base = saved_settings.get("llm_base_url").and_then(|v| v.as_str());
            let fast = saved_settings.get("llm_fast_model").and_then(|v| v.as_str());
            let coding = saved_settings.get("llm_coding_model").and_then(|v| v.as_str());
            let reasoning = saved_settings.get("llm_reasoning_model").and_then(|v| v.as_str());
            llm.reload_provider(prov, key, base, fast, coding, reasoning);
        }

        let router = ModelRouter::new(db.clone(), llm.clone());
        let firewall = FirewallManager::new(db.clone());
        let cfg_path = targets_yaml
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("config/targets.yaml"));
        let supervisor = RuntimeSupervisor::new(db.clone(), bus.clone(), cfg_path);
        let waf = WafState::new(firewall.clone(), supervisor.clone(), bus.clone());

        let auth = AuthManager::new(db.clone());
        let approvals = ApprovalManager::new(db.clone(), auth.clone());
        let tavily = TavilyClient::new(db.clone(), None, None);
        let executor = ActionExecutor::new(
            db.clone(),
            bus.clone(),
            firewall.clone(),
            supervisor.clone(),
            approvals.clone(),
        );

        let integrity = IntegrityAgent::new(db.clone());
        let builder = BuilderAgent::new(
            db.clone(),
            bus.clone(),
            llm.clone(),
            supervisor.clone(),
            executor.clone(),
        );
        let sentinel = SentinelAgent::new(
            db.clone(),
            bus.clone(),
            executor.clone(),
            integrity.clone(),
            builder.clone(),
        );
        let healer = HealerAgent::new(
            db.clone(),
            bus.clone(),
            router.clone(),
            supervisor.clone(),
            executor.clone(),
            integrity.clone(),
            builder.clone(),
            tavily.clone(),
        );
        let deployer = DeployerAgent::new(
            db.clone(),
            bus.clone(),
            supervisor.clone(),
            executor.clone(),
            sentinel.clone(),
            integrity.clone(),
            builder.clone(),
        );

        let ctx = Arc::new(Self {
            db,
            bus,
            llm,
            router,
            firewall,
            supervisor,
            waf,
            auth,
            approvals,
            tavily,
            executor,
            integrity,
            builder,
            sentinel,
            healer,
            deployer,
            dedup_window: Arc::new(DashMap::new()),
        });

        ctx.wire_orchestrator_subscriptions();
        Ok(ctx)
    }

    fn should_process_event(&self, evt: &Event) -> bool {
        let sub_disc = evt
            .data
            .get("ip")
            .or_else(|| evt.data.get("commit_sha"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let key = format!("{}|{}|{}", evt.service, evt.kind, sub_disc);
        let now = Instant::now();
        if let Some(prev) = self.dedup_window.get(&key) {
            if now.duration_since(*prev).as_secs() < 20 {
                return false;
            }
        }
        self.dedup_window.insert(key, now);
        true
    }

    fn wire_orchestrator_subscriptions(self: &Arc<Self>) {
        // Security Signals -> SentinelAgent
        for kind in ["sqli_pattern", "bruteforce", "row_read_anomaly"] {
            let ctx = self.clone();
            self.bus.subscribe(kind, move |evt: Event| {
                let ctx = ctx.clone();
                async move {
                    if ctx.should_process_event(&evt) {
                        let _ = ctx.sentinel.handle_security_incident(evt).await;
                    }
                }
            });
        }

        // Runtime Reliability Signals -> HealerAgent
        for kind in [
            "container_exit",
            "health_failed",
            "http_5xx_spike",
            "disk_high",
            "code_exception",
        ] {
            let ctx = self.clone();
            self.bus.subscribe(kind, move |evt: Event| {
                let ctx = ctx.clone();
                async move {
                    if ctx.should_process_event(&evt) {
                        let _ = ctx.healer.handle_event(evt).await;
                    }
                }
            });
        }

        // Git Webhook Push Signals -> DeployerAgent
        let ctx_dep = self.clone();
        self.bus.subscribe("git_push", move |evt: Event| {
            let ctx = ctx_dep.clone();
            async move {
                if ctx.should_process_event(&evt) {
                    let commit_sha = evt
                        .data
                        .get("commit_sha")
                        .and_then(|v| v.as_str())
                        .unwrap_or("head0001");
                    let author = evt
                        .data
                        .get("author")
                        .and_then(|v| v.as_str())
                        .unwrap_or("webhook");
                    let diff = evt
                        .data
                        .get("diff")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let mig = evt.data.get("migration_sql").and_then(|v| v.as_str());
                    let _ = ctx
                        .deployer
                        .deploy_commit(&evt.service, commit_sha, author, diff, mig)
                        .await;
                }
            }
        });
    }
}
