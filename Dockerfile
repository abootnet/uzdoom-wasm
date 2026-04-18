# syntax=docker/dockerfile:1.6
#
# uzdoom-wasm — multi-stage Docker build.
#
#   Stage 1 (builder):  emscripten/emsdk + cmake/ninja → build-wasm/ artifacts
#   Stage 2 (runtime):  caddy:alpine serving /srv with COOP/COEP headers
#
# Build:   docker build -t uzdoom-wasm .
# Run:     docker run --rm -p 8080:80 uzdoom-wasm
# Browse:  http://localhost:8080

# --- Build stage -----------------------------------------------------------
FROM emscripten/emsdk:3.1.70 AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake ninja-build zip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . /src

# The emscripten/emsdk base image sets EMSDK=/emsdk, puts emcc on PATH,
# and pre-populates EMSDK_NODE / EMSDK_PYTHON. Our build-wasm.sh honours
# all of those via its OS-detection path.
RUN BUILD_TYPE=Release EMSDK=/emsdk ./build-wasm.sh

# --- Runtime stage ---------------------------------------------------------
FROM caddy:2-alpine

# Rename the HTML entry point to index.html so "/" serves the game directly.
# All internal script references (uzdoom.js, uzdoom-loader.js) are relative,
# so the rename is safe.
COPY --from=builder /src/build-wasm/uzdoom.html        /srv/index.html
COPY --from=builder /src/build-wasm/uzdoom.js          /srv/uzdoom.js
COPY --from=builder /src/build-wasm/uzdoom.wasm        /srv/uzdoom.wasm
COPY --from=builder /src/build-wasm/uzdoom.data        /srv/uzdoom.data
COPY --from=builder /src/build-wasm/uzdoom.pk3         /srv/uzdoom.pk3
COPY --from=builder /src/build-wasm/uzdoom-loader.js   /srv/uzdoom-loader.js

COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 80
# caddy:alpine already has CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
