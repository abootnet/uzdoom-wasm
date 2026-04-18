// Minimal libvpx stub for the UZDoom WASM build.
// Provides the vpx_codec_* decoder API used by movieplayer.cpp.
// All functions are no-ops that return an error — video playback
// is disabled in the browser build.
#ifndef VPX_STUB_VPX_DECODER_H
#define VPX_STUB_VPX_DECODER_H

#include "vpx_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct vpx_codec_dec_cfg {
    unsigned int threads;
    unsigned int w;
    unsigned int h;
} vpx_codec_dec_cfg_t;

vpx_codec_err_t vpx_codec_dec_init(vpx_codec_ctx_t *ctx,
                                   vpx_codec_iface_t *iface,
                                   const vpx_codec_dec_cfg_t *cfg,
                                   vpx_codec_flags_t flags);

vpx_codec_err_t vpx_codec_decode(vpx_codec_ctx_t *ctx,
                                 const unsigned char *data,
                                 unsigned int data_sz,
                                 void *user_priv,
                                 long deadline);

vpx_image_t *vpx_codec_get_frame(vpx_codec_ctx_t *ctx,
                                 vpx_codec_iter_t *iter);

vpx_codec_err_t vpx_codec_destroy(vpx_codec_ctx_t *ctx);

// Real libvpx exposes `vpx_codec_control` as a variadic macro that forwards
// to a per-control-id helper. A variadic function is close enough for a stub.
vpx_codec_err_t vpx_codec_control(vpx_codec_ctx_t *ctx, int ctrl_id, ...);

#ifdef __cplusplus
} // extern "C"
#endif

#endif
