# Alexia DevSecOps Guardian — Agent & Architecture Context

> **Project Identity:** Alexia — Autonomous DevSecOps Guardian  
> **Hackathon:** Nebius x NVIDIA Global AI Hackathon (Devpost)  
> **Track:** Coding and Agentic Engineering (+ Best Use of Tavily Bonus)  
> **Hard Deadline:** Friday, 30 October 2026, 10:00 AM PT (22:30 IST)  
> **Core Value Proposition:** An autonomous team of five AI agents powered by NVIDIA Nemotron on Nebius Token Factory that writes code fixes, runs sandboxed tests, deploys with health gates, self-heals runtime crashes, blocks security breaches, and snapshots state to guarantee zero data loss.

---

## 1. System Topology & Core Loop

```
DETECTION ──► TRIAGE ──► SNAPSHOT ──► DIAGNOSE ──► PLAN ──► ACT ──► VERIFY ──► LEARN
(Collectors)   Nano      Integrity     Super +     Ultra    Executor  Health     Runbook +
             classify    (pre-action)  Tavily               (Typed)   Re-check   Incident
             severity                  sources              Tiers                Reports
```

### Event Bus & State Ledger
- **In-process Pub/Sub:** `alexia/core/bus.py` handles event dispatch with asyncio queues.
- **Persistent State:** SQLite (`data/alexia.db`) persists all `events`, `incidents`, and `incident_transitions`.
- **Live Stream:** Real-time Server-Sent Events (`/stream`) pushes state changes to web, mobile, and CLI clients in &lt;100ms.

---

## 2. NVIDIA Nemotron Model Routing (Nebius Token Factory)

Inference base URL: `https://api.tokenfactory.nebius.com/v1/` (`alexia/core/llm.py`). Model configurations are located in `config/models.yaml`:

| Tier | Model ID | Context | Price / 1M Tokens (In / Out) | Primary Workload |
|---|---|---|---|---|
| **Nano** | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262K | $0.06 / $0.24 | Event triage, log summarisation, secret-scan verification, runbook matching, push notification one-liners. |
| **Super** | `nvidia/nemotron-3-super-120b-a12b` | 256K | $0.30 / $0.90 | Root cause diagnosis, code patch authoring, failing regression test writing, structured JSON extraction. |
| **Ultra** | `nvidia/Nemotron-3-Ultra-550b-a55b` | 1M | $1.00 / $3.00 | Multi-agent orchestration, fix planning, attack timeline reconstruction, patch security review, migration guard review. |

### Escalation & Guard Policies
- **Nano confidence < 0.70:** Automatically escalates triage to Super.
- **Super fix fails verification twice:** Escalates to Ultra to re-plan.
- **Runbook Memory (`alexia/core/memory.py`):** Caches `(signature -> working fix)` pairs. Repeated incidents are confirmed by Nano and resolved immediately without invoking Ultra.
- **Cost Guard (`alexia/core/budget.py`):** Enforces daily token and USD caps ($10.00 / 5M tokens). Automatically engages deterministic replay mode upon exhaustion so public demo links never break.
- **Tavily Grounding (`alexia/tools/tavily.py`):** Live web search for error signatures and CVEs with a 24-hour SHA-256 query cache.

---

## 3. The 5 Specialized Agents

1. **Builder Agent (`alexia/agents/builder.py`) — Centerpiece of Coding Track:**
   - Pre-deploy code review with Nemotron Super / Ultra (FR-B1).
   - Generates failing regression tests (`pytest`) reproducing bug (RED) and unified diff patches (GREEN) (FR-B2).
   - Runs isolated sandbox testing loop with test execution feedback (`alexia/tools/sandbox.py`) (FR-B3).
   - Attaches red-to-green proof logs to PRs opened via GitHub REST API (`alexia/tools/github.py`) (FR-B4, FR-B5).
   - Ultra conducts security self-review on the patch before PR opening (FR-B6).

2. **Deployer Agent (`alexia/agents/deployer.py`):**
   - Webhook trigger on `main` push with HMAC-SHA256 signature verification (FR-D1).
   - Pre-deploy tri-gate: Sentinel secret scan, Integrity migration guard, Builder review (FR-D2).
   - 3-minute health gate monitoring `/health` and 5xx rates; executes automatic rollback in &lt;60s on failure (FR-D4).

3. **Healer Agent (`alexia/agents/healer.py`):**
   - Collectors for Docker exit events, health check failures, and log error spikes (FR-H1).
   - Triages with Nano, diagnoses with Super grounded in Tavily search results, executes recovery actions, and verifies health (FR-H2–FR-H5).
   - Automatically hands code-bug root causes to the Builder agent (FR-H6).

4. **Sentinel Agent (`alexia/agents/sentinel.py`):**
   - Scans diffs for leaked secrets (Stripe, OpenAI, GitHub, AWS keys) (FR-S1).
   - Detects brute-force authentication attacks (>500/min) and SQL injection patterns (FR-S2, FR-S3).
   - Preserves raw forensic logs with SHA-256 hash in `data/evidence/` **before** containment (FR-S6).
   - Temporary reverse-proxy IP containment (FR-S5).
   - Ultra timeline reconstruction & automated drafting of **CERT-In (6-hour)**, **DPDP Rules 2025 (Rule 7)**, and **GDPR Art. 33** breach reports (FR-S7, FR-S8).

5. **Integrity Agent (`alexia/agents/integrity.py`):**
   - Pre-action snapshots of DB and volumes with SHA-256 hashes recorded to audit chain (FR-I1).
   - Scheduled database checks (FR-I2).
   - Migration guard: dry-runs migration SQL on throwaway DB copy; blocks deploy on data loss (FR-I3).
   - Forensic data-exposure assessment: calculates affected tables, columns, and rows for Sentinel (FR-I5).
   - One-click restore to any snapshot with post-restore verification (FR-I4).

---

## 4. Safety Architecture & Action Catalog

Enforced in `alexia/actions/catalog.py` and `alexia/actions/executor.py`:

- **Tier 0 (Auto):** Safe actions (`restart_container`, `rollback_to_last_good_image`, `clear_tmp_and_rotate_logs`, `block_ip_temporarily`, `take_snapshot`, `run_integrity_check`, `open_pull_request`). Automatically snapshots state before executing data-touching operations.
- **Tier 1 (Approval):** Mutating actions queued with 5-minute single-use HMAC-SHA256 tokens (`restore_snapshot`, `rotate_secret`, `isolate_container_network`, `apply_config_change`, `raise_memory_limit`, `run_migration`, `merge_pull_request_and_deploy`, `kill_process`). Requires human click or step-up authentication.
- **Tier 2 (Forbidden):** Arbitrary shell execution, deleting volumes/backups, dropping tables outside guard — **rejected in code**.
- **Autonomy Kill Switch (FR-M6):** When paused, all Tier-0 auto-actions are queued for manual approval. Resuming requires step-up elevation (TOTP / passkey).
- **Tamper-Evident Audit Ledger (FR-C8):** Append-only table storing $\text{SHA256}(\text{prev\_hash} \parallel \text{timestamp} \parallel \text{actor} \parallel \text{details\_json})$.
- **Redaction Layer (FR-C4):** Strips API keys, JWTs, Luhn-verified credit cards, emails, phone numbers, and 12-digit national IDs before prompts leave the system.

---

## 5. Frontends & Client Interfaces

1. **`MainFrame` / `MainFrame.py` (Interactive Terminal CLI):**
   - Styled with cyan ANSI Shadow banner and Rich interactive components.
   - Run via: `PYTHONPATH=. python MainFrame.py` or `./MainFrame`.
   - Allows running scenarios (S1-S9), approving Tier-1 actions, viewing live incidents, verifying audit hash chain, viewing regulatory breach reports, and toggling the kill switch.
2. **Web Dashboard & Mobile PWA (`dashboard/static/`):**
   - Installable Progressive Web App (`manifest.json`, `sw.js`).
   - Served at `http://localhost:8080/`.
   - Live SSE stream (`/stream`), 1-tap approvals with TOTP/biometric step-up, kill switch, and model cost panels.
   - Demo account: `user: demo` / `pass: alexiaguardian2026` (TOTP shortcut: `123456`).

---

## 6. Demo Scenarios & Test Commands

- **Unit & Integration Tests:**
  ```bash
  PYTHONPATH=. pytest tests/test_platform.py -v && PYTHONPATH=target-app pytest target-app/tests/ -v
  ```
- **3x Scenario Evaluation Suite (S1, S2, S4, S6, S8, S9):**
  ```bash
  PYTHONPATH=. python evals/run_all.py
  ```
- **Terminal CLI:**
  ```bash
  PYTHONPATH=. python MainFrame.py
  # or
  ./MainFrame
  ```
- **Full Stack Docker Compose:**
  ```bash
  docker compose up --build
  ```
