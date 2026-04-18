/* Translation unit for TinySoundFont + TinyMidiLoader.
 *
 * Both are single-header libraries by Bernhard Schelling (MIT). They contain
 * C99-isms (tagged unions, etc.) that are fine in C but fragile through C++,
 * so we compile them once here as C and expose their extern API to the C++
 * side of the stub via the headers (which have proper extern "C" guards).
 */

/* Silence vendored-library warnings we don't want to chase. */
#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic push
#  pragma GCC diagnostic ignored "-Wunused-function"
#  pragma GCC diagnostic ignored "-Wunused-variable"
#  pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#  pragma GCC diagnostic ignored "-Wunused-value"
#  pragma GCC diagnostic ignored "-Wsign-compare"
#  pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#define TSF_IMPLEMENTATION
#include "tsf/tsf.h"

#define TML_IMPLEMENTATION
#include "tsf/tml.h"

#if defined(__GNUC__) || defined(__clang__)
#  pragma GCC diagnostic pop
#endif
