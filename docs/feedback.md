# Nebius Token Factory, NVIDIA Nemotron & AI Cloud Feedback Log

*Kept by the Alexia Team during the Nebius x NVIDIA Global AI Hackathon (28–30 Oct 2026).*
*Track: Coding and Agentic Engineering | Eligible for "Most Valuable Feedback" Award.*

---

## 1. Executive Summary

Alexia ran multi-agent autonomous workloads against NVIDIA Nemotron models served on Nebius Token Factory:
- **Nemotron 3 Nano (30B)** for real-time telemetry triage, runbook matching, and push summaries.
- **Nemotron 3 Super (120B)** for log diagnosis, code patch authoring, and failing regression test generation.
- **Nemotron 3 Ultra (550B)** for multi-step breach investigations, incident timelines, and security reviews.

Below is our detailed, actionable feedback covering developer experience, API behavior, model performance, and cloud integration.

---

## 2. Token Factory API & Developer Experience

### 2.1 Model Catalog & Endpoint Discovery
- **What we tried:** Discovering active model IDs dynamically via `GET https://api.tokenfactory.nebius.com/v1/models` during day 1 smoke testing.
- **What happened:** Model IDs in documentation sometimes differed slightly in capitalization and hyphenation from the live endpoints (e.g., `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` vs `nvidia/nemotron-3-nano-30b`).
- **Why it matters:** Hardcoded client requests fail with `404 Not Found` if exact casing is mismatched across catalog pages and console dashboards.
- **Specific Suggestion:** Implement case-insensitive alias routing on Token Factory gateways (e.g. `nemotron-3-nano` pointing to the canonical deployment) and return active alias tags in the `GET /v1/models` JSON payload.

### 2.2 Structured Output Validation (`response_format: {"type": "json_object"}`)
- **What we tried:** Enforcing Pydantic schemas via strict JSON mode on Nano and Super calls.
- **What happened:** Nemotron Super handled JSON generation reliably when prompted with explicit JSON schemas; however, Nano occasionally wrapped the JSON payload in markdown code fences (` ```json ... ``` `).
- **Why it matters:** Client parsers without defensive regex un-fencing fail with `json.decoder.JSONDecodeError`, forcing retries or model escalations.
- **Specific Suggestion:** Add native JSON-schema constrained decoding (grammar-based sampling) at the Token Factory inference engine level so tokens outside the JSON schema cannot be emitted.

### 2.3 Latency & Context Windows
- **What we tried:** Reading log tails (±2 minutes) and full git diffs with Nemotron Super and Ultra.
- **Observation:**
  - **Nano:** Extremely rapid time-to-first-token (~140ms), perfect for low-latency detection loops (<30s MTTR).
  - **Super:** Average completion latency ~1.8s for code generation, very steady.
  - **Ultra:** Deep reasoning and timeline construction took ~4.2s, with consistent high quality.
- **Suggestion:** Provide a streaming server-timing header (e.g., `Server-Timing: ttfb;dur=..., inference;dur=...`) in the HTTP response headers for real-time SRE tracing.

---

## 3. NVIDIA Nemotron Model Evaluation

### 3.1 Nemotron 3 Nano (30B)
- **Strengths:** Unbeatable cost efficiency ($0.06 / $0.24 per 1M tokens) enables scanning every single event without burning hackathon budgets. High accuracy on category classification (crash, OOM, disk full, security).
- **Opportunity:** Needs defensive parsing for clean JSON strings without trailing commas or explanatory preambles.

### 3.2 Nemotron 3 Super (120B) — The Centerpiece
- **Strengths:** Excellent Python code generation. When presented with the division-by-zero bug or the SQL injection search endpoint, Super authored both the failing regression test and the clean parameterized query patch with 100% syntactic correctness.
- **Opportunity:** Provide official examples of diff-generation prompts in the Token Factory cookbook to standardize patch output formatting.

### 3.3 Nemotron 3 Ultra (550B)
- **Strengths:** Outstanding multi-document synthesis. Ultra accurately reconciled query logs, IP indicators, and database schemas into coherent chronological attack timelines and regulatory draft notices (CERT-In, DPDP, GDPR).
- **Opportunity:** Token Factory pricing ($1.00 / $3.00 per 1M) is reasonable for complex escalations, but cached prompt prefix support would reduce cost by 50%+ for repeated system prompts.

---

## 4. Grounding & Search (Tavily Integration)
- Grounding Nemotron Super's diagnoses with Tavily search results dramatically improved fix accuracy on obscure Docker exit codes and CVE patterns.
- 24-hour SHA-256 query hashing kept our Tavily credit consumption well within the free tier budget while delivering real-time documentation URLs in the dashboard.
