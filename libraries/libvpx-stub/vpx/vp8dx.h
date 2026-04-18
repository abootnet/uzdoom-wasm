// Minimal libvpx stub for the UZDoom WASM build.
// Provides VP8/VP9 decoder interface symbols referenced by movieplayer.cpp.
#ifndef VPX_STUB_VP8DX_H
#define VPX_STUB_VP8DX_H

#include "vpx_decoder.h"

#ifdef __cplusplus
extern "C" {
#endif

extern vpx_codec_iface_t vpx_codec_vp8_dx_algo;
extern vpx_codec_iface_t vpx_codec_vp9_dx_algo;

enum vp8_dec_control_id {
    VP8D_GET_LAST_REF_UPDATES = 1,
    VP8D_GET_FRAME_CORRUPTED = 2,
    VP8D_GET_LAST_REF_USED = 3,
};

#ifdef __cplusplus
} // extern "C"
#endif

#endif
