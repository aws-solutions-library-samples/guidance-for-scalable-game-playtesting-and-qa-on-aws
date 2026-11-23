# Forensic watermarking: third-party and adapted code

The forensic watermarking feature in this solution is based on the
**Amazon GameLift Streams forensic watermarking sample**, used and adapted with the
author's permission. That work is licensed MIT-0, the same as this solution.

| Location in this solution | Origin | Changes |
|---|---|---|
| `watermark/host/layer/` | Vulkan layer (Proton runtime) | Licence headers; comments point at this solution's files |
| `watermark/host/dxgiproxy/` | Proxy `dxgi.dll` (Windows runtime) and its HLSL shaders | Licence headers; comments point at this solution's files |
| `watermark/host/common/wm_text.h` | Shared glyph layout | Licence header |
| `watermark/host/package/` | Vulkan implicit-layer manifest | None |
| `lambdas/PlayTestVerifyWatermark/handler.py` | Verifier and scale-search worker | Reads the image from S3, optional per-session candidate filter, this solution's seed record fields. The pattern, fold, correlation and scale search are unchanged |
| `lambdas/PlayTestStartStream/streamWatermark.js` | Seed minting and session variables, from the sample's console API | Ported into this solution's stream start |
| `frontend/src/utils/watermarkImage.ts` | Screenshot preparation, from the sample's console | Ported to TypeScript |
| `scripts/build-watermark.js` | Container build steps from the sample's build scripts | Rewritten in Node.js so it runs on Windows, macOS and Linux; Docker or Finch |

`watermark/host/common/font8x8_basic.h` is a public-domain 8x8 bitmap font by Daniel
Hepper, vendored unchanged with its own attribution header.

The HLSL compiler image (`watermark/host/dxgiproxy/shaders/Dockerfile`) downloads the
DirectX Shader Compiler and vkd3d at build time, each pinned by version and SHA-256.
Nothing is vendored from them.

**No compiled binaries are included.** Build the host components yourself with
`npm run build-watermark`. A prebuilt library that loads into a game process isn't
something anyone should run without building it from source.

The host components are a proof of concept and are provided without support. See
"Enabling Forensic Watermarking" in the main README for what they do to a game process,
and for anti-cheat and publisher-permission considerations.
