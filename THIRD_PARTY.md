# Third-Party Dependencies and Licenses

Alexia strictly uses permissive open-source licenses (MIT, Apache-2.0, BSD, PSF) and complies with the Nebius x NVIDIA Hackathon Rule R15.

## Backend (Python)

| Package | License | Purpose |
|---|---|---|
| `fastapi` | MIT | High-performance async REST API and SSE transport |
| `uvicorn` | BSD-3-Clause | ASGI web server |
| `pydantic` | MIT | Data validation and schema enforcement |
| `sse-starlette` | BSD-3-Clause | Server-Sent Events (SSE) streaming |
| `httpx` | BSD-3-Clause | Async HTTP client (used for GitHub REST API & LLM calls) |
| `openai` | Apache-2.0 | Standard client targeting Nebius Token Factory API |
| `tavily-python` | MIT | Grounded web search and CVE intelligence |
| `pywebpush` | MPL-2.0 | Web Push notifications (used unmodified as an external library) |
| `pyotp` | MIT | Time-based one-time passwords for mobile fallback authentication |
| `cryptography` | Apache-2.0 / BSD | Cryptographic primitives for HMAC tokens and hash chains |
| `pyyaml` | MIT | YAML configuration parsing |
| `docker` | Apache-2.0 | Docker Engine Python SDK for container lifecycle management |
| `pytest` | MIT | Testing framework for sandbox test generation and evals |

## Frontend & Mobile Companion (Web / PWA)

| Package | License | Purpose |
|---|---|---|
| `react` | MIT | UI component library |
| `react-dom` | MIT | React DOM renderer |
| `vite` | MIT | Build tool and dev server |
| `vite-plugin-pwa` | MIT | Service worker generation and PWA offline manifest |
| `tailwindcss` | MIT | Utility-first CSS styling framework |
| `lucide-react` | MIT | Icons for dashboard and mobile interfaces |

## Infrastructure & Runtimes

- **Python 3.11+**: Python Software Foundation (PSF) License
- **SQLite 3**: Public Domain (local metadata, event persistence, and audit hash chain)
- **PostgreSQL 16**: PostgreSQL License (permissive)
- **Caddy Web Server**: Apache-2.0
