//! Regulatory Breach Notification Draft Generators (CERT-In 6-Hour, India DPDP Act, GDPR Art. 33).

use crate::core::redact::redact;
use crate::core::schemas::now_iso;

pub fn generate_cert_in_report(
    incident_id: &str,
    incident_type: &str,
    service: &str,
    attacker_ip: &str,
    payload_summary: &str,
    evidence_hash: &str,
    actions_taken: &[String],
) -> String {
    let actions = actions_taken
        .iter()
        .map(|a| format!("- {}", redact(a)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# CERT-In Mandatory 6-Hour Cyber Security Incident Report\n\n\
         - **Incident Reference:** `{}`\n\
         - **Generated Timestamp (UTC):** `{}`\n\
         - **Reporting Window:** Within 6 Hours of Detection (CERT-In Directions 2022)\n\
         - **Classification:** {}\n\
         - **Affected System:** `{}`\n\n\
         ## Technical Indicators & Forensic Hash\n\
         - **Source IP:** `{}`\n\
         - **Redacted Payload Summary:** `{}`\n\
         - **Immutable Evidence SHA-256:** `{}`\n\n\
         ## Automated Containment & Mitigation Actions\n\
         {}\n",
        incident_id,
        now_iso(),
        redact(incident_type),
        service,
        if attacker_ip.is_empty() { "N/A" } else { attacker_ip },
        redact(payload_summary),
        evidence_hash,
        actions
    )
}

pub fn generate_dpdp_report(
    incident_id: &str,
    nature_of_breach: &str,
    exposed_rows: u64,
    exposed_fields: &[String],
    mitigation_steps: &[String],
) -> String {
    let steps = mitigation_steps
        .iter()
        .map(|s| format!("- {}", redact(s)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# Digital Personal Data Protection (DPDP) Act Breach Intimation Draft\n\n\
         - **Incident ID:** `{}`\n\
         - **Timestamp (UTC):** `{}`\n\
         - **Nature of Personal Data Breach:** {}\n\
         - **Estimated Data Principals in Scope:** `{}`\n\
         - **Categories of Personal Data Involved:** `{:?}`\n\n\
         ## Remedial Measures Implemented\n\
         {}\n",
        incident_id,
        now_iso(),
        redact(nature_of_breach),
        exposed_rows,
        exposed_fields,
        steps
    )
}

pub fn generate_gdpr_report(
    incident_id: &str,
    root_cause: &str,
    records_count: u64,
    consequences: &str,
    remedial_measures: &[String],
) -> String {
    let steps = remedial_measures
        .iter()
        .map(|s| format!("- {}", redact(s)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# GDPR Article 33 Supervisory Authority Notification (72-Hour Window)\n\n\
         - **Incident ID:** `{}`\n\
         - **Generated At (UTC):** `{}`\n\
         - **Root Cause Vector:** {}\n\
         - **Approximate Data Subjects Affected:** `{}`\n\
         - **Likely Consequences:** {}\n\n\
         ## Measures Taken by Controller (Alexia Guardian)\n\
         {}\n",
        incident_id,
        now_iso(),
        redact(root_cause),
        records_count,
        redact(consequences),
        steps
    )
}
