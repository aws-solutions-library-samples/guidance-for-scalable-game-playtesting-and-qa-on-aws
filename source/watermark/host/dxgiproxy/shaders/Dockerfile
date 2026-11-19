# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
# Image holding both HLSL compilers the proxy needs. Built once and cached by
# the container CLI, because the vkd3d build takes several minutes under x86-64 emulation.
#
# Two compilers are needed because neither covers both targets:
#   * dxc emits DXIL for D3D12. It REFUSES to emit DXBC - asking for ps_5_0
#     prints "Promoting older shader model profile to 6.0" and gives you byte
#     identical DXIL, which is checked by scripts/build-watermark.js.
#   * vkd3d-compiler emits DXBC for D3D11, which otherwise needs fxc.exe and
#     therefore a Windows host.
FROM ubuntu:24.04

RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        curl xz-utils ca-certificates build-essential flex bison pkg-config \
        libvulkan-dev spirv-headers directx-headers-dev libjson-perl gawk xxd \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Pinned by tag, filename AND hash deliberately: dxc release asset names
# alternate between "x86_x64" and "x86_64" between releases, and at least one
# recent release ships a 515 MB asset, so globbing the assets is a trap.
RUN curl -fsSL -o /tmp/dxc.tar.gz \
        https://github.com/microsoft/DirectXShaderCompiler/releases/download/v1.9.2609/linux_dxc_2026_09_28.x86_x64.tar.gz \
    && echo "96faadc7f5c282d2ffda49804beb4c3ee38127bc252b723234e3c5cdf7aa39a1  /tmp/dxc.tar.gz" | sha256sum -c - \
    && mkdir -p /dxc && tar xzf /tmp/dxc.tar.gz -C /dxc && rm /tmp/dxc.tar.gz

# Ubuntu's own vkd3d package is 1.2 and has no HLSL compiler at all, so this is
# built from source. CFLAGS/LDFLAGS disable LTO: with it, gcc 13 and make's
# jobserver hit an internal compiler error in return_token.
RUN curl -fsSL -o /tmp/vkd3d.tar.xz https://dl.winehq.org/vkd3d/source/vkd3d-2.1.tar.xz \
    && echo "7510146aff2adfb4ae07ab890701a607e5ff7c66e57100cfc9f630ec92eeda6a  /tmp/vkd3d.tar.xz" | sha256sum -c - \
    && tar xJf /tmp/vkd3d.tar.xz -C /tmp \
    && cd /tmp/vkd3d-2.1 \
    && ./configure --prefix=/usr/local --disable-doxygen-doc \
                   CFLAGS="-O2 -fno-lto" LDFLAGS="-fno-lto" >/dev/null \
    && make -j"$(nproc)" >/dev/null \
    && make install >/dev/null \
    && ldconfig \
    && rm -rf /tmp/vkd3d-2.1 /tmp/vkd3d.tar.xz

ENV LD_LIBRARY_PATH=/dxc/lib
ENV PATH=/dxc/bin:$PATH
