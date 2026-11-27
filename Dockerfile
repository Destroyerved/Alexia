# Stage 1: Build React 19 + TypeScript + Tailwind v4 + Mobile PWA Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# Stage 2: Build Python Wheels (isolates compiler toolchain from runtime image)
FROM python:3.11-slim AS python-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# Stage 3: Hardened Python 3.11 Runtime + FastAPI + Guardian Multi-Agent Backend
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    ALEXIA_ENV=production \
    ALEXIA_DATA_DIR=/app/data \
    ALEXIA_BACKUP_DIR=/app/backups

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    patch \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system alexia \
    && useradd --system --gid alexia --home-dir /app --shell /usr/sbin/nologin alexia

COPY --from=python-builder /wheels /wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

COPY . .
COPY --from=frontend-builder /frontend/dashboard/static ./dashboard/static

RUN mkdir -p /app/data /app/data/evidence /app/data/snapshots /app/data/logs /app/backups \
    && chown -R alexia:alexia /app

USER alexia

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

STOPSIGNAL SIGTERM

# Exec form: uvicorn receives SIGTERM directly and drains in-flight requests.
CMD ["uvicorn", "alexia.api.main:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
