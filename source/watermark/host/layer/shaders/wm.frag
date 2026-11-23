#version 450
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// Forensic spread-spectrum embed via ONE-SIDED ADDITIVE BLEND. The pipeline uses
// additive blending (dst + src), so this shader just outputs the delta to add; it
// never reads the swapchain (no input attachment / storage -> no extra swapchain
// usage flags, which GameLift Streams' surface doesn't support). We add +alpha to
// luma where the pattern bit is set, 0 elsewhere; the extractor removes per-tile
// DC, so the one-sided mark correlates with the +/-1 pattern at half amplitude.
// Hash MUST match pattern_for_seed() in source/lambdas/PlayTestVerifyWatermark/handler.py (checked by source/test/watermark-pattern.test.mjs).
layout(push_constant) uniform PC {
    uint  seedLo;
    uint  seedHi;
    uint  tile;
    float alpha;   // luma amplitude in 0..255 units
} pc;
layout(location = 0) out vec4 outColor;

uint wmhash(uint x, uint y) {
    uint h = pc.seedLo ^ (x * 0x9E3779B1u) ^ (y * 0x85EBCA77u) ^ (pc.seedHi * 0x27D4EB2Fu);
    h ^= h >> 15; h *= 0x2C1B3C6Du;
    h ^= h >> 12; h *= 0x297A2D39u;
    h ^= h >> 15;
    return h;
}

void main() {
    uint x = uint(gl_FragCoord.x) % pc.tile;
    uint y = uint(gl_FragCoord.y) % pc.tile;
    float bit = ((wmhash(x, y) & 1u) == 0u) ? 1.0 : 0.0;  // pattern +1 cells
    float d = (pc.alpha * bit) / 255.0;
    outColor = vec4(d, d, d, 0.0);   // additive blend adds to rgb; alpha preserved
}
