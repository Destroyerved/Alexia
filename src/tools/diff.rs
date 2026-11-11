//! Pure-Rust Unified Diff Generator & Context-Tolerant Hunk Patcher (`similar`).
//!
//! Locates hunks by context (tolerant to line-number drift) and strictly rejects path traversal.

use anyhow::{bail, Result};
use similar::TextDiff;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path};

pub fn make_diff(rel_path: &str, old: &str, new: &str) -> String {
    let clean_rel = rel_path.trim_start_matches("./").replace('\\', "/");
    TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{}", clean_rel), &format!("b/{}", clean_rel))
        .to_string()
}

#[derive(Debug, Clone)]
pub struct FilePatch {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub hunks: Vec<Vec<String>>,
}

fn strip_diff_prefix(raw: &str) -> Option<String> {
    let token = raw.trim().split('\t').next().unwrap_or("").trim();
    if token.is_empty() || token == "/dev/null" {
        return None;
    }
    let stripped = token
        .strip_prefix("a/")
        .or_else(|| token.strip_prefix("b/"))
        .unwrap_or(token);
    Some(stripped.replace('\\', "/"))
}

pub fn parse_diff(diff_text: &str) -> Vec<FilePatch> {
    let mut files = Vec::new();
    let mut old_path: Option<String> = None;
    let mut new_path: Option<String> = None;
    let mut hunks: Vec<Vec<String>> = Vec::new();
    let mut current_hunk: Option<Vec<String>> = None;
    let mut in_file = false;

    for raw in diff_text.lines() {
        if let Some(rest) = raw.strip_prefix("--- ") {
            if in_file {
                if let Some(h) = current_hunk.take() {
                    hunks.push(h);
                }
                files.push(FilePatch {
                    old_path: old_path.take(),
                    new_path: new_path.take(),
                    hunks: std::mem::take(&mut hunks),
                });
            }
            old_path = strip_diff_prefix(rest);
            new_path = None;
            in_file = true;
        } else if let Some(rest) = raw.strip_prefix("+++ ") {
            new_path = strip_diff_prefix(rest);
        } else if raw.starts_with("@@ ") {
            if let Some(h) = current_hunk.take() {
                hunks.push(h);
            }
            current_hunk = Some(Vec::new());
        } else if let Some(ref mut h) = current_hunk {
            if raw.starts_with(' ') || raw.starts_with('-') || raw.starts_with('+') {
                h.push(raw.to_string());
            } else if raw.is_empty() {
                h.push(" ".to_string());
            }
        }
    }

    if in_file {
        if let Some(h) = current_hunk.take() {
            hunks.push(h);
        }
        files.push(FilePatch {
            old_path,
            new_path,
            hunks,
        });
    }
    files
}

fn find_block(lines: &[String], target: &[String], hint: usize) -> Option<usize> {
    if target.is_empty() {
        return Some(hint.min(lines.len()));
    }
    if target.len() > lines.len() {
        return None;
    }

    // 1. Exact match nearest hint
    let mut exact_hits = Vec::new();
    for i in 0..=(lines.len() - target.len()) {
        if lines[i..i + target.len()] == *target {
            exact_hits.push(i);
        }
    }
    if let Some(&best) = exact_hits.iter().min_by_key(|&&i| i.abs_diff(hint)) {
        return Some(best);
    }

    // 2. Trailing-whitespace-insensitive match nearest hint
    let norm_target: Vec<&str> = target.iter().map(|s| s.trim_end()).collect();
    let mut fuzzy_hits = Vec::new();
    for i in 0..=(lines.len() - target.len()) {
        let slice_matches = lines[i..i + target.len()]
            .iter()
            .zip(norm_target.iter())
            .all(|(a, b)| a.trim_end() == *b);
        if slice_matches {
            fuzzy_hits.push(i);
        }
    }
    fuzzy_hits.into_iter().min_by_key(|&i| i.abs_diff(hint))
}

pub fn apply_diff_to_text(text: &str, hunks: &[Vec<String>]) -> Result<String> {
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let trailing_nl = text.ends_with('\n') || text.is_empty();
    let mut hint = 0usize;

    for (idx, hunk) in hunks.iter().enumerate() {
        let old_block: Vec<String> = hunk
            .iter()
            .filter(|l| l.starts_with(' ') || l.starts_with('-'))
            .map(|l| l.chars().skip(1).collect())
            .collect();
        let new_block: Vec<String> = hunk
            .iter()
            .filter(|l| l.starts_with(' ') || l.starts_with('+'))
            .map(|l| l.chars().skip(1).collect())
            .collect();

        let Some(pos) = find_block(&lines, &old_block, hint) else {
            bail!("hunk {} does not match the current file", idx + 1);
        };
        let end = pos + old_block.len();
        let new_len = new_block.len();
        lines.splice(pos..end, new_block);
        hint = pos + new_len;
    }

    let mut joined = lines.join("\n");
    if trailing_nl && !joined.is_empty() {
        joined.push('\n');
    }
    Ok(joined)
}

fn is_safe_rel_path(rel: &str) -> bool {
    let p = Path::new(rel);
    !p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
}

pub fn apply_diff_to_dir(root: &Path, diff_text: &str) -> Result<HashMap<String, String>> {
    let patches = parse_diff(diff_text);
    if patches.is_empty() || patches.iter().all(|p| p.hunks.is_empty()) {
        bail!("patch contains no hunks");
    }

    let mut staged: HashMap<String, String> = HashMap::new();
    for fp in &patches {
        let Some(rel) = fp.new_path.as_ref().or(fp.old_path.as_ref()) else {
            bail!("patch entry missing file path");
        };
        if !is_safe_rel_path(rel) {
            bail!("refusing to patch path outside sandbox: {}", rel);
        }
        let full = root.join(rel);
        let current = if fp.old_path.is_some() {
            fs::read_to_string(&full)
                .map_err(|_| anyhow::anyhow!("{}: file not found", rel))?
        } else {
            String::new()
        };
        let updated = apply_diff_to_text(&current, &fp.hunks)
            .map_err(|e| anyhow::anyhow!("{}: {}", rel, e))?;
        staged.insert(rel.clone(), updated);
    }

    for (rel, content) in &staged {
        let full = root.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&full, content)?;
    }
    Ok(staged)
}
