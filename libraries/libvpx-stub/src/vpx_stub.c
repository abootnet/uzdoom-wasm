// libvpx stub implementations for the UZDoom WASM build.
// All decode entry points fail with VPX_CODEC_ERROR; movieplayer.cpp
// already checks init/decode return values and bails on non-zero.
#include "vpx/vpx_decoder.h"
#include "vpx/vp8dx.h"
#include <stdarg.h>

// Opaque iface storage — address is all movieplayer.cpp needs.
struct vpx_codec_iface { int _unused; };

vpx_codec_iface_t vpx_codec_vp8_dx_algo = { 0 };
vpx_codec_iface_t vpx_codec_vp9_dx_algo = { 0 };

vpx_codec_err_t vpx_codec_dec_init(vpx_codec_ctx_t *ctx,
                                   vpx_codec_iface_t *iface,
                                   const vpx_codec_dec_cfg_t *cfg,
                                   vpx_codec_flags_t flags) {
    (void)iface; (void)cfg; (void)flags;
    if (ctx) {
        ctx->name = "vpx stub";
        ctx->iface = 0;
        ctx->err = VPX_CODEC_ERROR;
        ctx->err_detail = "libvpx disabled in WASM build";
        ctx->priv = 0;
    }
    return VPX_CODEC_ERROR;
}

vpx_codec_err_t vpx_codec_decode(vpx_codec_ctx_t *ctx,
                                 const unsigned char *data,
                                 unsigned int data_sz,
                                 void *user_priv,
                                 long deadline) {
    (void)ctx; (void)data; (void)data_sz; (void)user_priv; (void)deadline;
    return VPX_CODEC_ERROR;
}

vpx_image_t *vpx_codec_get_frame(vpx_codec_ctx_t *ctx, vpx_codec_iter_t *iter) {
    (void)ctx; (void)iter;
    return 0;
}

vpx_codec_err_t vpx_codec_destroy(vpx_codec_ctx_t *ctx) {
    (void)ctx;
    return VPX_CODEC_OK;
}

vpx_codec_err_t vpx_codec_control(vpx_codec_ctx_t *ctx, int ctrl_id, ...) {
    (void)ctx; (void)ctrl_id;
    return VPX_CODEC_ERROR;
}
