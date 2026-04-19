# Credits

This project stands on three decades of open-source work by hundreds of people. The lineage, in rough order of historical contribution:

## Engine lineage

- **Doom** — original engine © 1993 id Software. John Carmack, John Romero, Dave Taylor, et al. Released as open source in 1997 under GPLv2 (later GPLv3).
- **Heretic / Hexen** — © Raven Software, engine code released under GPL.
- **Boom** — TeamTNT (Lee Killough, Rand Phares, et al.), 1998. Foundational source-port work.
- **ZDoom** — Randy Heit (Marisa Heit), 1998+. Introduced hardware rendering, ZScript, ACS, vastly extended modding.
- **GZDoom** — Graf Zahl (Christoph Oelckers), 2005+. OpenGL / Vulkan renderer, modern hardware support, the ZDoom fork everyone builds on today.
- **UZDoom** — the modder-friendly GZDoom fork this project is built on. See the [upstream repo](https://github.com/UZDoom/UZDoom) for its contributor list.

## WebAssembly port (this repo)

- Emscripten main-loop restructuring, GL ES context forcing, IDBFS mount layer, web shell + loader, ZMusic stub.

### Concurrent / related work

- **ololoken** is pursuing a parallel Emscripten port as [UZDoom PR #848](https://github.com/UZDoom/UZDoom/pull/848), targeting upstream engine integration with its own shader and OpenAL patches. A live demo is hosted at <https://turch.in/uzdoom+ashes2063/>. This repo (`uzdoom-wasm`) is an independent effort focused on packaging, Docker-based reproducible builds, and browser-side UX (IWAD upload, persistence, hosting headers); the two efforts were developed in parallel without shared code. Credit to ololoken for arriving at many of the same conclusions independently and for putting the work up publicly for discussion.

## Bundled content

- **Freedoom** — © The Freedoom Project. BSD 3-Clause. <https://freedoom.github.io/>
- **Bundled SoundFont** — whatever UZDoom ships under `soundfont/` retains its original license; see the upstream UZDoom repository for specifics.

## Toolchain

- **Emscripten** — LLVM-based C/C++ → WebAssembly compiler. <https://emscripten.org/>
- **SDL2** — platform abstraction. zlib license.
- **OpenAL Soft** — spatial audio. LGPL.
- **miniz, lzma, bzip2, webp** — vendored compression / image libraries, each under their respective permissive licenses; see `libraries/*/LICENSE` in-tree.

## License

All engine code is distributed under GPLv3 (see [`LICENSE`](LICENSE)). Bundled third-party libraries retain their original licenses, preserved in `libraries/*/` and `docs/licenses/`. Freedoom assets are redistributed under BSD 3-Clause.

If you build on this work, please preserve this attribution chain.
