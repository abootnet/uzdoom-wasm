# Helper — included early from the top-level CMakeLists.txt when EMSCRIPTEN is set.
# Forces the renderer / feature matrix into a web-safe configuration and supplies
# the Emscripten link flags.

# --- Feature matrix ------------------------------------------------------
set(HAVE_VULKAN       OFF CACHE BOOL "" FORCE)
set(HAVE_GLES2        ON  CACHE BOOL "" FORCE)
set(NO_OPENAL         OFF CACHE BOOL "" FORCE)
set(DYN_OPENAL        OFF CACHE BOOL "" FORCE)
set(NO_GTK            ON  CACHE BOOL "" FORCE)
set(DYN_GTK           OFF CACHE BOOL "" FORCE)
set(FORCE_INTERNAL_BZIP2 ON CACHE BOOL "" FORCE)
set(NO_SDL_JOYSTICK   ON  CACHE BOOL "" FORCE)

# Stub out features that can't compile to WASM.
set(UZDOOM_WASM_STUB_LIBVPX  ON CACHE BOOL "Skip libvpx (no movie playback)")
set(UZDOOM_WASM_STUB_ZMUSIC  ON CACHE BOOL "Link a no-op ZMusic so music is silent but link succeeds")
set(UZDOOM_WASM_STUB_DISCORD ON CACHE BOOL "Skip Discord RPC integration")

# --- Common compile flags shared between C/C++/link phases ---------------
# -pthread implies both USE_PTHREADS=1 at compile AND link, needed for
# <thread> headers and <atomic> in the compiler. We set it centrally.
# -fexceptions keeps unwinders + typeinfo alive so UZDoom's CFatalError
# throws actually surface as a readable error instead of abort(undefined).
set(_EMSC_COMMON "-pthread -sUSE_SDL=2 -sUSE_PTHREADS=1 -fexceptions")

# --- Build-type-aware optimization/debug flags ---------------------------
# Release (default): -O3 + LTO, strip runtime checks and DWARF. Expect link
# time to jump ~2–3× because LTO re-optimizes every TU together at link.
# Debug:  keep the traces + asserts that got us through Phase 7.A's MIDI /
# audio diagnostics.
#
# Flags split by phase:
#   _EMSC_OPT_COMPILE goes into CMAKE_{C,CXX}_FLAGS (per-TU compile).
#   _EMSC_OPT_LINK    goes into the final emcc link command (ENVIRONMENT,
#                     ASSERTIONS, STACK_OVERFLOW_CHECK are Emscripten
#                     link-only settings — emitting them at compile time
#                     produces "unused linker flag" noise).
# Both phases need -O{N} and -flto; only one side needs -DNDEBUG or the
# -sASSERTIONS family.
if(CMAKE_BUILD_TYPE STREQUAL "Debug" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
  set(_EMSC_OPT_COMPILE "-O0 -g")
  set(_EMSC_OPT_LINK    "-O0 -g -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1")
  message(STATUS "[UZDoom WASM] Debug flags: -O0 -g (+ASSERTIONS=1 STACK_OVERFLOW_CHECK=1 on link)")
else()
  # -O3: aggressive scalar + loop optimization. UZDoom / ZDoom-family
  #   already tests clean at -O3 on native builds.
  # -flto: whole-program optimization. Biggest WASM win — lets the linker
  #   inline across TUs and dead-strip cross-module. Binaryen's wasm-opt
  #   runs on top for additional wasm-side optimization.
  # -DNDEBUG: drops assert() macros; compile-time only.
  set(_EMSC_OPT_COMPILE "-O3 -flto -DNDEBUG")
  set(_EMSC_OPT_LINK    "-O3 -flto")
  message(STATUS "[UZDoom WASM] Release flags: -O3 -flto (-DNDEBUG on compile only)")
endif()

set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS}   ${_EMSC_COMMON} ${_EMSC_OPT_COMPILE}")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${_EMSC_COMMON} ${_EMSC_OPT_COMPILE}")

# --- Link flags ----------------------------------------------------------
# INITIAL_MEMORY 256MB is fine for Freedoom; Brutal Doom bumps this at launch
# via the --mem switch on build-wasm.sh.
set(_EMSC_LINK
  "${_EMSC_COMMON}"
  # OpenAL: in Emscripten 3.x+ the port is auto-linked via libopenal (part
  # of the default libs) — no -sUSE_OPENAL flag required. Older versions
  # used -sUSE_OPENAL=1; current toolchains reject that setting as unknown.
  "-sMIN_WEBGL_VERSION=2"
  "-sMAX_WEBGL_VERSION=2"
  "-sFULL_ES3=1"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=${UZDOOM_WASM_INITIAL_MEMORY_MB}MB"
  "-sMAXIMUM_MEMORY=2GB"
  "-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency"
  "-sFORCE_FILESYSTEM=1"
  "-lidbfs.js"
  "-sEXPORTED_RUNTIME_METHODS=['callMain','FS','IDBFS','ccall','cwrap','stringToUTF8','UTF8ToString']"
  "-sEXPORTED_FUNCTIONS=['_main','_malloc','_free']"
  "-sINVOKE_RUN=0"
  "-sEXIT_RUNTIME=1"
  "-sASYNCIFY=0"
  "-sSTACK_SIZE=2MB"
  "-sDEFAULT_PTHREAD_STACK_SIZE=1MB"
  # Main runs on the browser main thread. D_DoomLoop hands off to
  # emscripten_set_main_loop_arg(..., simulate_infinite_loop=1) which
  # unwinds the WASM stack so main() "returns" cleanly — the per-frame
  # tick is then driven by the browser event loop. Pthreads are still
  # used for worker-side things (r_thread, async I/O), but the GL context
  # and SDL2 init both live on the main thread, which avoids the
  # OffscreenCanvas / eglCreateContext mismatch.
  "-sENVIRONMENT=web,worker"
  # Optimization / debug aids come from _EMSC_OPT_LINK, set above based on
  # CMAKE_BUILD_TYPE. Release link: -O3 -flto (LTO needs the flag on BOTH
  # compile and link to actually inline across TUs). Debug link adds
  # -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1 for readable traces. -DNDEBUG
  # intentionally lives in _EMSC_OPT_COMPILE only — it's a preprocessor flag
  # and emcc warns if you pass it at link time.
  "${_EMSC_OPT_LINK}"
)

# Shell file path is handled separately so any spaces in CMAKE_SOURCE_DIR are
# preserved across the Ninja -> cmd -> emcc.bat hand-offs. Use the DOS 8.3
# short path on Windows (no spaces) when available.
set(_SHELL_FILE "${CMAKE_SOURCE_DIR}/web/shell.html")
if(WIN32 OR CMAKE_HOST_WIN32)
  execute_process(
    COMMAND powershell -NoProfile -Command
      "(New-Object -ComObject Scripting.FileSystemObject).GetFile('${_SHELL_FILE}').ShortPath"
    OUTPUT_VARIABLE _SHELL_FILE_SHORT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
  if(_SHELL_FILE_SHORT)
    set(_SHELL_FILE "${_SHELL_FILE_SHORT}")
  endif()
endif()
list(APPEND _EMSC_LINK "--shell-file" "${_SHELL_FILE}")

# Preload Freedoom if the user dropped it into web/assets/
function(_uzdoom_add_preload src dst)
  set(_p "${src}")
  if(WIN32 OR CMAKE_HOST_WIN32)
    execute_process(
      COMMAND powershell -NoProfile -Command
        "(New-Object -ComObject Scripting.FileSystemObject).GetFile('${src}').ShortPath"
      OUTPUT_VARIABLE _short OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
    if(_short)
      set(_p "${_short}")
    endif()
  endif()
  list(APPEND _EMSC_LINK "--preload-file" "${_p}@${dst}")
  set(_EMSC_LINK "${_EMSC_LINK}" PARENT_SCOPE)
endfunction()

if(EXISTS "${CMAKE_SOURCE_DIR}/web/assets/freedoom1.wad")
  _uzdoom_add_preload("${CMAKE_SOURCE_DIR}/web/assets/freedoom1.wad" "/freedoom1.wad")
endif()
if(EXISTS "${CMAKE_SOURCE_DIR}/web/assets/freedoom2.wad")
  _uzdoom_add_preload("${CMAKE_SOURCE_DIR}/web/assets/freedoom2.wad" "/freedoom2.wad")
endif()

string(REPLACE ";" " " _EMSC_LINK_STR "${_EMSC_LINK}")
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ${_EMSC_LINK_STR}")

# The browser output gets the nice .html wrapper via --shell-file.
set(CMAKE_EXECUTABLE_SUFFIX ".html")

add_definitions(
  -D__EMSCRIPTEN__
  -DUZDOOM_WASM
  -DNO_GTK
  -DNO_SDL_JOYSTICK=1   # joysticks would need gamepad API work; add later
)


# --- pthread flag wiring for CMake's FindThreads -----------------------
# Emscripten doesn't expose a real -lpthread; pthreads are enabled via
# -sUSE_PTHREADS / -pthread, which we already set in _EMSC_COMMON.
# Pre-populate CMake's threading plumbing so anything that calls
# find_package(Threads) and links Threads::Threads succeeds.
set(THREADS_PREFER_PTHREAD_FLAG TRUE CACHE BOOL "" FORCE)
set(CMAKE_THREAD_LIBS_INIT "-pthread" CACHE STRING "" FORCE)
set(CMAKE_HAVE_THREADS_LIBRARY TRUE CACHE BOOL "" FORCE)
set(CMAKE_USE_WIN32_THREADS_INIT FALSE CACHE BOOL "" FORCE)
set(CMAKE_USE_PTHREADS_INIT TRUE CACHE BOOL "" FORCE)
set(Threads_FOUND TRUE CACHE BOOL "" FORCE)
if(NOT TARGET Threads::Threads)
    add_library(Threads::Threads INTERFACE IMPORTED)
    set_target_properties(Threads::Threads PROPERTIES
        INTERFACE_COMPILE_OPTIONS "-pthread"
        INTERFACE_LINK_OPTIONS    "-pthread")
endif()

message(STATUS "[UZDoom WASM] Emscripten overrides active — GLES2 only, no Vulkan, pthreads on.")
