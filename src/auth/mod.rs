//! Pure-Rust Cryptographic Auth, RFC 6238 TOTP, ECDSA P-256 WebAuthn Passkeys & Single-Use Approval Tokens.
//!
//! Zero hardcoded credentials (`admin` / `alexia-demo`) and zero hardcoded TOTP (`123456`) backdoors.

use crate::core::db::{AlexiaDb, OperatorRecord, PasskeyCredential};
use crate::core::schemas::{now_iso, Action, PendingApproval};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{TimeZone, Utc};
use dashmap::DashMap;
use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use rand::RngCore;
use scrypt::{scrypt, Params as ScryptParams};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::env;
use std::sync::Arc;

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Generates a 160-bit (20-byte) RFC 4648 Base32 TOTP secret.
pub fn generate_totp_secret() -> String {
    let mut bytes = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut bytes);
    BASE32_NOPAD.encode(&bytes)
}

/// Computes a 6-digit RFC 6238 HMAC-SHA1 TOTP code for a given Unix timestamp (30-second step).
pub fn compute_totp_at(base32_secret: &str, unix_secs: u64) -> Result<String> {
    let normalized = base32_secret.trim().replace(' ', "").to_uppercase();
    let normalized = normalized.trim_end_matches('=');
    let key = BASE32_NOPAD
        .decode(normalized.as_bytes())
        .map_err(|e| anyhow!("Invalid Base32 TOTP secret: {}", e))?;

    let counter = unix_secs / 30;
    let mut mac = HmacSha1::new_from_slice(&key).map_err(|e| anyhow!("HMAC init error: {}", e))?;
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();

    let offset = (hash[19] & 0x0f) as usize;
    let bin_code = ((hash[offset] as u32 & 0x7f) << 24)
        | ((hash[offset + 1] as u32) << 16)
        | ((hash[offset + 2] as u32) << 8)
        | (hash[offset + 3] as u32);
    Ok(format!("{:06}", bin_code % 1_000_000))
}

pub fn current_totp(base32_secret: &str) -> Result<String> {
    let now = Utc::now().timestamp().max(0) as u64;
    compute_totp_at(base32_secret, now)
}

fn hash_password_scrypt(password: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    // N=16384 (log_n=14), r=8, p=1 -> strong OWASP interactive parameters
    let params = ScryptParams::new(14, 8, 1, 32).map_err(|e| anyhow!(e.to_string()))?;
    let mut derived = [0u8; 32];
    scrypt(password.as_bytes(), &salt, &params, &mut derived)
        .map_err(|e| anyhow!(e.to_string()))?;
    Ok(format!("scrypt$14$8$1${}${}", hex::encode(salt), hex::encode(derived)))
}

fn verify_password_scrypt(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 6 || parts[0] != "scrypt" {
        return false;
    }
    let Ok(log_n) = parts[1].parse::<u8>() else { return false };
    let Ok(r) = parts[2].parse::<u32>() else { return false };
    let Ok(p) = parts[3].parse::<u32>() else { return false };
    let Ok(salt) = hex::decode(parts[4]) else { return false };
    let Ok(expected) = hex::decode(parts[5]) else { return false };
    let Ok(params) = ScryptParams::new(log_n, r, p, expected.len()) else { return false };
    let mut derived = vec![0u8; expected.len()];
    if scrypt(password.as_bytes(), &salt, &params, &mut derived).is_err() {
        return false;
    }
    constant_time_eq(&derived, &expected)
}

pub struct AuthManager {
    db: Arc<AlexiaDb>,
    hmac_secret: Vec<u8>,
    challenges: DashMap<String, (String, u64)>, // challenge -> (username, expires_epoch)
}

impl AuthManager {
    pub fn new(db: Arc<AlexiaDb>) -> Arc<Self> {
        let secret = env::var("ALEXIA_SECRET_KEY")
            .ok()
            .filter(|s| s.len() >= 16)
            .map(|s| s.into_bytes())
            .unwrap_or_else(|| {
                let mut key = vec![0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                key
            });

        let mgr = Arc::new(Self {
            db,
            hmac_secret: secret,
            challenges: DashMap::new(),
        });

        // Support automated headless bootstrap via explicit env vars if provided by ops deployment
        if !mgr.has_operators() {
            if let Ok(pw) = env::var("ALEXIA_ADMIN_PASSWORD") {
                if pw.trim().len() >= 8 {
                    let user = env::var("ALEXIA_ADMIN_USER").unwrap_or_else(|_| "admin".into());
                    let _ = mgr.setup_initial_operator(&user, pw.trim());
                }
            }
        }
        mgr
    }

    pub fn has_operators(&self) -> bool {
        !self.db.list_operators().is_empty()
    }

    pub fn operator_count(&self) -> usize {
        self.db.list_operators().len()
    }

    pub fn list_operator_summaries(&self) -> Vec<Value> {
        self.db
            .list_operators()
            .into_iter()
            .map(|o| {
                json!({
                    "username": o.username,
                    "role": o.role,
                    "created_at": o.created_at,
                    "passkeys_registered": o.passkeys.len(),
                })
            })
            .collect()
    }

    pub fn setup_initial_operator(&self, username: &str, password: &str) -> Result<Value> {
        if self.has_operators() {
            bail!("Initial operator already enrolled. Additional operators require authenticated admin access.");
        }
        let clean_user = username.trim();
        if clean_user.len() < 2 {
            bail!("Operator username must be at least 2 characters.");
        }
        if password.len() < 8 {
            bail!("Operator password must be at least 8 characters.");
        }

        let pw_hash = hash_password_scrypt(password)?;
        let totp_secret = generate_totp_secret();
        let uri = format!(
            "otpauth://totp/AlexiaGuardian:{}?secret={}&issuer=AlexiaGuardian&algorithm=SHA1&digits=6&period=30",
            clean_user, totp_secret
        );

        let rec = OperatorRecord {
            username: clean_user.to_string(),
            password_scrypt: pw_hash,
            totp_secret: totp_secret.clone(),
            role: "admin".to_string(),
            created_at: now_iso(),
            passkeys: Vec::new(),
        };
        self.db.upsert_operator(&rec)?;
        let _ = self.db.record_audit(
            "operator_enrolled",
            &format!("operator:{}", clean_user),
            json!({"username": clean_user, "role": "admin"}),
        );

        Ok(json!({
            "username": clean_user,
            "totp_secret": totp_secret,
            "provisioning_uri": uri,
        }))
    }

    pub fn verify_credentials(&self, username: &str, password: &str) -> bool {
        let Some(op) = self.db.get_operator(username.trim()) else {
            return false;
        };
        verify_password_scrypt(password, &op.password_scrypt)
    }

    pub fn verify_totp(&self, code: &str, username: Option<&str>) -> (bool, Option<String>) {
        let clean = code.trim();
        if clean.len() != 6 || !clean.chars().all(|c| c.is_ascii_digit()) {
            return (false, None);
        }
        let now = Utc::now().timestamp().max(60) as u64;
        let ops: Vec<OperatorRecord> = match username.filter(|u| !u.trim().is_empty()) {
            Some(u) => self.db.get_operator(u.trim()).into_iter().collect(),
            None => self.db.list_operators(),
        };

        for op in ops {
            for step_offset in [-30i64, 0, 30] {
                let ts = (now as i64 + step_offset).max(0) as u64;
                if let Ok(expected) = compute_totp_at(&op.totp_secret, ts) {
                    if constant_time_eq(clean.as_bytes(), expected.as_bytes()) {
                        return (true, Some(op.username));
                    }
                }
            }
        }
        (false, None)
    }

    // ------------------------------------------------------------------
    // Signed HMAC-SHA256 Session & Step-Up Tokens
    // ------------------------------------------------------------------
    fn sign_payload(&self, payload: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.hmac_secret).expect("HMAC key valid");
        mac.update(payload.as_bytes());
        let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{}.{}", URL_SAFE_NO_PAD.encode(payload.as_bytes()), sig)
    }

    fn verify_signed_payload(&self, token: &str) -> Option<Value> {
        let (b64_body, b64_sig) = token.split_once('.')?;
        let raw_bytes = URL_SAFE_NO_PAD.decode(b64_body.as_bytes()).ok()?;
        let payload_str = String::from_utf8(raw_bytes).ok()?;

        let mut mac = HmacSha256::new_from_slice(&self.hmac_secret).ok()?;
        mac.update(payload_str.as_bytes());
        let expected_sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        if !constant_time_eq(b64_sig.as_bytes(), expected_sig.as_bytes()) {
            return None;
        }
        serde_json::from_str::<Value>(&payload_str).ok()
    }

    pub fn create_session_token(&self, username: &str, device_id: &str) -> String {
        let exp = Utc::now().timestamp() + 86400;
        let payload = json!({
            "kind": "session",
            "sub": username,
            "dev": device_id,
            "exp": exp,
        })
        .to_string();
        self.sign_payload(&payload)
    }

    pub fn create_step_up_token(&self, username: &str, method: &str) -> String {
        let exp = Utc::now().timestamp() + 300;
        let payload = json!({
            "kind": "step_up",
            "sub": username,
            "method": method,
            "exp": exp,
            "nonce": uuid::Uuid::new_v4().simple().to_string(),
        })
        .to_string();
        self.sign_payload(&payload)
    }

    pub fn verify_step_up_token(&self, token: &str) -> (bool, Option<String>, Option<String>) {
        let Some(val) = self.verify_signed_payload(token.trim()) else {
            return (false, None, None);
        };
        if val.get("kind").and_then(|v| v.as_str()) != Some("step_up") {
            return (false, None, None);
        }
        let exp = val.get("exp").and_then(|v| v.as_i64()).unwrap_or(0);
        if Utc::now().timestamp() > exp {
            return (false, None, None);
        }
        let sub = val.get("sub").and_then(|v| v.as_str()).map(|s| s.to_string());
        let method = val.get("method").and_then(|v| v.as_str()).map(|s| s.to_string());
        (true, sub, method)
    }

    // ------------------------------------------------------------------
    // Cryptographic ECDSA P-256 WebAuthn Passkey Verification
    // ------------------------------------------------------------------
    pub fn issue_webauthn_challenge(&self, username: &str) -> String {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let challenge = URL_SAFE_NO_PAD.encode(raw);
        let exp = (Utc::now().timestamp().max(0) as u64) + 300;
        self.challenges
            .insert(challenge.clone(), (username.to_string(), exp));
        challenge
    }

    pub fn register_passkey(
        &self,
        username: &str,
        credential_id: &str,
        public_key_pem: &str,
        label: &str,
    ) -> Result<()> {
        // Validate SPKI PEM parses as a genuine NIST P-256 public key
        let _ = VerifyingKey::from_public_key_pem(public_key_pem)
            .map_err(|e| anyhow!("Invalid ECDSA P-256 SPKI PEM public key: {}", e))?;
        let mut op = self
            .db
            .get_operator(username)
            .ok_or_else(|| anyhow!("Unknown operator: {}", username))?;
        op.passkeys.retain(|p| p.credential_id != credential_id);
        op.passkeys.push(PasskeyCredential {
            credential_id: credential_id.to_string(),
            public_key_pem: public_key_pem.to_string(),
            sign_count: 0,
            label: label.to_string(),
            registered_at: now_iso(),
        });
        self.db.upsert_operator(&op)?;
        Ok(())
    }

    /// Verifies a JSON WebAuthn assertion (`credential_id`, `authenticator_data`, `client_data_json`, `signature` DER/raw b64url).
    pub fn verify_passkey_assertion(&self, assertion_json: &str) -> (bool, Option<String>) {
        let Ok(parsed) = serde_json::from_str::<Value>(assertion_json) else {
            return (false, None);
        };
        let Some(cred_id) = parsed.get("credential_id").and_then(|v| v.as_str()) else {
            return (false, None);
        };
        let Some(auth_data_b64) = parsed.get("authenticator_data").and_then(|v| v.as_str()) else {
            return (false, None);
        };
        let Some(client_json_b64) = parsed.get("client_data_json").and_then(|v| v.as_str()) else {
            return (false, None);
        };
        let Some(sig_b64) = parsed.get("signature").and_then(|v| v.as_str()) else {
            return (false, None);
        };

        let Ok(auth_data) = URL_SAFE_NO_PAD.decode(auth_data_b64.as_bytes()) else {
            return (false, None);
        };
        if auth_data.len() < 37 {
            return (false, None);
        }
        // User-Present (UP) bit 0x01 must be set
        if (auth_data[32] & 0x01) == 0 {
            return (false, None);
        }
        let sign_count = u32::from_be_bytes([auth_data[33], auth_data[34], auth_data[35], auth_data[36]]);

        let Ok(client_data_bytes) = URL_SAFE_NO_PAD.decode(client_json_b64.as_bytes()) else {
            return (false, None);
        };
        let Ok(client_data) = serde_json::from_slice::<Value>(&client_data_bytes) else {
            return (false, None);
        };
        if client_data.get("type").and_then(|v| v.as_str()) != Some("webauthn.get") {
            return (false, None);
        }
        let Some(challenge) = client_data.get("challenge").and_then(|v| v.as_str()) else {
            return (false, None);
        };

        // Single-use challenge consumption (prevents replay)
        let Some((_, (_expected_user, exp))) = self.challenges.remove(challenge) else {
            return (false, None);
        };
        if (Utc::now().timestamp().max(0) as u64) > exp {
            return (false, None);
        }

        let Ok(sig_bytes) = URL_SAFE_NO_PAD.decode(sig_b64.as_bytes()) else {
            return (false, None);
        };
        let signature = Signature::from_der(&sig_bytes)
            .or_else(|_| Signature::from_slice(&sig_bytes));
        let Ok(signature) = signature else {
            return (false, None);
        };

        let mut client_hasher = Sha256::new();
        client_hasher.update(&client_data_bytes);
        let client_hash = client_hasher.finalize();

        let mut signed_msg = Vec::with_capacity(auth_data.len() + 32);
        signed_msg.extend_from_slice(&auth_data);
        signed_msg.extend_from_slice(&client_hash);

        for mut op in self.db.list_operators() {
            if let Some(pk) = op.passkeys.iter_mut().find(|p| p.credential_id == cred_id) {
                if pk.sign_count > 0 && sign_count <= pk.sign_count {
                    return (false, None);
                }
                let Ok(vk) = VerifyingKey::from_public_key_pem(&pk.public_key_pem) else {
                    return (false, None);
                };
                if vk.verify(&signed_msg, &signature).is_ok() {
                    pk.sign_count = sign_count;
                    let username = op.username.clone();
                    let _ = self.db.upsert_operator(&op);
                    return (true, Some(username));
                }
            }
        }
        (false, None)
    }

    pub fn hmac_token_for_action(&self, action_id: &str, expires_epoch: f64) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.hmac_secret).expect("HMAC key valid");
        mac.update(format!("approval|{}|{:.3}", action_id, expires_epoch).as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }
}

/// Manages Tier-1 human-in-the-loop approvals with 5-minute TTL and single-use HMAC tokens.
pub struct ApprovalManager {
    db: Arc<AlexiaDb>,
    auth: Arc<AuthManager>,
}

impl ApprovalManager {
    pub fn new(db: Arc<AlexiaDb>, auth: Arc<AuthManager>) -> Arc<Self> {
        Arc::new(Self { db, auth })
    }

    pub fn create_pending(
        &self,
        action: &mut Action,
        incident_id: &str,
        snapshot_id: Option<String>,
    ) -> String {
        let ttl_secs = self
            .db
            .get_settings()
            .get("approval_ttl_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(300);
        let now_ep = Utc::now().timestamp_millis() as f64 / 1000.0;
        let exp_ep = now_ep + ttl_secs as f64;
        let exp_iso = Utc
            .timestamp_opt(exp_ep as i64, 0)
            .single()
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();

        let token = self.auth.hmac_token_for_action(&action.id, exp_ep);
        action.status = "pending".into();
        action.approval_token = Some(token.clone());

        let blast_radius = match action.action.as_str() {
            "run_migration" | "restore_snapshot" => "Database schema & stored customer records",
            "merge_pull_request_and_deploy" => "Live application code & upstream deployment",
            "isolate_container_network" => "All external ingress to target service",
            "rotate_secret" => "Active API credentials & target service restart",
            _ => "Single supervised target service",
        };

        let rec = PendingApproval {
            id: action.id.clone(),
            action_id: action.id.clone(),
            incident_id: incident_id.to_string(),
            action_name: action.action.clone(),
            target: action.target.clone(),
            affected_service: action.target.clone(),
            tier: action.tier,
            params: action.params.clone(),
            reason: action.reason.clone(),
            expected_outcome: action.expected_outcome.clone(),
            rollback: action.rollback.clone(),
            blast_radius: blast_radius.to_string(),
            requested_by: action.requested_by.clone(),
            snapshot_id,
            token: token.clone(),
            status: "pending".into(),
            created_at: now_iso(),
            expires_at_epoch: exp_ep,
            expires_at: exp_iso,
            decided_by: None,
            decided_at: None,
            step_up_method: None,
        };
        let _ = self.db.upsert_approval(&rec);
        let _ = self.db.record_audit(
            "approval_requested",
            &action.requested_by,
            json!({"action_id": action.id, "action": action.action, "target": action.target, "incident_id": incident_id}),
        );
        token
    }

    pub fn decide(
        &self,
        action_id: &str,
        decision: &str,
        decided_by: &str,
        step_up_method: Option<&str>,
        provided_token: Option<&str>,
    ) -> Result<PendingApproval, String> {
        let dec = decision.trim().to_lowercase();
        if dec != "approved" && dec != "rejected" {
            return Err("Decision must be 'approved' or 'rejected'.".into());
        }

        let Some(mut rec) = self.db.get_approval(action_id) else {
            return Err(format!("Approval request {} not found.", action_id));
        };

        if rec.status != "pending" {
            return Err(format!("Action {} was already {}.", action_id, rec.status));
        }

        let now_ep = Utc::now().timestamp_millis() as f64 / 1000.0;
        if now_ep > rec.expires_at_epoch {
            rec.status = "expired".into();
            let _ = self.db.upsert_approval(&rec);
            return Err("Approval token has expired (5-minute TTL exceeded).".into());
        }

        if let Some(tok) = provided_token.filter(|s| !s.is_empty()) {
            if !constant_time_eq(tok.as_bytes(), rec.token.as_bytes()) {
                return Err("Invalid approval HMAC token signature.".into());
            }
        }

        rec.status = dec.clone();
        rec.decided_by = Some(decided_by.to_string());
        rec.decided_at = Some(now_iso());
        rec.step_up_method = step_up_method.map(|s| s.to_string());
        let _ = self.db.upsert_approval(&rec);

        let _ = self.db.record_audit(
            &format!("action_{}", dec),
            decided_by,
            json!({
                "action_id": rec.action_id,
                "action": rec.action_name,
                "target": rec.target,
                "step_up_method": step_up_method,
            }),
        );
        Ok(rec)
    }

    pub fn list_pending(&self) -> Vec<PendingApproval> {
        self.db.list_approvals(true)
    }

    pub fn list_all(&self) -> Vec<PendingApproval> {
        self.db.list_approvals(false)
    }
}
