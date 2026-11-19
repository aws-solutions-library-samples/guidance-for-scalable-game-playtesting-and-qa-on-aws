// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// Fullscreen triangle, the HLSL port of layer/shaders/wm.vert. No vertex
// buffers: the position comes from the vertex index alone.
//
// Note for whoever wires this into a pipeline: the triangle this produces is
// counter-clockwise in screen space, which D3D treats as BACK facing under its
// default cull mode. The pipeline must set CULL_NONE (or flip the winding) or
// the pass draws nothing at all - silently, with no error anywhere.

struct VSOut { float4 pos : SV_Position; };

VSOut main(uint vid : SV_VertexID)
{
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    VSOut o;
    o.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    return o;
}
