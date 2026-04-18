// Minimal libvpx stub for the UZDoom WASM build.
// Exposes just the vpx_image_t type and enum constants referenced by
// animtexture.cpp / movieplayer.cpp so they compile. Actual video
// decode paths are never reached — we don't load .ivf / .mve movies
// in the browser build.
#ifndef VPX_STUB_VPX_IMAGE_H
#define VPX_STUB_VPX_IMAGE_H
#include <stdint.h>

typedef enum {
    VPX_IMG_FMT_NONE = 0,
    VPX_IMG_FMT_I420,
    VPX_IMG_FMT_I422,
    VPX_IMG_FMT_I440,
    VPX_IMG_FMT_I444,
} vpx_img_fmt_t;

enum {
    VPX_PLANE_Y = 0,
    VPX_PLANE_U = 1,
    VPX_PLANE_V = 2,
    VPX_PLANE_A = 3,
};

typedef struct vpx_image {
    vpx_img_fmt_t fmt;
    unsigned int w, h;
    unsigned int d_w, d_h;
    unsigned char *planes[4];
    int stride[4];
} vpx_image_t;

#endif
