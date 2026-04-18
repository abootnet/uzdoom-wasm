# uzdoom-wasm

WebAssembly port of [UZDoom](https://github.com/UZDoom/UZDoom). Play GZDoom-family Doom-engine games directly in any modern browser — WebGL2 renderer, OpenAL audio, pthreads, saves persisted to IndexedDB. Ships with Freedoom; bring your own IWAD or PK3 mods via drag-and-drop. No install, nothing leaves your browser.

> **Status:** early port, vanilla Freedoom is fully playable. Brutal Doom and other heavy ZScript mods are the next target.

## Features

- **GLES2 / WebGL2 renderer** — the full UZDoom OpenGL ES backend, unmodified.
- **OpenAL + ZMusic** — 3D sound, MIDI, OGG music; 44.1 kHz mix.
- **Pthreads** — renderer worker threads via Web Workers + `SharedArrayBuffer`.
- **IndexedDB persistence** — save games, config, and uploaded WADs survive across sessions.
- **Drag-and-drop UI** — pick an IWAD + PK3 mods right on the page.
- **Clean shutdown** — Quit from the menu flushes saves, shows an exit panel, offers Relaunch.

## Quick start (play)

If you just want to play, visit the hosted build at **[todo: your URL here]**. Upload your IWAD (or click *Use bundled Freedoom*), drop any PK3 mods, hit Launch.

## Building from source

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (`emsdk` — tested with 3.1.x and later)
- CMake 3.20+
- Ninja (`pip install ninja` or system package)
- Python 3 (for the local dev server)
- Git Bash or WSL on Windows; any POSIX shell on Linux/macOS

### One-shot build

```bash
# Clone
git clone https://github.com/<you>/uzdoom-wasm.git
cd uzdoom-wasm

# Install Emscripten (one-time; installs into ./emsdk/ by default)
git clone https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install latest && ./emsdk activate latest)

# Build
./build-wasm.sh                       # Release build
BUILD_TYPE=Debug ./build-wasm.sh      # Debug build
INITIAL_MEM=512 ./build-wasm.sh       # Override initial linear-memory MB
EMSDK=/path/to/emsdk ./build-wasm.sh  # Point at an emsdk elsewhere

# Serve (sets COOP/COEP headers required for SharedArrayBuffer)
python web/serve.py
# Open http://localhost:8080/uzdoom.html
```

Output artifacts land in `build-wasm/`:

| File                | Purpose                                  |
|---------------------|------------------------------------------|
| `uzdoom.html`       | Page shell                               |
| `uzdoom.js`         | Emscripten runtime + glue                |
| `uzdoom.wasm`       | Compiled engine                          |
| `uzdoom.data`       | Bundled Freedoom + built-in assets       |
| `uzdoom-loader.js`  | UI loader (WAD upload, progress, etc.)   |

### Hosting

Any static host with Cross-Origin-Opener / Cross-Origin-Embedder headers. A Caddyfile and Dockerfile will be added as the public-deployment work lands.

Required response headers on the `.html` / `.js` / `.wasm`:

```
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these, `crossOriginIsolated === false` and pthreads will refuse to spin up.

## Architecture

```
  Browser page  ──┐
                  │    Canvas + drag-drop UI + IDBFS writes
                  ▼
  uzdoom.js / .wasm (Emscripten output)
     • emscripten_set_main_loop_arg()       ← restructured D_DoomLoop
     • SDL2 → canvas + WebGL2 + input
     • OpenAL → WebAudio
     • pthreads → Web Workers + SharedArrayBuffer
     • MEMFS (bundled Freedoom) + IDBFS (user WADs, saves, config)
                  │
                  ▼
  UZDoom core
     • GLES2 rendering backend only (WebGL2 context)
     • Vulkan + desktop-GL 3.3 backends compiled out
     • HAVE_VM_JIT off (asmjit is x86_64-only, gated upstream)
```

## What's different from upstream UZDoom

Only two real categories of change:

1. **`#ifdef __EMSCRIPTEN__` branches** in a handful of platform files to restructure the main loop into a per-frame tick, force a GL ES context, and swap `fts_open`/NUMA calls for portable equivalents.
2. **A thin platform layer** under `src/common/platform/emscripten/` mounting IDBFS, wiring pointer lock and canvas resize, and exposing a `uzdoom_sync_saves()` hook for the JS side.

A minimal ZMusic stub lives under `libraries/zmusic-stub/` because the upstream ZMusic dependency chain pulls in things (fluidsynth, dumb, gme) that don't play well with WASM. The stub covers OGG music + MIDI via the bundled OPL/Timidity backends.

Everything else — renderer, filesystem, playsim, ZScript VM — is upstream UZDoom code.

## Credits & license

- **License:** GPLv3 (inherited from UZDoom). See [`LICENSE`](LICENSE).
- **Attribution:** see [`CREDITS.md`](CREDITS.md) for the full chain from id Software through ZDoom, GZDoom, UZDoom, and the WASM port.
- **Upstream UZDoom README:** preserved at [`docs/README-upstream.md`](docs/README-upstream.md).

## Contributing

Bug reports, patches, and port-specific improvements welcome. If you're fixing something in the core engine (renderer, playsim, etc.), please also send it upstream to [UZDoom](https://github.com/UZDoom/UZDoom) where it belongs — this repo only exists for the WASM-specific glue.
