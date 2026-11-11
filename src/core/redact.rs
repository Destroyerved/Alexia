//! Multi-layer secret, token, credential URI, PII & Luhn credit-card redaction engine
//! plus `<untrusted_log>` prompt-injection boundary escaping.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

pub static RE_OPENAI_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{16,}\b").unwrap());
pub static RE_STRIPE_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b").unwrap());
pub static RE_GITHUB_TOKEN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{24,}\b").unwrap());
pub static RE_AWS_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap());
pub static RE_GEMINI_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bAIza[0-9A-Za-z_\-]{31,39}\b").unwrap());
pub static RE_ANTHROPIC_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\bsk-ant-[A-Za-z0-9_\-]{16,}\b").unwrap());
pub static RE_TAVILY_KEY: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\btvly-[A-Za-z0-9_\-]{16,}\b").unwrap());
pub static RE_JWT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b").unwrap());
pub static RE_PRIVATE_KEY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
        .unwrap()
});
pub static RE_DB_URI: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s'"<>]+"#).unwrap());
pub static RE_EMAIL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").unwrap());
pub static RE_PHONE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:\+\d{1,3}[\s\-]?)?(?:\(\d{3}\)|\d{3})[\s\-]?\d{3}[\s\-]?\d{4}\b").unwrap());
pub static RE_CARD_CANDIDATE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b(?:\d[ \-]*?){13,19}\b").unwrap());

/// Validates a numeric sequence using the ISO/IEC 7812 Luhn checksum algorithm.
pub fn is_valid_luhn(raw: &str) -> bool {
    let digits: Vec<u32> = raw.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let mut sum = 0u32;
    let mut double = false;
    for &d in digits.iter().rev() {
        let mut n = d;
        if double {
            n *= 2;
            if n > 9 {
                n -= 9;
            }
        }
        sum += n;
        double = !double;
    }
    sum % 10 == 0
}

/// Scrubs secrets, credentials, JWTs, DB connection strings, PII, and Luhn-valid payment cards.
pub fn redact(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut s = input.to_string();
    s = RE_PRIVATE_KEY.replace_all(&s, "[REDACTED_PRIVATE_KEY]").into_owned();
    s = RE_STRIPE_KEY.replace_all(&s, "[REDACTED_STRIPE_KEY]").into_owned();
    s = RE_ANTHROPIC_KEY.replace_all(&s, "[REDACTED_ANTHROPIC_KEY]").into_owned();
    s = RE_OPENAI_KEY.replace_all(&s, "[REDACTED_API_KEY]").into_owned();
    s = RE_GITHUB_TOKEN.replace_all(&s, "[REDACTED_GITHUB_TOKEN]").into_owned();
    s = RE_AWS_KEY.replace_all(&s, "[REDACTED_AWS_KEY]").into_owned();
    s = RE_GEMINI_KEY.replace_all(&s, "[REDACTED_GEMINI_KEY]").into_owned();
    s = RE_TAVILY_KEY.replace_all(&s, "[REDACTED_TAVILY_KEY]").into_owned();
    s = RE_JWT.replace_all(&s, "[REDACTED_JWT]").into_owned();
    s = RE_DB_URI.replace_all(&s, "[REDACTED_DB_URI]").into_owned();
    s = RE_EMAIL.replace_all(&s, "[REDACTED_EMAIL]").into_owned();

    // Luhn-checked payment card numbers BEFORE phone numbers so 16-digit cards aren't partially eaten
    s = RE_CARD_CANDIDATE
        .replace_all(&s, |caps: &regex::Captures| {
            let m = &caps[0];
            if is_valid_luhn(m) {
                "[REDACTED_CARD]".to_string()
            } else {
                m.to_string()
            }
        })
        .into_owned();

    s = RE_PHONE.replace_all(&s, "[REDACTED_PHONE]").into_owned();
    s
}

/// Recursively redacts all string leaves inside an arbitrary `serde_json::Value`.
pub fn redact_json(val: &Value) -> Value {
    match val {
        Value::String(s) => Value::String(redact(s)),
        Value::Array(arr) => Value::Array(arr.iter().map(redact_json).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let lower = k.to_lowercase();
                if lower.contains("password") || lower.contains("secret") || lower == "api_key" || lower == "token" {
                    out.insert(k.clone(), Value::String("[REDACTED_SECRET]".to_string()));
                } else {
                    out.insert(k.clone(), redact_json(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Wraps untrusted log/payload input inside escaped `<untrusted_log>` XML boundaries so prompt injections cannot break out.
pub fn wrap_untrusted_log(raw: &str) -> String {
    let scrubbed = redact(raw)
        .replace("</untrusted_log>", "&lt;/untrusted_log&gt;")
        .replace("<untrusted_log>", "&lt;untrusted_log&gt;");
    format!("<untrusted_log>\n{}\n</untrusted_log>", scrubbed)
}

/// Scans a git diff for leaked credentials and returns masked findings (never persisting raw secrets).
pub fn scan_diff_for_secrets(diff_text: &str) -> Vec<(String, String)> {
    let mut findings = Vec::new();
    let checks: &[(&str, &Regex)] = &[
        ("Stripe Secret Key", &RE_STRIPE_KEY),
        ("Anthropic API Key", &RE_ANTHROPIC_KEY),
        ("OpenAI API Key", &RE_OPENAI_KEY),
        ("GitHub Personal Access Token", &RE_GITHUB_TOKEN),
        ("AWS Access Key", &RE_AWS_KEY),
        ("Google Gemini API Key", &RE_GEMINI_KEY),
        ("Private Cryptographic Key", &RE_PRIVATE_KEY),
    ];

    for line in diff_text.lines() {
        if !line.starts_with('+') || line.starts_with("+++") {
            continue;
        }
        for (label, rx) in checks {
            for mat in rx.find_iter(line) {
                let s = mat.as_str();
                let masked = if s.len() > 12 {
                    format!("{}****{}", &s[..8], &s[s.len() - 4..])
                } else {
                    "[REDACTED]".to_string()
                };
                findings.push(((*label).to_string(), masked));
            }
        }
    }
    findings
}
