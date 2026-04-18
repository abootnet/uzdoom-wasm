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
