# Alexia Server Manager

Windows desktop application and one-click NSIS installer for **Alexia — Autonomous DevSecOps Guardian**.

Everything needed to turn a Windows PC into an always-on DevSecOps Guardian server is bundled inside `Alexia-Server-Setup-1.0.0.exe` — including the compiled `AlexiaServer.exe` runtime, the 5 Guardian agents (`Sentinel`, `Healer`, `Builder`, `Deployer`, `Integrity`), the embedded React 19 + Tailwind v4 Web/Mobile PWA console, SQLite + SHA-256 tamper-evident audit ledger, and the `ShopLite` sandbox target service.

- **Dashboard**: Live CPU, memory, requests/min, and event-loop lag sparklines; active incident & Tier 1 approval counters; SHA-256 audit chain status; LAN/Tailscale/Internet addresses; and Windows boot auto-start toggles.
- **Console**: Live tail of `C:\Alexia\logs\alexia.log` and `watchdog.log`, plus interactive commands (`help`, `status`, `start`, `stop`, `restart`, `backup`, `health`, `check`, `tailscale`, `open`, `clear`).
- **Backups**: One-click online SQLite backups (`alexia-YYYYMMDD-HHMMSS.db`), optional second-copy folder (USB drive or cloud sync), and point-in-time restore.
- **Guardian console**: Embedded `<webview>` of the Alexia DevSecOps Guardian Dashboard (`http://127.0.0.1:8080`).
- **Internet**: One-click Tailscale Funnel, Cloudflare Tunnel, or Cloudflare Quick Tunnel setup.
- **Settings**: Visual `.env` editor (`C:\Alexia\app\.env`) for Nebius Token Factory (`NEBIUS_API_KEY`), Tavily Search (`TAVILY_API_KEY`), budget guardrails, ntfy alerts, and backup schedules.
- **Setup**: One-click Install / Upgrade / Repair wizard running `deploy/windows/install.ps1`.

## Building the Installer `.exe`

```powershell
cd manager
npm install
npm run dist
```

Output: `manager/release/Alexia-Server-Setup-1.0.0.exe`
