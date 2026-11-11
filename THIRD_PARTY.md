# Third-Party Dependencies and Open-Source Licenses

Alexia v3.0 uses permissive open-source dependencies across both its Pure-Rust core and embedded React 19 Control Plane.

## Pure-Rust Core & Terminal UI (`Cargo.toml`)

| Crate | License | Purpose |
| :--- | :---: | :--- |
| `tokio` / `tokio-stream` / `futures-util` | MIT | Asynchronous runtime, TCP listeners, timers & broadcast streams |
| `axum` / `tower` / `tower-http` | MIT | Control Plane HTTP/SSE router & inline reverse-proxy WAF gateway |
| `reqwest` | MIT / Apache-2.0 | Multi-provider LLM HTTP client & upstream reverse-proxy forwarding |
| `redb` | MIT / Apache-2.0 | Pure-Rust ACID copy-on-write embedded B-tree database |
| `sqlparser` | Apache-2.0 | Pure-Rust SQL AST parser for migration dry-runs & PII exposure audits |
| `sha2` / `sha1` / `hmac` / `scrypt` / `p256` | MIT / Apache-2.0 | RustCrypto primitives (SHA-256 audit chain, RFC 6238 TOTP, Scrypt, WebAuthn P-256) |
| `sysinfo` | MIT | Cross-platform OS process PID, CPU%, and RSS memory telemetry |
| `tar` / `flate2` | MIT / Apache-2.0 | Pure-Rust `.tar.gz` release archiving, rollbacks & `.log.gz` rotation |
| `similar` | Apache-2.0 | Unified diff generation for autonomous patch synthesis |
| `rust-embed` | MIT | Compile-time embedding of React 19 SPA & Mobile PWA assets |
| `ratatui` / `crossterm` | MIT | Interactive cross-platform Terminal Command Center (`--tui`) |
| `clap` / `serde` / `serde_json` / `serde_yaml` | MIT / Apache-2.0 | CLI argument parsing & strongly-typed configuration/API serialization |
| `dashmap` / `parking_lot` | MIT / Apache-2.0 | Concurrent lock-free WAF IP blocklist & synchronization primitives |

## Embedded Web Control Plane & Mobile PWA (`ui/package.json`)

| Package | License | Purpose |
| :--- | :---: | :--- |
| `react` / `react-dom` (v19) | MIT | Component rendering for Desktop Control Plane & Mobile PWA |
| `lucide-react` | ISC | Technical iconography |
| `vite` / `vite-plugin-pwa` | MIT | Production SPA bundler & offline service worker manifest |
| `vitest` / `@testing-library/react` | MIT | Automated frontend unit & component test suite |
