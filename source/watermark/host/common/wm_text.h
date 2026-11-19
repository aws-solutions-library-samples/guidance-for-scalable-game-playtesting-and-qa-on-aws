// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// wm_text.h - visible-mode text layout, shared by the Vulkan layer (Proton) and
// the DXGI proxy (Windows) so the two cannot draw different marks.
//
// Neither backend can tilt a rectangle, so large slanted text is drawn as many
// small axis-aligned squares: one per set pixel of an 8x8 glyph, with the
// square's POSITION rotated. No shader, no graphics pipeline - just a clear with
// a rectangle list, which both vkCmdClearAttachments and
// ID3D12GraphicsCommandList::ClearRenderTargetView take.
//
// Header-only and free of platform types: each backend converts WmRect into its
// own rectangle struct.
#ifndef WM_TEXT_H
#define WM_TEXT_H

#include <math.h>
#include "font8x8_basic.h"

struct WmRect { int x0, y0, x1, y1; };

enum {
    WM_TEXT_MAX_CHARS = 40,   // longer strings are truncated
    // Worst case is every pixel of every glyph set: 40 * 8 * 8.
    WM_TEXT_MAX_RECTS = WM_TEXT_MAX_CHARS * 64,
};

/** Lay `text` out across a W x H frame and write the glyph squares to `out`.
 *  Returns how many were written, never more than `maxOut`.
 *
 *  The string is auto-sized to span 85% of the frame diagonal, so any length of
 *  session ID fills the frame similarly, with a 4-pixel floor on the cell size
 *  so a long string stays legible. Squares falling outside the frame are
 *  clipped away, which is why the result can be shorter than 64 per character. */
static inline int wmBuildTextRects(const char* text, int len,
                                   unsigned W, unsigned H,
                                   WmRect* out, int maxOut) {
    if (!text || len <= 0 || !out || maxOut <= 0 || !W || !H) return 0;
    if (len > WM_TEXT_MAX_CHARS) len = WM_TEXT_MAX_CHARS;

    const double kPi = 3.14159265358979323846;
    const double diag = sqrt((double)W * W + (double)H * H);
    double cell = (0.85 * diag) / (len * 9.0);
    if (cell < 4.0) cell = 4.0;
    const double advance = 9.0 * cell;
    const double theta = -28.0 * kPi / 180.0;
    const double ct = cos(theta), st = sin(theta);
    const double cx = W / 2.0, cy = H / 2.0;

    int n = 0;
    for (int i = 0; i < len; i++) {
        const unsigned char* g = font8x8_basic[(unsigned char)text[i] & 0x7F];
        for (int r = 0; r < 8; r++) {
            for (int c = 0; c < 8; c++) {
                if (!((g[r] >> c) & 1)) continue;
                double lx = (i - (len - 1) / 2.0) * advance + (c - 3.5) * cell;
                double ly = (r - 3.5) * cell;
                double rx = lx * ct - ly * st, ry = lx * st + ly * ct;
                int x0 = (int)(cx + rx - cell / 2.0), y0 = (int)(cy + ry - cell / 2.0);
                int x1 = x0 + (int)(cell + 0.5), y1 = y0 + (int)(cell + 0.5);
                if (x0 < 0) x0 = 0;
                if (y0 < 0) y0 = 0;
                if (x1 > (int)W) x1 = (int)W;
                if (y1 > (int)H) y1 = (int)H;
                if (x1 <= x0 || y1 <= y0) continue;
                if (n >= maxOut) return n;
                out[n].x0 = x0; out[n].y0 = y0; out[n].x1 = x1; out[n].y1 = y1;
                n++;
            }
        }
    }
    return n;
}

#endif
