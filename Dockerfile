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

# Normalize line endings and ensure the build script is executable. Files
# coming from a Windows host can lose the +x bit through COPY, and editors
# may reintroduce CRLF on save — strip \r and chmod explicitly.
RUN sed -i 's/\r$//' build-wasm.sh \
 && chmod +x build-wasm.sh

# --- Native host tools (lemon, re2c) ---------------------------------------
# UZDoom invokes `lemon` (parser generator) and `re2c` (lexer generator) at
# build time to turn .lemon / .re source into C/C++. They must run on the
# BUILD host (Linux, inside this container) — not the TARGET (WASM). The
# repo ships pre-built Windows .exe binaries in tools-native/ for local
# Windows dev, but those can't execute in a Linux container. Build fresh
# Linux ELF binaries from the in-tree source before we cross-compile.
RUN cmake -S /src/tools/lemon -B /native-build/lemon \
          -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /native-build/lemon \
 && cmake -S /src/tools/re2c  -B /native-build/re2c  \
          -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /native-build/re2c \
 && /native-build/lemon/lemon -? >/dev/null 2>&1 || true \
 && /native-build/re2c/re2c --version

# Overwrite ImportExecutables.cmake to point at the Linux binaries we just
# built. Without this, the cross-compile step would try to exec the Windows
# .exe files that ship in tools-native/ for local Windows dev, and fail
# with "not found" inside the Linux container.
RUN printf '%s\n' \
  'if(NOT TARGET re2c)' \
  '    add_executable(re2c IMPORTED)' \
  '    set_target_properties(re2c PROPERTIES IMPORTED_LOCATION "/native-build/re2c/re2c")' \
  'endif()' \
  'if(NOT TARGET lemon)' \
  '    add_executable(lemon IMPORTED)' \
  '    set_target_properties(lemon PROPERTIES IMPORTED_LOCATION "/native-build/lemon/lemon")' \
  'endif()' \
  > /src/tools-native/ImportExecutables.cmake

# The emscripten/emsdk base image sets EMSDK=/emsdk, puts emcc on PATH,
# and pre-populates EMSDK_NODE / EMSDK_PYTHON. Our build-wasm.sh picks
# those up via its OS-detection path.
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
