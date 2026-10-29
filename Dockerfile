# Stage 1: Build React 19 + TypeScript + Tailwind v4 + Mobile PWA Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# Stage 2: Python 3.11 + FastAPI + Guardian Multi-Agent Backend
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    patch \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=frontend-builder /frontend/dashboard/static ./dashboard/static

EXPOSE 8080

CMD ["uvicorn", "alexia.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
