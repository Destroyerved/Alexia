# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build React 19 Control Plane & Mobile PWA Assets (`dashboard/static`)
# ==============================================================================
FROM node:22-alpine AS ui-builder
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN mkdir -p /build/dashboard/static && npm run build

# ==============================================================================
# Stage 2: Compile Pure-Rust `alexia` Standalone Binary (with `rust-embed` UI)
# ==============================================================================
FROM rust:1-bookworm AS rust-builder
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY .cargo/ ./.cargo/
COPY src/ ./src/
COPY tests/ ./tests/
COPY --from=ui-builder /build/dashboard/static ./dashboard/static
RUN cargo build --release --locked --bin alexia

# ==============================================================================
# Stage 3: Minimal Hardened Production Runtime
# ==============================================================================
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/alexia
COPY --from=rust-builder /build/target/release/alexia /usr/local/bin/alexia
COPY config/ ./config/
COPY target-service/ ./target-service/

ENV ALEXIA_ENV=production \
    ALEXIA_HOST=0.0.0.0 \
    ALEXIA_PORT=8080 \
    ALEXIA_GATEWAY_PORT=8000 \
    ALEXIA_DATA_DIR=/var/lib/alexia/data

RUN mkdir -p /var/lib/alexia/data

EXPOSE 8080 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["alexia", "--no-browser"]
