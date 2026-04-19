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

## Launching with URL parameters

The loader accepts a small set of query-string parameters so other sites, bookmarks, terminal easter eggs, or a Discord link can drop straight into a specific IWAD + map + settings without touching the picker. When an `iwad=` param is present and resolves, the picker is skipped and the engine auto-launches.

### Parameters

| Param        | Example                 | Meaning                                                                                  |
|--------------|-------------------------|------------------------------------------------------------------------------------------|
| `iwad`       | `iwad=freedoom1.wad`    | IWAD filename. Must be bundled, side-loaded (see below), or previously uploaded via UI.  |
| `file`       | `file=brutal.pk3,hud.pk3` | Comma-separated mod list (max 10). Each must already be in IDBFS from a prior upload.  |
| `warp`       | `warp=1,1` / `warp=5`   | `-warp E,M` for Doom, `-warp MAP` for Doom II.                                           |
| `skill`      | `skill=4`               | `-skill 1..5` (ITYTD..Nightmare).                                                        |
| `map`        | `map=E2M4`              | `+map <name>` — alternative to `warp` for named maps.                                    |
| `nomonsters` | `nomonsters=1`          | `-nomonsters`.                                                                           |
| `fast`       | `fast=1`                | `-fast`.                                                                                 |
| `respawn`    | `respawn=1`             | `-respawn`.                                                                              |
| `cheat`      | `cheat=god,iddqd`       | Whitelisted argless cheats auto-issued at launch (see list below).                       |

### Examples

```
# Freedoom Phase 1, E1M1, skill 4
https://your-host/?iwad=freedoom1.wad&warp=1,1&skill=4

# Doom II MAP05, fast monsters, god mode
https://your-host/?iwad=doom2.wad&warp=5&fast=1&cheat=god

# Load a previously uploaded mod on top of a bundled IWAD
https://your-host/?iwad=freedoom2.wad&file=mymod.pk3
```

### Security model (whitelist, not sanitization)

User URL strings are **never** concatenated into argv. Every param is validated against a strict regex and dropped silently on mismatch:

- Filenames: `/^[a-z0-9_.-]+\.(wad|pk3|pk7|zip|deh|bex)$/i` — no paths, no spaces, no quoting.
- `warp`: `/^\d{1,2}(?:,\d{1,2})?$/` — one or two small decimals.
- `skill`: `/^[1-5]$/`.
- `map`: `/^[A-Za-z0-9_]{2,8}$/`.
- `cheat`: only the allowlisted commands below, comma-separated.

**Allowed cheats** (argless only — anything taking free-form arguments like `summon`, `give`, `changemap` is intentionally excluded):

```
god  iddqd  buddha  noclip  idclip  notarget
fly  idfa   idkfa   resurrect  kill
```

Adding parameters means editing the regex table + whitelist in `web/uzdoom-loader.js` (search for `parseLauncherArgs`) — by design, nothing reads generic query strings.

### Side-loaded IWADs (runtime volume mounts)

Some IWADs can't live in the public repo or Docker image for licensing reasons but are fine to serve from a private path on your own host. The loader has a lookup table (`SIDELOADED_IWADS` in `web/uzdoom-loader.js`) mapping filenames to server-relative paths. If a URL references one of these IWADs and it isn't already in IDBFS, the loader fetches it from the mapped path, writes it to `/wads/<name>`, and persists it for future loads.

The shipped Caddyfile mounts `/srv/private/` with `X-Robots-Tag: noindex, nofollow` and a long immutable cache. The typical deployment is:

```bash
docker run --rm -p 8080:80 \
  -v /your/private/wads:/srv/private:ro \
  ghcr.io/<you>/uzdoom-wasm:latest
```

Any `.wad` you place in `/your/private/wads/` and register in the `SIDELOADED_IWADS` table becomes launchable via `?iwad=<name>` from anywhere.

### Embedding in an iframe

The loader detects when it's running inside an iframe (`window.self !== window.top`) and:

- Appends `+vid_fullscreen 0 +i_pauseinbackground 0` to argv. Without these, the engine would grab fullscreen on first user input and halt rendering whenever the iframe loses focus — both broken for embedded use.
- Posts `{ type: 'uzdoom:launched' }` to the parent window the moment `callMain` returns control. Parent pages can use this as a timing signal for fade-ins, transition animations, overlay reveals, etc. A timer-based fallback is still a good idea — the message won't arrive on older builds or if the engine fails to initialize.

Parent-page example:

```js
const iframe = document.createElement('iframe');
iframe.src = 'https://your-host/?iwad=doom.wad&warp=1,1';
iframe.allow = 'cross-origin-isolated; fullscreen; gamepad; autoplay';
document.body.appendChild(iframe);

window.addEventListener('message', (e) => {
  if (e.source === iframe.contentWindow && e.data?.type === 'uzdoom:launched') {
    // engine is running — play your reveal animation
  }
});
```

For COOP/COEP to hold across the frame boundary, the parent page must also set `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, and the iframe needs `allow="cross-origin-isolated; …"`. Without that, `crossOriginIsolated` will be `false` inside the iframe and pthreads won't spin up.

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
