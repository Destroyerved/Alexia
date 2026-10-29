#!/usr/bin/env python3
"""MainFrame — Interactive DevSecOps Guardian Terminal Console.

Powered by Rich and NVIDIA Nemotron via Nebius Token Factory.
Provides full scenario testing, live incident monitoring, Tier-1 approval resolution,
cryptographic audit verification, and autonomy kill-switch controls.
"""

from __future__ import annotations
import asyncio
import os
import sys
import time
from typing import Any, Dict, List, Optional

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt

from alexia.actions.approvals import get_approval_manager
from alexia.actions.executor import get_executor
from alexia.api.demo import reset_demo_environment, run_scenario
from alexia.core.audit import get_audit_log
from alexia.core.budget import get_budget_guard
from alexia.core.bus import get_event_bus
from alexia.core.orchestrator import get_orchestrator
from alexia.core.schemas import Action, Incident
from alexia.remote.auth import get_auth_manager
from alexia.remote.controls import get_remote_controller

console = Console()

# 3D ANSI Shadow Font for MAINFRAME in bright cyan
BANNER_ART = """[bold bright_cyan]
███╗   ███╗ █████╗ ██╗███╗   ██╗███████╗██████╗  █████╗ ███╗   ███╗███████╗
████╗ ████║██╔══██╗██║████╗  ██║██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔════╝
██╔████╔██║███████║██║██╔██╗ ██║█████╗  ██████╔╝███████║██╔████╔██║█████╗  
██║╚██╔╝██║██╔══██║██║██║╚██╗██║██╔══╝  ██╔══██╗██╔══██║██║╚██╔╝██║██╔══╝  
██║ ╚═╝ ██║██║  ██║██║██║ ╚████║██║     ██║  ██║██║  ██║██║ ╚═╝ ██║███████╗
╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝
[/bold bright_cyan]"""

SUBTITLE = "[bold cyan]🌐  MainFrame DevSecOps CLI[/bold cyan]\n[cyan]NVIDIA Nemotron • Nebius Token Factory • Zero Data Loss[/cyan]"
SECTION_TITLE = "[bold white]MainFrame CLI — Autonomous Self-Healing, Code Fixing & Security Guardian[/bold white]"


def print_header():
    """Print the ASCII art header and status line matching the target design."""
    console.print(BANNER_ART)
    console.print(f"      {SUBTITLE}\n", justify="left")
    console.print(f"  {SECTION_TITLE}\n", justify="left")


def get_status_summary() -> str:
    executor = get_executor()
    guard = get_budget_guard()
    audit = get_audit_log()
    is_paused = executor.is_autonomy_paused()
    is_valid, count, _ = audit.verify_chain()
    stats = guard.get_daily_stats()

    status_str = (
        f"[bold]Autonomy:[/bold] {'[bold red]PAUSED[/bold red]' if is_paused else '[bold green]ACTIVE[/bold green]'}  │  "
        f"[bold]Audit Chain:[/bold] {'[bold green]Verified ✓[/bold green]' if is_valid else '[bold red]BROKEN[/bold red]'} ({count} rows)  │  "
        f"[bold]Spend:[/bold] [bold green]${stats['total_cost_usd']:.4f}[/bold green] ({stats['total_calls']} calls)"
    )
    return status_str


# ---------------------------------------------------------------------------
# Menu Option 1: Run Demo Scenario
# ---------------------------------------------------------------------------
def menu_run_scenario():
    console.clear()
    print_header()
    console.print(Panel("[bold yellow]🚀 Launch Demo Scenarios (PRD Section 10)[/bold yellow]", style="yellow"))

    table = Table(box=box.ROUNDED, border_style="cyan")
    table.add_column("Key", style="bold cyan", width=6)
    table.add_column("Scenario", style="bold white", width=28)
    table.add_column("Description", style="white")

    scenarios = [
        ("s6", "SQLi & Data Exposure", "Headline Loop: IP block, evidence hash, red-to-green patch, PR, DPDP/CERT-In reports"),
        ("s1", "Bad Deploy & Rollback", "Pre-deploy review flags risk; health gate 500 error; rollback in <60s; Builder fixes bug"),
        ("s2", "Crash & Self-Healing", "Container exit detected in <15s; Healer restarts & verifies health; records runbook"),
        ("s4", "Leaked Secret Gating", "Secret scanner blocks commit containing live Stripe key; requests Tier-1 rotation"),
        ("s3", "Disk Full & Log Rotate", "Volume threshold alert (96%); snapshot taken; log cleanup executed"),
        ("s5", "Brute Force Containment", "500 failed logins in 60s; Sentinel temporarily blocks offending IP address"),
        ("s7", "Destructive Migration", "Migration drops column; Integrity guard dry-run detects data loss and blocks deploy"),
        ("s8", "Mobile Remote Approval", "Issues single-use HMAC token & push notification; verifies step-up authorization"),
        ("s9", "Autonomy Kill Switch", "Activates Kill Switch; simulates crash to prove auto-actions are queued for approval"),
    ]

    for key, name, desc in scenarios:
        table.add_row(key.upper(), name, desc)

    console.print(table)
    choice = Prompt.ask("\n[bold cyan]Select scenario to execute[/bold cyan] (or 'b' to go back)").lower().strip()
    if choice in ("b", "back", ""):
        return

    console.print(f"\n[bold yellow]⚡ Executing Scenario {choice.upper()}...[/bold yellow]")
    with console.status("[bold cyan]Agents collaborating (Nemotron Nano / Super / Ultra)...[/bold cyan]"):
        res = asyncio.run(run_scenario(choice))

    if "error" in res:
        console.print(f"[bold red]✗ Error:[/bold red] {res['error']}")
    else:
        console.print(Panel(
            f"[bold green]✓ {res.get('scenario', choice.upper())} Triggered Successfully![/bold green]\n\n"
            f"[white]{res.get('description', '')}[/white]\n\n"
            f"[dim]Status: {res.get('status')} | View live timeline in Option 3[/dim]",
            title="Scenario Execution Result",
            border_style="green",
        ))

    Prompt.ask("\nPress Enter to return to main menu")


# ---------------------------------------------------------------------------
# Menu Option 2: Pending Approvals
# ---------------------------------------------------------------------------
def menu_approvals():
    console.clear()
    print_header()
    mgr = get_approval_manager()
    pending = mgr.list_pending()

    console.print(Panel("[bold amber]🛡️ Tier-1 Pending Approvals (Human-in-the-Loop)[/bold amber]", style="amber"))

    if not pending:
        console.print("[dim green]✓ No actions currently queued for approval. System fully autonomous.[/dim green]\n")
        Prompt.ask("Press Enter to return to main menu")
        return

    table = Table(box=box.ROUNDED, border_style="amber")
    table.add_column("#", style="bold yellow", width=4)
    table.add_column("Action ID", style="bold white", width=16)
    table.add_column("Operation", style="bold cyan", width=28)
    table.add_column("Reason", style="white")
    table.add_column("Expires In", style="bold red", width=12)

    for idx, appr in enumerate(pending, 1):
        table.add_row(
            str(idx),
            appr["action_id"],
            f"{appr['action']} -> {appr['target']}",
            appr["reason"][:45] + "...",
            f"{appr['seconds_remaining']}s",
        )

    console.print(table)
    action_idx_str = Prompt.ask("\n[bold cyan]Enter row # to decide[/bold cyan] (or 'b' to go back)").strip()
    if action_idx_str.lower() in ("b", "back", ""):
        return

    try:
        idx = int(action_idx_str) - 1
        selected = pending[idx]
    except (ValueError, IndexError):
        console.print("[red]Invalid selection.[/red]")
        time.sleep(1)
        return

    decision = Prompt.ask(
        f"[bold]Decision for {selected['action']}?[/bold]",
        choices=["approve", "reject", "cancel"],
        default="approve",
    )
    if decision == "cancel":
        return

    if decision == "approve":
        totp = Prompt.ask("[bold yellow]Enter 6-digit TOTP / Passkey code[/bold yellow] (Demo: 123456)", default="123456")
        auth = get_auth_manager()
        if not auth.verify_totp(totp):
            console.print("[bold red]✗ Invalid TOTP code.[/bold red]")
            time.sleep(1.5)
            return

        success, msg, data = mgr.decide(
            action_id=selected["action_id"],
            decision="approved",
            decided_by="operator:mainframe",
            step_up_method="totp",
        )
        if success:
            executor = get_executor()
            act = Action(
                id=selected["action_id"],
                action=selected["action"],
                target=selected["target"],
                params=selected["params"],
                tier=1,
                reason=selected["reason"],
                requested_by="operator:mainframe",
            )
            executor.execute(act, is_pre_approved=True)
            console.print(f"[bold green]✓ Action {selected['action']} approved and executed![/bold green]")
        else:
            console.print(f"[bold red]✗ Approval failed: {msg}[/bold red]")
    else:
        mgr.decide(action_id=selected["action_id"], decision="rejected", decided_by="operator:mainframe")
        console.print(f"[bold yellow]Action {selected['action']} rejected.[/bold yellow]")

    time.sleep(1.5)


# ---------------------------------------------------------------------------
# Menu Option 3: Live Incident Feed
# ---------------------------------------------------------------------------
def menu_incident_feed():
    console.clear()
    print_header()
    bus = get_event_bus()
    incidents = bus.list_incidents(limit=15)

    console.print(Panel("[bold cyan]📡 Live Guardian Incident Timeline[/bold cyan]", style="cyan"))

    if not incidents:
        console.print("[dim]No incidents recorded yet. Trigger a scenario from Option 1.[/dim]\n")
        Prompt.ask("Press Enter to return to main menu")
        return

    table = Table(box=box.ROUNDED, border_style="cyan")
    table.add_column("#", style="bold white", width=4)
    table.add_column("Agent", style="bold magenta", width=10)
    table.add_column("Category", style="bold cyan", width=14)
    table.add_column("Severity", width=10)
    table.add_column("Status", width=10)
    table.add_column("Title / Summary", style="white")
    table.add_column("Cost", style="bold green", width=10)

    for idx, inc in enumerate(incidents, 1):
        sev_style = "bold red" if inc.severity == "critical" else "bold yellow" if inc.severity == "high" else "bold blue"
        status_style = "bold green" if inc.status == "resolved" else "bold yellow"

        table.add_row(
            str(idx),
            inc.owner_agent.upper(),
            inc.category,
            f"[{sev_style}]{inc.severity}[/{sev_style}]",
            f"[{status_style}]{inc.status}[/{status_style}]",
            (inc.title or inc.summary)[:50],
            f"${inc.cost_usd:.4f}",
        )

    console.print(table)
    choice = Prompt.ask("\n[bold cyan]Enter row # for details[/bold cyan] (or 'b' to go back)").strip()
    if choice.lower() in ("b", "back", ""):
        return

    try:
        inc = incidents[int(choice) - 1]
        console.clear()
        print_header()

        detail_text = (
            f"[bold cyan]ID:[/bold cyan] {inc.id}\n"
            f"[bold cyan]Agent Owner:[/bold cyan] {inc.owner_agent.upper()}  │  [bold cyan]Category:[/bold cyan] {inc.category}  │  [bold cyan]Status:[/bold cyan] {inc.status}\n"
            f"[bold cyan]Title:[/bold cyan] {inc.title}\n"
            f"[bold cyan]Summary:[/bold cyan] {inc.summary}\n\n"
        )
        if inc.diagnosis.root_cause:
            detail_text += f"[bold yellow]Root Cause (Nemotron Super):[/bold yellow]\n{inc.diagnosis.root_cause}\n\n"

        if inc.diagnosis.sources:
            detail_text += "[bold purple]Tavily Grounding Sources:[/bold purple]\n"
            for s in inc.diagnosis.sources:
                detail_text += f"  • [bold]{s.title}[/bold]: {s.url}\n"
            detail_text += "\n"

        if "proof_of_fix" in inc.metadata:
            proof = inc.metadata["proof_of_fix"]
            detail_text += "[bold green]Proof of Fix (Sandbox Pytest Loop):[/bold green]\n"
            detail_text += f"  • Failed Before (RED): {proof.get('failed_before')}\n"
            detail_text += f"  • Passed After (GREEN): {proof.get('passed_after')}\n\n"

        detail_text += f"[bold green]Total Cost:[/bold green] ${inc.cost_usd:.4f}  │  [bold]Model Calls:[/bold] {len(inc.model_calls)}"

        console.print(Panel(detail_text, title=f"Incident Details — {inc.id}", border_style="cyan"))
        Prompt.ask("\nPress Enter to return")
    except (ValueError, IndexError):
        pass


# ---------------------------------------------------------------------------
# Menu Option 4: Audit Chain
# ---------------------------------------------------------------------------
def menu_audit_chain():
    console.clear()
    print_header()
    audit = get_audit_log()
    is_valid, count, err = audit.verify_chain()
    entries = audit.get_entries(limit=12)

    status_badge = "[bold green]✓ CHAIN 100% VERIFIED — ZERO TAMPERING DETECTED[/bold green]" if is_valid else f"[bold red]✗ TAMPERING DETECTED: {err}[/bold red]"
    console.print(Panel(status_badge, style="green" if is_valid else "red"))

    table = Table(box=box.ROUNDED, border_style="green")
    table.add_column("ID", style="bold white", width=6)
    table.add_column("Timestamp", style="dim", width=20)
    table.add_column("Event Type", style="bold cyan", width=24)
    table.add_column("Actor", style="bold magenta", width=22)
    table.add_column("SHA-256 Hash", style="bold green", width=36)

    for e in entries:
        table.add_row(
            str(e.id),
            e.timestamp[11:19],
            e.event_type,
            e.actor,
            e.hash[:28] + "...",
        )

    console.print(table)
    console.print(f"\n[dim]Ledger verification algorithm: hash = sha256(prev_hash | timestamp | event_type | actor | details_json)[/dim]")
    Prompt.ask("\nPress Enter to return to main menu")


# ---------------------------------------------------------------------------
# Menu Option 5: Remote Controls & Kill Switch
# ---------------------------------------------------------------------------
def menu_controls():
    console.clear()
    print_header()
    executor = get_executor()
    ctrl = get_remote_controller()
    is_paused = executor.is_autonomy_paused()

    console.print(Panel(
        f"[bold]Autonomy State:[/bold] {'[bold red]PAUSED[/bold red]' if is_paused else '[bold green]ACTIVE (Automated Healing Enabled)[/bold green]'}\n\n"
        f"[dim]The Kill Switch immediately stops Tier-0 auto-actions and queues them for manual approval.[/dim]",
        title="⚡ Remote Controls & Autonomy Kill Switch",
        border_style="yellow",
    ))

    console.print("1. Toggle Autonomy Kill Switch (Pause / Resume)")
    console.print("2. Restart Target Service (shoplite-api)")
    console.print("3. Take Precautionary Database Snapshot")
    console.print("4. Run Scheduled Database Integrity Check")
    console.print("5. Return to Main Menu\n")

    c = Prompt.ask("[bold cyan]Select action[/bold cyan]", choices=["1", "2", "3", "4", "5"], default="5")

    if c == "1":
        will_pause = not is_paused
        step_up = "demo.biometric.9999999999.sig" if not will_pause else None
        ok, msg = ctrl.toggle_autonomy(pause=will_pause, user="mainframe_operator", device_id="terminal", step_up_token=step_up)
        console.print(f"[bold {'green' if ok else 'red'}]{msg}[/bold {'green' if ok else 'red'}]")
        time.sleep(1.5)
    elif c == "2":
        ok, msg, _ = ctrl.trigger_action("restart_container", "shoplite-api", {}, "mainframe_operator", "terminal")
        console.print(f"[bold green]✓ {msg}[/bold green]")
        time.sleep(1.5)
    elif c == "3":
        ok, msg, _ = ctrl.trigger_action("take_snapshot", "shoplite-api", {}, "mainframe_operator", "terminal")
        console.print(f"[bold green]✓ {msg}[/bold green]")
        time.sleep(1.5)
    elif c == "4":
        ok, msg, _ = ctrl.trigger_action("run_integrity_check", "shoplite-api", {}, "mainframe_operator", "terminal")
        console.print(f"[bold green]✓ {msg}[/bold green]")
        time.sleep(1.5)


# ---------------------------------------------------------------------------
# Menu Option 6: Model & Cost Analytics
# ---------------------------------------------------------------------------
def menu_analytics():
    console.clear()
    print_header()
    guard = get_budget_guard()
    stats = guard.get_daily_stats()

    console.print(Panel("[bold green]📊 NVIDIA Nemotron on Token Factory Usage & Cost Accounting[/bold green]", style="green"))

    grid = Table.grid(expand=True)
    grid.add_column(justify="center", ratio=1)
    grid.add_column(justify="center", ratio=1)
    grid.add_column(justify="center", ratio=1)

    grid.add_row(
        Panel(f"[bold white]{stats['total_calls']}[/bold white]\n[dim]Total LLM Calls[/dim]", border_style="cyan"),
        Panel(f"[bold green]${stats['total_cost_usd']:.4f}[/bold green]\n[dim]Total USD Spend[/dim]", border_style="green"),
        Panel(f"[bold magenta]{stats['tavily']['total_searches']}[/bold magenta]\n[dim]Tavily Searches[/dim]", border_style="magenta"),
    )
    console.print(grid)

    tier_table = Table(box=box.ROUNDED, border_style="cyan")
    tier_table.add_column("Model Tier", style="bold cyan")
    tier_table.add_column("Model Deployment ID", style="dim")
    tier_table.add_column("Tokens Processed", style="bold white")
    tier_table.add_column("Spend (USD)", style="bold green")
    tier_table.add_column("Primary Workload", style="white")

    b = stats["breakdown"]
    tier_table.add_row("Nemotron 3 Nano (30B)", "nvidia/nemotron-3-nano-30b", f"{b['nano']['tokens']:,}", f"${b['nano']['cost']:.4f}", "Triage, summarisation, runbook matching")
    tier_table.add_row("Nemotron 3 Super (120B)", "nvidia/nemotron-3-super-120b", f"{b['super']['tokens']:,}", f"${b['super']['cost']:.4f}", "Diagnosis, code patches, regression tests")
    tier_table.add_row("Nemotron 3 Ultra (550B)", "nvidia/nemotron-3-ultra-550b", f"{b['ultra']['tokens']:,}", f"${b['ultra']['cost']:.4f}", "Multi-agent planning, timelines, reports")

    console.print(tier_table)
    Prompt.ask("\nPress Enter to return to main menu")


# ---------------------------------------------------------------------------
# Menu Option 7: View Draft Breach Reports
# ---------------------------------------------------------------------------
def menu_reports():
    console.clear()
    print_header()
    bus = get_event_bus()
    incidents = bus.list_incidents(limit=10)

    sqli_inc = next((i for i in incidents if i.metadata and "reports" in i.metadata), None)
    if not sqli_inc:
        console.print("[dim yellow]No breach incident with drafted reports found yet. Run Scenario S6 first.[/dim yellow]\n")
        Prompt.ask("Press Enter to return to main menu")
        return

    reports = sqli_inc.metadata["reports"]
    console.print(Panel("[bold red]📜 Regulatory Cyber Breach Reports (Pre-Drafted by Sentinel)[/bold red]", style="red"))
    console.print("1. CERT-In Incident Report (6-Hour Statutory Clock)")
    console.print("2. India DPDP Rules 2025 (Rule 7) Data Protection Board Notice")
    console.print("3. GDPR Article 33 Notice to Supervisory Authority")
    console.print("4. Return to Main Menu\n")

    c = Prompt.ask("[bold cyan]Select report[/bold cyan]", choices=["1", "2", "3", "4"], default="1")
    if c == "1":
        console.clear()
        console.print(Panel(reports.get("cert_in", "Report unavailable"), title="CERT-In Annexure I Draft", border_style="red"))
        Prompt.ask("\nPress Enter to return")
    elif c == "2":
        console.clear()
        console.print(Panel(reports.get("dpdp", "Report unavailable"), title="DPDP Rules 2025 Notice", border_style="amber"))
        Prompt.ask("\nPress Enter to return")
    elif c == "3":
        console.clear()
        console.print(Panel(reports.get("gdpr", "Report unavailable"), title="GDPR Article 33 Draft", border_style="blue"))
        Prompt.ask("\nPress Enter to return")


# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------
def main():
    # Initialize background bus and orchestrator
    bus = get_event_bus()
    asyncio.run(bus.start())
    orchestrator = get_orchestrator()
    orchestrator.start()

    while True:
        console.clear()
        print_header()

        # Dynamic Status Bar
        console.print(Panel(get_status_summary(), box=box.HORIZONTALS, border_style="cyan"))

        mgr = get_approval_manager()
        pending_cnt = len(mgr.list_pending())
        approval_tag = f" [bold red]({pending_cnt} PENDING)[/bold red]" if pending_cnt > 0 else ""

        console.print("[bold cyan]1.[/bold cyan] 🚀 Run Demo Scenarios [dim](S1 to S9: SQLi, Bad Deploy, Crash, Leaked Key)[/dim]")
        console.print(f"[bold cyan]2.[/bold cyan] 🛡️ Pending Tier-1 Approvals{approval_tag} [dim](Biometric / Passkey Step-Up)[/dim]")
        console.print("[bold cyan]3.[/bold cyan] 📡 Live Incident Timeline & Red-to-Green Fix Proofs")
        console.print("[bold cyan]4.[/bold cyan] 🔒 Cryptographic Audit Ledger [dim](SHA-256 Hash Chain Verification)[/dim]")
        console.print("[bold cyan]5.[/bold cyan] ⚡ Remote Controls & Autonomy Kill Switch")
        console.print("[bold cyan]6.[/bold cyan] 📊 NVIDIA Nemotron Usage & Cost Analytics")
        console.print("[bold cyan]7.[/bold cyan] 📜 View Regulatory Breach Reports [dim](CERT-In, DPDP 2025, GDPR)[/dim]")
        console.print("[bold cyan]8.[/bold cyan] 🔄 Reset Demo Environment")
        console.print("[bold cyan]9.[/bold cyan] 🚪 Exit\n")

        choice = Prompt.ask("[bold cyan]Select option[/bold cyan]", choices=["1", "2", "3", "4", "5", "6", "7", "8", "9"], default="1")

        if choice == "1":
            menu_run_scenario()
        elif choice == "2":
            menu_approvals()
        elif choice == "3":
            menu_incident_feed()
        elif choice == "4":
            menu_audit_chain()
        elif choice == "5":
            menu_controls()
        elif choice == "6":
            menu_analytics()
        elif choice == "7":
            menu_reports()
        elif choice == "8":
            reset_demo_environment()
            console.print("[bold green]✓ Demo environment reset. Autonomy ACTIVE, IP blocklists cleared.[/bold green]")
            time.sleep(1)
        elif choice == "9":
            console.print("\n[bold cyan]Exiting MainFrame CLI. Guardian background daemon active.[/bold cyan]")
            break


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[dim]Process terminated by operator.[/dim]")
