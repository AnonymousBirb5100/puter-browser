# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM rust:1 AS builder

# Install Node.js 22, git, and curl
RUN apt-get update && apt-get install -y curl git && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Add the WebAssembly Rust target
RUN rustup target add wasm32-unknown-unknown

# Install Rust WASM tools
RUN cargo install wasm-bindgen-cli wasm-snip

# Install binaryen (provides wasm-opt)
RUN curl -L https://github.com/WebAssembly/binaryen/releases/download/version_128/binaryen-version_128-x86_64-linux.tar.gz \
    | tar xz --strip-components=1 -C /usr/local

WORKDIR /app
COPY . .

# Init submodules (dreamlandjs, playwright)
RUN git submodule update --init

# Build steps from CONTRIBUTING.md
RUN pnpm i
RUN pnpm build:dreamland
RUN pnpm rewriter:build
RUN pnpm build && pnpm build


# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22

# git is needed at runtime: devserver.ts calls git rev-parse for the banner
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app

# Copy everything (source + built output + .git for git commands at runtime)
COPY --from=builder /app .

# devserver.ts uses CHROME_PORT for the main HTTP listener (default 6767).
# Render injects $PORT; set CHROME_PORT to match the port you configure in
# your Render service settings (Settings → Port). Default below is 6767.
# ENV CHROME_PORT=6767
EXPOSE 10000

CMD ["sh", "-c", "CHROME_PORT=${PORT:-10000} pnpm dev"]
