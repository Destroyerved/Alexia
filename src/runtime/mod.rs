//! Native Rust `RuntimeSupervisor`: OS Process + Docker/Compose Supervision, `sysinfo` Telemetry,
//! `.tar.gz` Release Archiving & Rollback, Gzip Log Rotation, Secret Rotation, and Network Quarantine.

use crate::core::bus::EventBus;
use crate::core::db::AlexiaDb;
use crate::core::schemas::{
    now_iso, Event, GatewayConfig, TargetServiceConfig, TargetsFile,
};
use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use parking_lot::{Mutex, RwLock};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

pub struct ManagedProcessState {
    pub child: Option<Child>,
    pub pid: Option<u32>,
    pub started_at: Option<Instant>,
    pub intentional_stop: bool,
    pub isolated: bool,
    pub restart_count: u64,
    pub current_version: String,
    pub disconnected_networks: Vec<String>,
}

impl Default for ManagedProcessState {
    fn default() -> Self {
        Self {
            child: None,
            pid: None,
            started_at: None,
            intentional_stop: false,
            isolated: false,
            restart_count: 0,
            current_version: "v1.0.0".into(),
            disconnected_networks: Vec::new(),
        }
    }
}

pub struct RuntimeSupervisor {
    db: Arc<AlexiaDb>,
    bus: Arc<EventBus>,
    http: Client,
    config_path: PathBuf,
    registry: RwLock<TargetsFile>,
    states: DashMap<String, Mutex<ManagedProcessState>>,
    sys: Mutex<System>,
}

impl RuntimeSupervisor {
    pub fn new(db: Arc<AlexiaDb>, bus: Arc<EventBus>, config_path: impl AsRef<Path>) -> Arc<Self> {
        let cfg_path = config_path.as_ref().to_path_buf();
        let loaded = Self::load_targets_file(&cfg_path);
        let http = Client::builder()
            .timeout(Duration::from_millis(2500))
            .build()
            .unwrap_or_else(|_| Client::new());

        let sup = Arc::new(Self {
            db,
            bus,
            http,
            config_path: cfg_path,
            registry: RwLock::new(loaded),
            states: DashMap::new(),
            sys: Mutex::new(System::new_all()),
        });
        sup.ensure_default_target_workspace();
        sup
    }

    fn load_targets_file(path: &Path) -> TargetsFile {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(parsed) = serde_yaml::from_str::<TargetsFile>(&raw) {
                return parsed;
            }
        }
        TargetsFile {
            gateway: GatewayConfig::default(),
            targets: vec![TargetServiceConfig {
                id: "svc_shoplite_api".into(),
                name: "shoplite-api".into(),
                runtime: "process".into(),
                command: vec![
                    "${ALEXIA_EXE}".into(),
                    "--demo-target".into(),
                    "--port".into(),
                    "8001".into(),
                ],
                workdir: "target-service".into(),
                container_name: String::new(),
                compose_file: String::new(),
                compose_service: String::new(),
                upstream_url: "http://127.0.0.1:8001".into(),
                health_url: "http://127.0.0.1:8001/health".into(),
                log_paths: Vec::new(),
                env_file: "target-service/.env".into(),
                database_url: "redb://data/shoplite.redb".into(),
                github_repo: String::new(),
                base_branch: "main".into(),
                memory_limit_mb: 512,
                enabled: true,
            }],
        }
    }

    /// Seeds a clean target workspace (`target-service/app/routes.py` / config) for Builder/Sandbox/Rollback exercises.
    pub fn ensure_default_target_workspace(&self) {
        let ws = PathBuf::from("target-service");
        let app_dir = ws.join("app");
        let _ = fs::create_dir_all(&app_dir);
        let main_file = app_dir.join("main.py");
        if !main_file.exists() {
            let default_code = r#"# ShopLite Service Policy & Route Specification (Synced with Rust Demo Target)
DEMO_VULN = True

def search_products_query(q: str):
    if DEMO_VULN:
        # Vulnerable query: direct string interpolation
        query = f"SELECT id, name, price FROM products WHERE name LIKE '%{q}%'"
        return query, ()
    else:
        # Safe parameterized query
        query = "SELECT id, name, price FROM products WHERE name LIKE ?"
        return query, (f"%{q}%",)

def calculate_order_total(subtotal: float, item_count: int):
    if item_count == 0:
        return {"subtotal": subtotal, "item_count": 0, "average_per_item": 0.0}
    return {"subtotal": subtotal, "item_count": item_count, "average_per_item": round(subtotal / item_count, 2)}
"#;
            let _ = fs::write(&main_file, default_code);
        }
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.db.subdir("logs")
    }

    pub fn releases_dir(&self) -> PathBuf {
        self.db.subdir("releases")
    }

    pub fn gateway_config(&self) -> GatewayConfig {
        self.registry.read().gateway.clone()
    }

    pub fn list_targets(&self, enabled_only: bool) -> Vec<TargetServiceConfig> {
        let reg = self.registry.read();
        reg.targets
            .iter()
            .filter(|t| !enabled_only || t.enabled)
            .cloned()
            .collect()
    }

    pub fn get_target(&self, name_or_id: &str) -> Option<TargetServiceConfig> {
        let reg = self.registry.read();
        reg.targets
            .iter()
            .find(|t| t.name == name_or_id || t.id == name_or_id)
            .cloned()
    }

    pub fn resolve_default_or_host_target(&self, host_header: &str) -> Option<TargetServiceConfig> {
        let reg = self.registry.read();
        let host_clean = host_header.split(':').next().unwrap_or("").to_lowercase();
        if !host_clean.is_empty() {
            if let Some(t) = reg
                .targets
                .iter()
                .find(|t| t.enabled && host_clean.starts_with(&t.name.to_lowercase()))
            {
                return Some(t.clone());
            }
        }
        reg.targets
            .iter()
            .find(|t| t.enabled && t.name == reg.gateway.default_target)
            .or_else(|| reg.targets.iter().find(|t| t.enabled))
            .cloned()
    }

    pub fn upsert_target(&self, cfg: TargetServiceConfig) -> TargetServiceConfig {
        let mut reg = self.registry.write();
        if let Some(existing) = reg
            .targets
            .iter_mut()
            .find(|t| t.name == cfg.name || t.id == cfg.id)
        {
            *existing = cfg.clone();
        } else {
            reg.targets.push(cfg.clone());
        }
        if let Ok(yaml) = serde_yaml::to_string(&*reg) {
            let _ = fs::write(&self.config_path, yaml);
        }
        cfg
    }

    pub fn remove_target(&self, name_or_id: &str) -> bool {
        let mut reg = self.registry.write();
        let before = reg.targets.len();
        reg.targets.retain(|t| t.name != name_or_id && t.id != name_or_id);
        let removed = reg.targets.len() < before;
        if removed {
            if let Ok(yaml) = serde_yaml::to_string(&*reg) {
                let _ = fs::write(&self.config_path, yaml);
            }
        }
        removed
    }

    pub fn is_isolated(&self, name_or_id: &str) -> bool {
        let Some(t) = self.get_target(name_or_id) else {
            return false;
        };
        self.states
            .get(&t.name)
            .map(|st| st.lock().isolated)
            .unwrap_or(false)
    }

    fn parse_env_file(path: &str) -> HashMap<String, String> {
        let mut out = HashMap::new();
        if path.is_empty() {
            return out;
        }
        if let Ok(raw) = fs::read_to_string(path) {
            for line in raw.lines() {
                let t = line.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                if let Some((k, v)) = t.split_once('=') {
                    out.insert(
                        k.trim().to_string(),
                        v.trim().trim_matches('"').trim_matches('\'').to_string(),
                    );
                }
            }
        }
        out
    }

    fn write_env_file(path: &str, map: &HashMap<String, String>) -> Result<()> {
        let p = Path::new(path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut keys: Vec<&String> = map.keys().collect();
        keys.sort();
        let mut content = String::new();
        for k in keys {
            content.push_str(&format!("{}={}\n", k, map[k]));
        }
        fs::write(p, content)?;
        Ok(())
    }

    fn resolved_command(target: &TargetServiceConfig) -> Vec<String> {
        let exe = env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "alexia".to_string());
        target
            .command
            .iter()
            .map(|arg| arg.replace("${ALEXIA_EXE}", &exe))
            .collect()
    }

    // ------------------------------------------------------------------
    // Lifecycle: Start / Stop / Restart / Watchdog
    // ------------------------------------------------------------------
    pub fn start_all_enabled(self: &Arc<Self>) {
        if env::var("ALEXIA_DISABLE_SUPERVISOR_AUTOSTART").ok().as_deref() == Some("1") {
            return;
        }
        for t in self.list_targets(true) {
            if t.runtime == "process" && !t.command.is_empty() {
                let _ = self.start_target(&t.name);
            }
        }
        self.spawn_crash_watchdog();
    }

    fn spawn_crash_watchdog(self: &Arc<Self>) {
        let sup = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;
                for t in sup.list_targets(true) {
                    if t.runtime != "process" {
                        continue;
                    }
                    let mut unexpected_exit: Option<i32> = None;
                    if let Some(entry) = sup.states.get(&t.name) {
                        let mut st = entry.lock();
                        if let Some(ref mut child) = st.child {
                            if let Ok(Some(exit_status)) = child.try_wait() {
                                let code = exit_status.code().unwrap_or(-1);
                                st.child = None;
                                st.pid = None;
                                if !st.intentional_stop {
                                    unexpected_exit = Some(code);
                                }
                            }
                        }
                    }
                    if let Some(code) = unexpected_exit {
                        sup.bus.publish(Event::new(
                            "collector.supervisor",
                            "container_exit",
                            &t.name,
                            "high",
                            HashMap::from([
                                ("exit_code".into(), json!(code)),
                                ("error".into(), json!(format!("Supervised process '{}' exited unexpectedly with code {}", t.name, code))),
                            ]),
                        ));
                    }
                }
            }
        });
    }

    pub fn start_target(&self, name_or_id: &str) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;

        if target.runtime == "docker" || target.runtime == "compose" {
            let container = if target.container_name.is_empty() {
                &target.name
            } else {
                &target.container_name
            };
            let out = Command::new("docker")
                .args(["start", container])
                .output()
                .context("Failed invoking docker CLI")?;
            if !out.status.success() {
                return Err(anyhow!(
                    "docker start {} failed: {}",
                    container,
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            return Ok(json!({"target": target.name, "runtime": "docker", "status": "started"}));
        }

        if target.runtime == "http" {
            return Ok(json!({"target": target.name, "runtime": "http", "status": "external"}));
        }

        let state_mutex = self.states.entry(target.name.clone()).or_default();
        let mut st = state_mutex.lock();

        if let Some(ref mut child) = st.child {
            if child.try_wait()?.is_none() {
                return Ok(json!({
                    "target": target.name,
                    "runtime": "process",
                    "pid": child.id(),
                    "status": "already_running",
                }));
            }
        }

        let cmd_parts = Self::resolved_command(&target);
        if cmd_parts.is_empty() {
            return Err(anyhow!("No command configured for process target {}", target.name));
        }

        let workdir = if target.workdir.is_empty() {
            PathBuf::from(".")
        } else {
            let p = PathBuf::from(&target.workdir);
            let _ = fs::create_dir_all(&p);
            p
        };

        let log_file_path = self.logs_dir().join(format!("{}.log", target.name));
        let stdout_file = File::options()
            .create(true)
            .append(true)
            .open(&log_file_path)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let stderr_file = File::options()
            .create(true)
            .append(true)
            .open(&log_file_path)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());

        let mut cmd = Command::new(&cmd_parts[0]);
        if cmd_parts.len() > 1 {
            cmd.args(&cmd_parts[1..]);
        }
        cmd.current_dir(&workdir)
            .env("ALEXIA_DATA_DIR", self.db.data_dir())
            .stdout(stdout_file)
            .stderr(stderr_file);

        for (k, v) in Self::parse_env_file(&target.env_file) {
            cmd.env(k, v);
        }

        let child = cmd
            .spawn()
            .with_context(|| format!("Failed spawning target process {:?}", cmd_parts))?;
        let pid = child.id();
        st.pid = Some(pid);
        st.child = Some(child);
        st.started_at = Some(Instant::now());
        st.intentional_stop = false;

        Ok(json!({
            "target": target.name,
            "runtime": "process",
            "pid": pid,
            "status": "started",
        }))
    }

    pub fn stop_target(&self, name_or_id: &str, intentional: bool) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;

        if target.runtime == "docker" || target.runtime == "compose" {
            let container = if target.container_name.is_empty() {
                &target.name
            } else {
                &target.container_name
            };
            let _ = Command::new("docker").args(["stop", container]).output();
            return Ok(json!({"target": target.name, "runtime": "docker", "status": "stopped"}));
        }

        if let Some(entry) = self.states.get(&target.name) {
            let mut st = entry.lock();
            st.intentional_stop = intentional;
            if let Some(mut child) = st.child.take() {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                st.pid = None;
                return Ok(json!({"target": target.name, "pid": pid, "status": "stopped"}));
            }
        }
        Ok(json!({"target": target.name, "status": "already_stopped"}))
    }

    pub fn stop_all(&self) {
        for t in self.list_targets(false) {
            let _ = self.stop_target(&t.name, true);
        }
    }

    pub async fn restart_target(&self, name_or_id: &str) -> Result<(bool, Value)> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;

        let _ = self.stop_target(&target.name, true);
        let start_info = self.start_target(&target.name)?;
        if let Some(entry) = self.states.get(&target.name) {
            entry.lock().restart_count += 1;
        }
        let (healthy, probe) = self.probe_health(&target.name, Duration::from_secs(6)).await;
        Ok((
            healthy,
            json!({
                "status": if healthy { "restarted" } else { "unhealthy" },
                "target": target.name,
                "runtime": target.runtime,
                "pid": start_info.get("pid"),
                "health": probe,
            }),
        ))
    }

    pub async fn probe_health(&self, name_or_id: &str, max_wait: Duration) -> (bool, Value) {
        let Some(target) = self.get_target(name_or_id) else {
            return (
                false,
                json!({"status": "unknown_target", "http_code": 0, "latency_ms": 0.0, "timestamp": now_iso()}),
            );
        };
        let deadline = Instant::now() + max_wait;
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let t0 = Instant::now();
            match self.http.get(&target.health_url).send().await {
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    let lat = (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
                    let ok = code < 400;
                    let probe = json!({
                        "url": target.health_url,
                        "status": if ok { "healthy" } else { "unhealthy" },
                        "http_code": code,
                        "latency_ms": lat,
                        "mode": format!("live rust http probe (attempt {})", attempt),
                        "timestamp": now_iso(),
                    });
                    if ok || Instant::now() >= deadline {
                        return (ok, probe);
                    }
                }
                Err(e) => {
                    if Instant::now() >= deadline {
                        return (
                            false,
                            json!({
                                "url": target.health_url,
                                "status": "down",
                                "http_code": 0,
                                "latency_ms": 0.0,
                                "error": e.to_string(),
                                "timestamp": now_iso(),
                            }),
                        );
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    // ------------------------------------------------------------------
    // Real OS Process Telemetry (`sysinfo`)
    // ------------------------------------------------------------------
    pub async fn get_service_telemetry(&self, target: &TargetServiceConfig) -> Value {
        let (healthy, probe) = self.probe_health(&target.name, Duration::from_millis(900)).await;
        let mut pid_opt: Option<u32> = None;
        let mut isolated = false;
        let mut version = "v1.0.0".to_string();
        let mut uptime_secs = 0u64;
        let mut restarts = 0u64;

        if let Some(entry) = self.states.get(&target.name) {
            let st = entry.lock();
            pid_opt = st.pid;
            isolated = st.isolated;
            version = st.current_version.clone();
            restarts = st.restart_count;
            if let Some(started) = st.started_at {
                uptime_secs = started.elapsed().as_secs();
            }
        }

        let (mut cpu_pct, mut mem_mb) = (0.0f64, 0.0f64);
        if let Some(pid_u32) = pid_opt {
            let mut sys = self.sys.lock();
            let pid = Pid::from_u32(pid_u32);
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(proc_info) = sys.process(pid) {
                cpu_pct = ((proc_info.cpu_usage() as f64) * 10.0).round() / 10.0;
                mem_mb = ((proc_info.memory() as f64 / (1024.0 * 1024.0)) * 10.0).round() / 10.0;
            }
        }

        let status = if isolated {
            "isolated"
        } else if healthy {
            "healthy"
        } else {
            "down"
        };

        json!({
            "id": target.id,
            "name": target.name,
            "runtime": target.runtime,
            "status": status,
            "version": version,
            "pid": pid_opt,
            "cpu_percent": cpu_pct,
            "memory_mb": mem_mb,
            "memory_limit_mb": target.memory_limit_mb,
            "uptime_seconds": uptime_secs,
            "restart_count": restarts,
            "upstream_url": target.upstream_url,
            "health_url": target.health_url,
            "last_health_check": probe,
        })
    }

    pub async fn get_all_services_telemetry(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for t in self.list_targets(true) {
            out.push(self.get_service_telemetry(&t).await);
        }
        out
    }

    // ------------------------------------------------------------------
    // Tarball Release Archiving & Rollback (`tar` + `flate2`)
    // ------------------------------------------------------------------
    pub fn create_release_archive(&self, name_or_id: &str, version_tag: &str) -> Result<PathBuf> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let workdir = PathBuf::from(if target.workdir.is_empty() {
            "target-service"
        } else {
            &target.workdir
        });
        fs::create_dir_all(&workdir)?;

        let safe_ver: String = version_tag
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let archive_path = self.releases_dir().join(format!("{}_{}.tar.gz", target.name, safe_ver));

        let tar_gz = File::create(&archive_path)?;
        let enc = GzEncoder::new(tar_gz, Compression::default());
        let mut tar_builder = tar::Builder::new(enc);
        tar_builder.append_dir_all(".", &workdir)?;
        let enc = tar_builder.into_inner()?;
        enc.finish()?;
        Ok(archive_path)
    }

    pub async fn rollback_target(
        &self,
        name_or_id: &str,
        deployment_id: Option<&str>,
    ) -> Result<(bool, Value)> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let workdir = PathBuf::from(if target.workdir.is_empty() {
            "target-service"
        } else {
            &target.workdir
        });

        // Locate most recent valid `.tar.gz` release archive
        let mut archives: Vec<PathBuf> = fs::read_dir(self.releases_dir())
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|d| d.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.starts_with(&format!("{}_", target.name)) && s.ends_with(".tar.gz"))
                    .unwrap_or(false)
            })
            .collect();
        archives.sort();

        if let Some(latest_archive) = archives.last() {
            let _ = self.stop_target(&target.name, true);
            let tar_gz = File::open(latest_archive)?;
            let dec = GzDecoder::new(tar_gz);
            let mut archive = tar::Archive::new(dec);
            fs::create_dir_all(&workdir)?;
            for entry_res in archive.entries()? {
                let mut entry = entry_res?;
                let rel_path = entry.path()?.into_owned();
                if rel_path.is_absolute()
                    || rel_path
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                {
                    anyhow::bail!("Unsafe path detected in release tarball: {}", rel_path.display());
                }
                entry.unpack_in(&workdir)?;
            }
        }

        if let Some(dep_id) = deployment_id {
            if let Some(mut dep) = self.db.get_deployment(dep_id) {
                dep.status = "rolled_back".into();
                dep.rollback_available = false;
                let _ = self.db.upsert_deployment(&dep);
            }
        }

        let (healthy, restart_info) = self.restart_target(&target.name).await?;
        Ok((
            healthy,
            json!({
                "status": "rolled_back",
                "target": target.name,
                "healthy": healthy,
                "restart": restart_info,
            }),
        ))
    }

    // ------------------------------------------------------------------
    // Hygiene, Isolation, Memory, Secret Rotation, Config & Kill Process
    // ------------------------------------------------------------------
    pub fn rotate_logs(&self) -> Result<Value> {
        let dir = self.logs_dir();
        let rotated_dir = dir.join("rotated");
        fs::create_dir_all(&rotated_dir)?;

        let mut rotated_files = Vec::new();
        let mut bytes_reclaimed = 0u64;
        let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();

        for entry in fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if ext != "log" {
                continue;
            }
            let raw = fs::read(&path)?;
            if raw.is_empty() {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("service");
            let gz_path = rotated_dir.join(format!("{}_{}.log.gz", stem, stamp));
            let gz_file = File::create(&gz_path)?;
            let mut enc = GzEncoder::new(gz_file, Compression::default());
            enc.write_all(&raw)?;
            enc.finish()?;

            // Truncate active log file
            fs::write(&path, b"")?;
            bytes_reclaimed += raw.len() as u64;
            rotated_files.push(gz_path.to_string_lossy().to_string());
        }

        Ok(json!({
            "rotated_archives": rotated_files,
            "bytes_reclaimed": bytes_reclaimed,
        }))
    }

    pub fn isolate_target(&self, name_or_id: &str) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let state_mutex = self.states.entry(target.name.clone()).or_default();
        state_mutex.lock().isolated = true;
        Ok(json!({"target": target.name, "gateway_quarantined": true}))
    }

    pub fn unisolate_target(&self, name_or_id: &str) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let state_mutex = self.states.entry(target.name.clone()).or_default();
        state_mutex.lock().isolated = false;
        Ok(json!({"target": target.name, "gateway_quarantined": false}))
    }

    pub fn raise_memory_limit(&self, name_or_id: &str, limit_mb: u64) -> Result<Value> {
        let mut target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        target.memory_limit_mb = limit_mb;
        self.upsert_target(target.clone());
        Ok(json!({"target": target.name, "memory_limit_mb": limit_mb}))
    }

    pub async fn rotate_secret(
        &self,
        name_or_id: &str,
        secret_name: &str,
        new_val: Option<&str>,
    ) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let env_path = if target.env_file.is_empty() {
            self.db.data_dir()
                .join(format!("{}.env", target.name))
                .to_string_lossy()
                .to_string()
        } else {
            target.env_file.clone()
        };
        let mut map = Self::parse_env_file(&env_path);
        let generated = new_val
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("sec_rot_{}", uuid::Uuid::new_v4().simple()));
        map.insert(secret_name.to_string(), generated.clone());
        Self::write_env_file(&env_path, &map)?;
        let (_, reload) = self.restart_target(&target.name).await?;
        Ok(json!({
            "target": target.name,
            "rotated_secret": secret_name,
            "env_file": env_path,
            "fingerprint": format!("{}...{}", &generated[..6], &generated[generated.len()-4..]),
            "reload": reload,
        }))
    }

    pub async fn apply_config_change(
        &self,
        name_or_id: &str,
        changes: &HashMap<String, Value>,
    ) -> Result<Value> {
        let target = self
            .get_target(name_or_id)
            .ok_or_else(|| anyhow!("Unknown target service: {}", name_or_id))?;
        let env_path = if target.env_file.is_empty() {
            self.db.data_dir()
                .join(format!("{}.env", target.name))
                .to_string_lossy()
                .to_string()
        } else {
            target.env_file.clone()
        };
        let mut map = Self::parse_env_file(&env_path);
        let mut applied = Vec::new();
        for (k, v) in changes {
            if k == "target" || k == "service" {
                continue;
            }
            let key_up = k.to_uppercase();
            let val_str = v
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| v.to_string());
            map.insert(key_up.clone(), val_str);
            applied.push(key_up);
        }
        Self::write_env_file(&env_path, &map)?;
        let (_, reload) = self.restart_target(&target.name).await?;
        Ok(json!({"target": target.name, "applied_keys": applied, "reload": reload}))
    }

    pub fn kill_managed_process(&self, name_or_id: &str) -> Result<Value> {
        self.stop_target(name_or_id, false)
    }
}
