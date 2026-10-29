"""One-Click Server Setup & Launcher for Alexia — Autonomous DevSecOps Guardian.

Bundles and launches:
1. Environment & directory setup (data/, evidence/, snapshots/, .env, config/models.yaml).
2. Embedded React 19 + TypeScript + Tailwind CSS v4 + Mobile Companion PWA (dashboard/static/).
3. SQLite persistence & SHA-256 tamper-evident cryptographic audit ledger initialization.
4. ShopLite Target FastAPI Service (port 8000, background thread).
5. Alexia Guardian FastAPI Server + Live SSE Stream + Web/Mobile PWA (port 8080) with auto-browser launch.
"""

from __future__ import annotations
import argparse
import os
import shutil
import socket
import sys
import threading
import time
import webbrowser
from typing import Optional

import uvicorn


def _configure_windows_console() -> None:
    """Enable UTF-8 output and ANSI escape sequences on Windows consoles."""
    if sys.platform == "win32":
        os.system("")
        if hasattr(sys.stdout, "reconfigure"):
            try:
                sys.stdout.reconfigure(encoding="utf-8")
            except Exception:
                pass
        if hasattr(sys.stderr, "reconfigure"):
            try:
                sys.stderr.reconfigure(encoding="utf-8")
            except Exception:
                pass


# Python 3.11's Windows Proactor loop closes the *listening* socket when an accept fails with
# WinError 64 (a client dropping mid-handshake), after which the server silently stops accepting
# connections. The selector loop does not have this failure mode.
UVICORN_LOOP = "asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto"


def _get_bundle_dir() -> str:
    """Return PyInstaller _MEIPASS directory if frozen, else repository root."""
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def _is_port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) != 0


def _load_dotenv_file(dotenv_path: str = ".env") -> None:
    if not os.path.exists(dotenv_path):
        return
    try:
        with open(dotenv_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


def setup_workspace() -> None:
    """Ensure all runtime directories, configuration files, and static PWA assets exist."""
    bundle_dir = _get_bundle_dir()

    # 1. Runtime data directories
    for d in ("data", "data/evidence", "data/snapshots", "config", "dashboard/static"):
        os.makedirs(d, exist_ok=True)

    # 2. Extract config/models.yaml if running standalone
    target_models_yaml = os.path.join("config", "models.yaml")
    bundled_models_yaml = os.path.join(bundle_dir, "config", "models.yaml")
    if not os.path.exists(target_models_yaml) and os.path.exists(bundled_models_yaml):
        shutil.copy2(bundled_models_yaml, target_models_yaml)

    # 3. Extract .env from .env.example if .env does not exist
    bundled_env_example = os.path.join(bundle_dir, ".env.example")
    if not os.path.exists(".env"):
        if os.path.exists(".env.example"):
            shutil.copy2(".env.example", ".env")
        elif os.path.exists(bundled_env_example):
            shutil.copy2(bundled_env_example, ".env")
    _load_dotenv_file(".env")

    # 4. Extract compiled React 19 PWA into dashboard/static when missing or from an older build
    target_static = os.path.join("dashboard", "static")
    target_index = os.path.join(target_static, "index.html")
    bundled_static = os.path.join(bundle_dir, "dashboard", "static")
    bundled_index = os.path.join(bundled_static, "index.html")
    if os.path.exists(bundled_index) and os.path.abspath(bundled_static) != os.path.abspath(target_static):
        with open(bundled_index, "rb") as f:
            bundled_html = f.read()
        current_html = b""
        if os.path.exists(target_index):
            with open(target_index, "rb") as f:
                current_html = f.read()
        # index.html names the hashed JS/CSS bundles, so any frontend change shows up here
        if current_html != bundled_html:
            shutil.copytree(bundled_static, target_static, dirs_exist_ok=True)


def _start_shoplite_target_in_background(port: int = 8000) -> Optional[threading.Thread]:
    """Start the ShopLite target FastAPI app on port 8000 if available."""
    if not _is_port_free(port):
        return None

    def _run_target() -> None:
        try:
            bundle_dir = _get_bundle_dir()
            target_dir = os.path.join(bundle_dir, "target-app")
            if os.path.exists("target-app"):
                target_dir = os.path.abspath("target-app")
            if target_dir not in sys.path:
                sys.path.insert(0, target_dir)
            from app.main import app as shoplite_app  # type: ignore

            config = uvicorn.Config(shoplite_app, host="127.0.0.1", port=port, log_level="warning", loop=UVICORN_LOOP)
            server = uvicorn.Server(config)
            server.run()
        except Exception:
            pass

    t = threading.Thread(target=_run_target, name="shoplite-target", daemon=True)
    t.start()
    return t


def _open_browser_when_ready(url: str, port: int) -> None:
    def _wait_and_open() -> None:
        for _ in range(40):
            if not _is_port_free(port):
                time.sleep(0.4)
                try:
                    webbrowser.open(url)
                except Exception:
                    pass
                return
            time.sleep(0.25)

    threading.Thread(target=_wait_and_open, name="browser-opener", daemon=True).start()


def print_banner() -> None:
    cyan = "\033[96m"
    green = "\033[92m"
    bold = "\033[1m"
    reset = "\033[0m"
    print(f"{cyan}{bold}")
    print("=" * 74)
    print("   █████╗ ██╗     ███████╗██╗  ██╗██╗ █████╗ ")
    print("  ██╔══██╗██║     ██╔════╝╚██╗██╔╝██║██╔══██╗")
    print("  ███████║██║     █████╗   ╚███╔╝ ██║███████║")
    print("  ██╔══██║██║     ██╔══╝   ██╔██╗ ██║██╔══██║")
    print("  ██║  ██║███████╗███████╗██╔╝ ██╗██║██║  ██║")
    print("  ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝")
    print("  AUTONOMOUS DEVSECOPS GUARDIAN — ONE-CLICK SERVER SETUP & LAUNCHER")
    print("=" * 74)
    print(f"{reset}{green}  Powered by NVIDIA Nemotron 3 on Nebius Token Factory + Tavily Search{reset}\n")


def main() -> int:
    _configure_windows_console()
    _load_dotenv_file(".env")

    default_host = os.environ.get("HOST", "0.0.0.0")
    default_port = int(os.environ.get("PORT", "8080") or "8080")

    parser = argparse.ArgumentParser(description="Alexia One-Click Server Setup & Launcher")
    parser.add_argument("--host", default=default_host, help="Host interface to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=default_port, help="Port for Alexia Guardian Server (default: 8080)")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser on startup")
    parser.add_argument("--cli", action="store_true", help="Launch MainFrame Interactive Terminal CLI")
    parser.add_argument("--backup", action="store_true", help="Take an online SQLite database backup and exit")
    parser.add_argument("--Verify", "--verify-setup", dest="verify_setup", action="store_true", help="Verify setup, DB, audit chain, and API routes then exit")
    args = parser.parse_args()

    if args.backup:
        setup_workspace()
        from alexia.tools.backup import run_backup

        run_backup()
        return 0

    print_banner()

    print("  [1/5] Preparing Workspace, Configuration & Embedded React PWA Assets...")
    setup_workspace()

    if args.cli:
        import MainFrame
        MainFrame.main()
        return 0

    print("  [2/5] Initializing SQLite Persistence & SHA-256 Cryptographic Audit Chain...")
    from alexia.api.demo import seed_initial_demo_state
    from alexia.api.main import app as alexia_app
    from alexia.core.audit import get_audit_log

    seed_initial_demo_state()
    audit_ok, rows_checked, _ = get_audit_log().verify_chain()
    print(f"        -> Audit Ledger Verified: {audit_ok} ({rows_checked} signed hash-chain blocks)")

    print("  [3/5] Activating 5 Guardian Agents (Sentinel, Healer, Builder, Deployer, Integrity)...")

    if args.verify_setup:
        from fastapi.testclient import TestClient

        client = TestClient(alexia_app)
        r_health = client.get("/health")
        r_dash = client.get("/api/v1/dashboard")
        assert r_health.status_code == 200, "Health check failed"
        assert r_dash.status_code == 200, "Dashboard API check failed"
        print("  [OK] Self-verification passed: /health and /api/v1/dashboard responded HTTP 200.")
        return 0

    print("  [4/5] Starting ShopLite Target Sandbox Service (http://127.0.0.1:8000)...")
    _start_shoplite_target_in_background(port=8000)

    port = args.port
    if not _is_port_free(port):
        for candidate in range(8081, 8095):
            if _is_port_free(candidate):
                print(f"        -> Port {args.port} is in use; switching to port {candidate}")
                port = candidate
                break

    url = f"http://localhost:{port}"
    print(f"  [5/5] Launching Alexia Guardian Server & Web/Mobile PWA on {url} ...")
    print("\n" + "-" * 74)
    print(f"  Web Dashboard & Mobile PWA : {url}")
    print(f"  Live SSE Event Stream      : {url}/stream  (and {url}/api/v1/events)")
    print(f"  REST API Documentation     : {url}/docs")
    print("  Demo Operator Login        : user: demo  |  pass: alexiaguardian2026")
    print("  Press Ctrl+C to stop the server.")
    print("-" * 74 + "\n")

    if not args.no_browser:
        _open_browser_when_ready(url, port)

    uvicorn.run(alexia_app, host=args.host, port=port, log_level="info", loop=UVICORN_LOOP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
