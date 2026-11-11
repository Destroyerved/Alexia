//! Self-contained Windows `gnullvm` COFF import library bridge.
//!
//! When building on `x86_64-pc-windows-gnullvm` without an external MinGW installation,
//! legacy `winapi 0.3` crates emit `-ladvapi32`, `-lcfgmgr32`, `-lbcrypt`, etc. without the `winapi_` prefix.
//! This build script maps `libwinapi_<name>.a` COFF import archives into `$OUT_DIR/lib<name>.a` so `rust-lld`
//! resolves every Win32 import library completely self-contained.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let target = env::var("TARGET").unwrap_or_default();
    if !target.contains("windows-gnullvm") {
        return;
    }

    let Ok(out_dir_str) = env::var("OUT_DIR") else {
        return;
    };
    let out_dir = PathBuf::from(out_dir_str);

    let cargo_home = env::var("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|_| env::var("USERPROFILE").map(|u| PathBuf::from(u).join(".cargo")))
        .or_else(|_| env::var("HOME").map(|h| PathBuf::from(h).join(".cargo")));

    if let Ok(ch) = cargo_home {
        let reg_src = ch.join("registry").join("src");
        if let Ok(indices) = fs::read_dir(&reg_src) {
            for idx in indices.flatten() {
                if let Ok(crates) = fs::read_dir(idx.path()) {
                    for krate in crates.flatten() {
                        let name = krate.file_name().to_string_lossy().to_string();
                        if name.starts_with("winapi-x86_64-pc-windows-gnu-") {
                            let lib_dir = krate.path().join("lib");
                            if let Ok(libs) = fs::read_dir(&lib_dir) {
                                for lib_entry in libs.flatten() {
                                    let fname = lib_entry.file_name().to_string_lossy().to_string();
                                    if let Some(stripped) = fname.strip_prefix("libwinapi_") {
                                        let alias = out_dir.join(format!("lib{}", stripped));
                                        if !alias.exists() {
                                            let _ = fs::copy(lib_entry.path(), &alias);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
}
