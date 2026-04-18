/* Translation unit for stb_vorbis — compiled as C so its C99 patterns
 * (variable-length-ish arrays, C-style tagged structs) stay happy. The
 * header-style API is exposed to zmusic_stub.cpp via extern declarations
 * rather than the original single-header include dance.
 */

/* Silence warnings from the vendored library. */
#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wunused-function"
#  pragma GCC diagnostic ignored "-Wunused-variable"
#  pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#  pragma GCC diagnostic ignored "-Wunused-value"
#  pragma GCC diagnostic ignored "-Wsign-compare"
#endif

#define STB_VORBIS_NO_STDIO      1   /* we only decode from memory */
#define STB_VORBIS_NO_PUSHDATA_API 1 /* pulldata is all we need */

#include "stb/stb_vorbis.c"

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic pop
#endif
