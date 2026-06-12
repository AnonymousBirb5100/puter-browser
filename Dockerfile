# ── Stage 0: Clone repo + submodules ────────────────────────────────────────
FROM alpine/git AS gitclone
RUN git clone --recurse-submodules https://github.com/HeyPuter/browser.js /app


# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM rust:1 AS builder

# Install Node.js 24 and curl
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Add the WebAssembly Rust target
RUN rustup target add wasm32-unknown-unknown

# Install Rust WASM tools
RUN cargo install wasm-bindgen-cli --version 0.2.105
RUN cargo install wasm-snip

# Install binaryen (provides wasm-opt)
RUN curl -L https://github.com/WebAssembly/binaryen/releases/download/version_128/binaryen-version_128-x86_64-linux.tar.gz \
    | tar xz --strip-components=1 -C /usr/local

# Use the freshly cloned source (submodules already present)
COPY --from=gitclone /app /app
WORKDIR /app

# Build steps from CONTRIBUTING.md
RUN pnpm i
RUN pnpm build:dreamland
RUN pnpm rewriter:build
RUN pnpm build && pnpm build


# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:24

# git needed at runtime: devserver.ts calls git rev-parse for its banner
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app
COPY --from=builder /app .

EXPOSE 10000
CMD ["sh", "-c", "CHROME_PORT=${PORT:-10000} pnpm dev"]
