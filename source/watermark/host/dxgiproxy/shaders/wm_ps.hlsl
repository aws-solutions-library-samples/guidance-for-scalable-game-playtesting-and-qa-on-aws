// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// Forensic spread-spectrum embed, the HLSL port of layer/shaders/wm.frag.
//
// The pipeline uses additive blending (dst + src), so this shader only outputs
// the delta to add; it never reads the back buffer, which keeps it free of any
// extra swapchain usage flags. +alpha is added to luma where the pattern bit is
// set and 0 elsewhere; the extractor removes per-tile DC, so the one-sided mark
// still correlates with the +/-1 pattern at half amplitude.
//
// The hash MUST match pattern_for_seed() in source/lambdas/PlayTestVerifyWatermark/handler.py (checked by source/test/watermark-pattern.test.mjs) and the
// GLSL in layer/shaders/wm.frag, or a Windows capture will not verify against
// seeds issued for Proton sessions. It is plain 32-bit unsigned integer
// arithmetic, which wraps identically in GLSL and HLSL.
//
// Two deliberate choices make this compile the same way under both HLSL
// compilers we build with (dxc for DXIL, vkd3d-shader for DXBC):
//
//   * `h = h ^ (...)` rather than `h ^= ...`, because Wine's older bundled
//     vkd3d-shader rejects compound bitwise assignment. Behaviour is identical.
//   * SV_Position is declared `noperspective`. fxc always emits that for a
//     pixel shader position input, whereas vkd3d-shader defaults to plain
//     linear unless asked; saying it explicitly makes the two agree.

cbuffer PC : register(b0)
{
    uint  seedLo;
    uint  seedHi;
    uint  tile;
    float alpha;   // luma amplitude in 0..255 units
};

uint wmhash(uint x, uint y)
{
    uint h = seedLo ^ (x * 0x9E3779B1u) ^ (y * 0x85EBCA77u) ^ (seedHi * 0x27D4EB2Fu);
    h = h ^ (h >> 15);
    h = h * 0x2C1B3C6Du;
    h = h ^ (h >> 12);
    h = h * 0x297A2D39u;
    h = h ^ (h >> 15);
    return h;
}

float4 main(noperspective float4 fragCoord : SV_Position) : SV_Target
{
    uint x = uint(fragCoord.x) % tile;
    uint y = uint(fragCoord.y) % tile;
    float bit = ((wmhash(x, y) & 1u) == 0u) ? 1.0 : 0.0;   // pattern +1 cells
    float d = (alpha * bit) / 255.0;
    return float4(d, d, d, 0.0);   // additive blend adds to rgb; alpha preserved
}
