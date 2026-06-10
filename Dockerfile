FROM rust:latest AS builder
RUN apt-get update && apt-get install -y curl nodejs npm
RUN npm install -g pnpm
RUN cargo install wasm-bindgen-cli wasm-snip
RUN curl -L https://github.com/WebAssembly/binaryen/releases/latest/download/binaryen-version_xxx-x86_64-linux.tar.gz | tar xz --strip-components=1 -C /usr/local
WORKDIR /app
COPY . .
RUN git submodule update --init
RUN pnpm i
RUN pnpm build:dreamland
RUN pnpm rewriter:build
RUN pnpm build && pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app .
RUN npm install -g pnpm
CMD ["pnpm", "dev"]
