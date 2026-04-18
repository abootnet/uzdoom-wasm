#!/usr/bin/env bash
# UZDoom -> WebAssembly build entry point.
#
# The repo root IS the UZDoom source tree. Run this script from the repo root.
#
# Emscripten SDK is located via (in order):
#   1. $EMSDK env var              — honored if set and valid
#   2. ./emsdk/                    — sibling of this script
#   3. ../emsdk/                   — one level up
#
# Produces:
#   build-wasm/uzdoom.{html,js,wasm,data,-loader.js}

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT"
BUILD="$ROOT/build-wasm"

BUILD_TYPE="${BUILD_TYPE:-Release}"
INITIAL_MEM="${INITIAL_MEM:-256}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

# --- Emscripten SDK location ----------------------------------------------
if [[ -n "${EMSDK:-}" && -d "$EMSDK" ]]; then
  :   # caller-provided EMSDK wins
elif [[ -d "$ROOT/emsdk" ]]; then
  EMSDK="$ROOT/emsdk"
elif [[ -d "$ROOT/../emsdk" ]]; then
  EMSDK="$(cd "$ROOT/../emsdk" && pwd)"
else
  echo "ERROR: emsdk not found." >&2
  echo "  Set the EMSDK env var, or place emsdk/ next to this script." >&2
  echo "  Install: git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest" >&2
  exit 1
fi

EMSCRIPTEN_ROOT="$EMSDK/upstream/emscripten"
EMSC_TOOLCHAIN="$EMSCRIPTEN_ROOT/cmake/Modules/Platform/Emscripten.cmake"
if [[ ! -f "$EMSC_TOOLCHAIN" ]]; then
  echo "ERROR: Emscripten toolchain file not found at $EMSC_TOOLCHAIN" >&2
  exit 1
fi

# Skip `emcmake`/`emmake` wrappers and drive CMake directly with the
# toolchain file + explicit emcc paths. On Windows (Git Bash / MSYS) the
# executables are .bat; on Linux / macOS they're extensionless.
case "${OS:-}${OSTYPE:-}" in
  Windows_NT*|*msys*|*cygwin*) EMCC_EXT=".bat" ;;
  *)                           EMCC_EXT=""     ;;
esac

export EMSDK

# Every probe gets a `|| true` because bare `ls -d /path/*/glob` returns
# exit 2 when the glob doesn't match, which under `set -euo pipefail`
# kills the whole script. Explicit `if` blocks (not `[[ X ]] && FOO`)
# because that pattern is unsafe with set -e.

if [[ -z "${EMSDK_NODE:-}" ]]; then
  EMSDK_NODE="$(ls -d "$EMSDK"/node/*/bin/node${EMCC_EXT:+.exe} 2>/dev/null | head -1 || true)"
  if [[ -z "$EMSDK_NODE" ]]; then
    EMSDK_NODE="$(ls -d "$EMSDK"/node/*/bin/node 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$EMSDK_NODE" ]]; then
    EMSDK_NODE="$(command -v node 2>/dev/null || true)"
  fi
fi

if [[ -z "${EMSDK_PYTHON:-}" ]]; then
  EMSDK_PYTHON="$(ls -d "$EMSDK"/python/*/python${EMCC_EXT:+.exe} 2>/dev/null | head -1 || true)"
  if [[ -z "$EMSDK_PYTHON" ]]; then
    EMSDK_PYTHON="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
  fi
fi

export EMSDK_NODE EMSDK_PYTHON
export PATH="$EMSCRIPTEN_ROOT:$PATH"

# --- Ninja locator ---------------------------------------------------------
# Honor $NINJA if the caller set it; otherwise probe PATH, then the
# pip-installed `ninja` package as a last resort.
if [[ -n "${NINJA:-}" && -x "$NINJA" ]]; then
  :
else
  NINJA=""
  for cand in ninja ninja.exe; do
    resolved="$(command -v "$cand" 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then NINJA="$resolved"; break; fi
  done
  if [[ -z "$NINJA" ]]; then
    # pip-installed ninja module — Windows-friendly fallback
    NINJA="$(python -c 'import ninja, os, sys; sys.stdout.write(os.path.join(ninja.BIN_DIR, "ninja.exe" if os.name == "nt" else "ninja"))' 2>/dev/null || true)"
  fi
fi
if [[ -z "$NINJA" || ! -x "$NINJA" ]]; then
  echo "ERROR: ninja not found. Install with: pip install ninja  (or your system package manager)" >&2
  exit 1
fi

EMCC_EXE="$EMSCRIPTEN_ROOT/emcc$EMCC_EXT"
EMXX_EXE="$EMSCRIPTEN_ROOT/em++$EMCC_EXT"
EMAR_EXE="$EMSCRIPTEN_ROOT/emar$EMCC_EXT"
EMRANLIB_EXE="$EMSCRIPTEN_ROOT/emranlib$EMCC_EXT"

echo "== Toolchain =="
echo "  emcc    : $EMCC_EXE"
echo "  ninja   : $NINJA"
echo "  cmake   : $(command -v cmake || echo 'cmake NOT in PATH')"
echo

mkdir -p "$BUILD"
cd "$BUILD"

echo "== Configuring (CMake, Ninja generator) =="
cmake "$SRC" \
  -G Ninja \
  -DCMAKE_MAKE_PROGRAM="$NINJA" \
  -DCMAKE_TOOLCHAIN_FILE="$EMSC_TOOLCHAIN" \
  -DCMAKE_C_COMPILER="$EMCC_EXE" \
  -DCMAKE_CXX_COMPILER="$EMXX_EXE" \
  -DCMAKE_AR="$EMAR_EXE" \
  -DCMAKE_RANLIB="$EMRANLIB_EXE" \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DUZDOOM_WASM_INITIAL_MEMORY_MB="$INITIAL_MEM" \
  -DCMAKE_CROSSCOMPILING=TRUE \
  -DIMPORT_EXECUTABLES="$ROOT/tools-native/ImportExecutables.cmake" \
  -DHAVE_VULKAN=OFF \
  -DHAVE_GLES2=ON \
  -DNO_GTK=ON \
  -DNO_SDL_JOYSTICK=ON \
  -DFORCE_INTERNAL_BZIP2=ON

echo
echo "== Building =="
cmake --build . -j"$JOBS"

echo
echo "== Done =="
echo "Output: $BUILD/uzdoom.html (+ .js / .wasm / .data)"
echo "Run:    python $SRC/web/serve.py   # then open http://localhost:8080/uzdoom.html"
