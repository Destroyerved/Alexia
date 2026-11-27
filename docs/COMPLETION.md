# Alexia Completion Contract

This document maps every non-negotiable requirement to the code that implements
it and the automated test that proves it.  Run the proof commands from the
repository root:

```bash
python -m pytest tests/ target-app/tests/ -q
npx vitest run
python evals/run_all.py
```

`tests/test_completion_contract.py` is the executable version of the table
below.  It is deliberately independent of live model APIs, Docker, and the
public internet: unsafe behavior is rejected before it can reach them.

| Requirement | Implementation | Automated proof |
|---|---|---|
| Five independent agents | `alexia/agents/{builder,deployer,healer,sentinel,integrity}.py`, each with its own state and lazy singleton getter | `test_agents_are_independent_and_registered` |
| Agents communicate through defined interfaces | `alexia/agents/base.py` (`GuardianAgent`), `alexia/agents/contracts.py` (registry + `validate_agent_contracts`, which drift-checks capabilities/entrypoints and verifies every entrypoint is callable), Pydantic schemas in `alexia/core/schemas.py` | `test_agents_are_independent_and_registered`, `test_agent_contracts_validate`, `test_agent_contract_validator_detects_drift` |
| Builder cannot execute arbitrary unsafe commands | `alexia/tools/sandbox_policy.py` (AST allowlist, forbidden calls/imports, patch path and primitive checks), `alexia/tools/sandbox.py` (validates before writing/running, strips credentials, only runs `sys.executable`), `alexia/tools/diffutil.py` (path/symlink escape checks) | `test_builder_rejects_unsafe_tests`, `test_builder_rejects_unsafe_patches`, `test_builder_sandbox_environment_strips_secrets`, `test_sandbox_only_runs_its_own_interpreter` |
| Deployer has rollback capabilities | `DeployerAgent.rollback()` and automatic rollback path; rollback is a Tier-0 catalog action recorded on the audit chain | `test_deployer_rollback_is_audited`, workflow S1 in `tests/test_full_workflow.py` |
| Healer cannot modify production without authorization | Every side effect goes through `ActionExecutor`; Tier-1 queues an HMAC approval, Tier-2 is rejected, kill switch queues Tier-0; production health probes never fake success | `test_tier1_actions_require_approval`, `test_kill_switch_queues_tier0_actions`, `test_production_health_probe_does_not_simulate_success` |
| Sentinel detects failures and suspicious activity | `alexia/collectors/health.py` (sustained outage), `authlog.py` (brute force), `dbstats.py` (SQLi/row anomalies), `git_webhook.py` (signed webhooks), `alexia/agents/sentinel.py` (secret scan/containment/evidence) | `test_health_collector_emits_sustained_outage`, `test_bruteforce_and_sqli_detection`, `test_sentinel_secret_scan`, `test_webhook_signature_enforcement` |
| Integrity verifies changes and maintains audit history | `alexia/tools/snapshots.py` (online backup, SHA-256 metadata, atomic restore, post-restore check), `alexia/core/audit.py` (hash chain), `IntegrityAgent.verify_snapshot/verify_integrity/verify_audit_history` | `test_snapshot_restore_and_tamper_detection`, `test_audit_chain_detects_tampering`, `test_integrity_agent_reports_audit_state` |
| SQLite state survives restarts and failures | `alexia/core/sqlite.py` (WAL, `synchronous=FULL`, busy timeout, auto-close), all stores use it; startup `quick_check`; `alexia/tools/backup.py` online backup/restore | `test_sqlite_survives_restart_with_wal`, `test_backup_and_restore_round_trip` |
| Docker deployment works reliably | Multi-stage `Dockerfile` (healthcheck, exec-form CMD, SIGTERM, non-cached frontend build), `.dockerignore`, `docker-compose.yml` (healthchecks, `depends_on: service_healthy`, `init`, restart policy, SQLite-only) | `test_docker_assets_are_production_ready` (static validation) |
| Tests cover important workflows | `tests/` (backend/platform/full workflow/completion contract), `target-app/tests/`, Vitest suites | `python -m pytest ...`, `npx vitest run`, `evals/run_all.py` |
| Documentation explains architecture and installation | `README.md`, `docs/architecture.md`, this file, `.env.example` | `test_documentation_covers_architecture_and_install` |

## Operational notes

- **Data directory:** `ALEXIA_DATA_DIR` is the single source of truth for
  `alexia.db`, evidence, snapshots, and logs.  `ALEXIA_DB` is an optional
  explicit database override.  The old `ALEXIA_DB_PATH` name was never read by
  the code and has been removed from `.env.example`.
- **Production honesty:** with `ALEXIA_ENV=production`, an unreachable
  ShopLite `/health` is a failed verification.  Simulated health is available
  only in development (`ALEXIA_ALLOW_SIMULATED_HEALTH=1`).
- **Webhooks:** with `ALEXIA_ENV=production`, `X-Hub-Signature-256` is
  mandatory and verified against `GITHUB_WEBHOOK_SECRET`.  Unsigned requests
  are accepted only in development.
- **Docker:** both services define healthchecks; Alexia starts only after
  ShopLite is healthy.  ShopLite and Alexia share the `./data` volume, and
  SQLite is the only database (the unused Postgres service was removed).
- **Collectors:** the API lifespan starts health, Docker-event, and optional
  log-tail collectors.  Tests set `ALEXIA_COLLECTORS=off` so they never depend
  on network or Docker availability.

## Live Docker validation

The repository's test suite validates the Docker assets statically on hosts
without a Docker daemon.  On a Docker-capable host, the live checks are:

```bash
cp .env.example .env   # set ALEXIA_SECRET_KEY and GITHUB_WEBHOOK_SECRET
docker compose config
docker compose up --build -d
docker compose ps      # both services should report healthy
curl -fsS http://localhost:8080/health
docker compose down
```
