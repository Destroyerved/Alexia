//! Runtime directory resolution for Alexia-rs (`ALEXIA_DATA_DIR`-aware for hermetic testing & production).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub fn data_dir() -> PathBuf {
    let base = env::var("ALEXIA_DATA_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"));
    let _ = fs::create_dir_all(&base);
    base
}

pub fn db_path() -> PathBuf {
    if let Ok(explicit) = env::var("ALEXIA_DB") {
        if !explicit.trim().is_empty() {
            let p = PathBuf::from(explicit);
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            return p;
        }
    }
    data_dir().join("alexia.redb")
}

pub fn subdir(name: &str) -> PathBuf {
    let dir = data_dir().join(name);
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn evidence_dir() -> PathBuf {
    subdir("evidence")
}

pub fn snapshots_dir() -> PathBuf {
    subdir("snapshots")
}

pub fn releases_dir() -> PathBuf {
    subdir("releases")
}

pub fn logs_dir() -> PathBuf {
    subdir("logs")
}

pub fn git_staging_dir(service: &str) -> PathBuf {
    let dir = data_dir().join("git_staging").join(service);
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn ensure_runtime_dirs() {
    let _ = data_dir();
    let _ = evidence_dir();
    let _ = snapshots_dir();
    let _ = releases_dir();
    let _ = logs_dir();
    let _ = fs::create_dir_all(Path::new("config"));
}
