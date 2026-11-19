#version 450
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// Fullscreen triangle; no vertex buffers.
void main() {
    vec2 p = vec2(float((gl_VertexIndex << 1) & 2), float(gl_VertexIndex & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
