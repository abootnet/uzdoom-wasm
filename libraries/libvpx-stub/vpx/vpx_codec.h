// Minimal libvpx stub for the UZDoom WASM build.
// Provides the vpx_codec_* core types/ctx used by movieplayer.cpp.
// Actual video decode paths are never reached at runtime.
#ifndef VPX_STUB_VPX_CODEC_H
#define VPX_STUB_VPX_CODEC_H

#include <stddef.h>
#include <stdint.h>
#include "vpx_image.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int vpx_codec_err_t;
enum {
    VPX_CODEC_OK = 0,
    VPX_CODEC_ERROR = 1,
    VPX_CODEC_MEM_ERROR = 2,
    VPX_CODEC_ABI_MISMATCH = 3,
    VPX_CODEC_INCAPABLE = 4,
    VPX_CODEC_UNSUP_BITSTREAM = 5,
    VPX_CODEC_UNSUP_FEATURE = 6,
    VPX_CODEC_CORRUPT_FRAME = 7,
    VPX_CODEC_INVALID_PARAM = 8,
    VPX_CODEC_LIST_END = 9,
};

typedef struct vpx_codec_iface vpx_codec_iface_t;
typedef const void *vpx_codec_iter_t;
typedef long vpx_codec_flags_t;

typedef struct vpx_codec_ctx {
    const char *name;
    vpx_codec_iface_t *iface;
    vpx_codec_err_t err;
    const char *err_detail;
    vpx_codec_flags_t init_flags;
    void *priv;
} vpx_codec_ctx_t;

#ifdef __cplusplus
} // extern "C"
#endif

#endif
