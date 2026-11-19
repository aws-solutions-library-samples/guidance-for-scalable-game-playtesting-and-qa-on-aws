// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// dxgi_proxy.cpp - probe build of the Windows watermark proxy (milestone M0 of
// the upstream sample's Windows support plan).
//
// A drop-in dxgi.dll that sits next to the game executable and forwards every
// export to the system dxgi.dll. With ENABLE_WMPOC=1 it also hooks swapchain
// creation and Present and records what the game renders: graphics API, back
// buffer format and size, present rate, and which present entry point is used.
// It draws nothing. Its job is to prove the proxy loads, forwards correctly and
// reaches Present, before any marking code exists.
//
// Hooking is DXGI vtable patching, the technique ReShade and Special K use: the
// exported CreateDXGIFactory* return a real factory whose (type-wide) vtable we
// patch, and the swapchains it creates get their vtable patched in turn.
// CINTERFACE gives the C-style vtable structs in C++, so the patches name
// members and the ABI offsets come from the headers rather than hand-counted
// slot indices.
//
// No C++ runtime: this DLL loads into someone else's game process, so it
// imports only kernel32 and msvcrt's vsnprintf. All state is POD.

#define CINTERFACE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi1_6.h>
#include <d3d11_1.h>   // ID3D11DeviceContext1::ClearView
#include <d3d12.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>   // atoi
#include "../common/wm_text.h"       // shared with the Proton Vulkan layer
#include "shaders_bytecode.h"        // generated: vs_dxil/ps_dxil, vs_dxbc/ps_dxbc

// The IIDs come straight from the headers, defined in dxguid.a - a static
// library of GUID constants, so it adds no import to the DLL and nothing has to
// be transcribed by hand. They are used directly rather than copied into local
// constants: copying an extern object into a namespace-scope variable needs a
// static constructor, and this DLL is deliberately free of dynamic
// initialisation so that nothing has to run before DllMain.

enum { API_NONE = 0, API_D3D11 = 11, API_D3D12 = 12 };

static bool g_enabled;      // ENABLE_WMPOC=1 and not DISABLE_WMPOC=1
// Two debugging switches. An application's files cannot change after it is
// created, so narrowing down a title that fails WITH the marker would otherwise
// cost a new application and a new stream session per guess. These let one build
// bisect itself from the session's environment variables instead:
//   WMPOC_NODRAW=1    forward, hook and log only - exactly the probe build
//   WMPOC_BUILDONLY=1 also create the D3D12 objects and record the command
//                     lists, but never submit them
static bool g_draw = true;
static bool g_buildOnly;
// WMPOC_CLEARFULL=1 clears the whole render target instead of the glyph
// rectangles. It ruins the picture, so it is only a diagnostic: it separates "the
// render target view is wrong" from "the rectangle list is the problem".
static bool g_clearFull;

/** How the D3D11 forensic pass keeps the pipeline state the game owns intact.
 *  Visible mode needs none of this because ClearView disturbs nothing, but the
 *  forensic pass DRAWS, so something has to put the game's state back.
 *
 *  Three mechanisms can do it and they fail on different devices (see
 *  buildIsolation11), so the proxy tries them in order rather than betting the
 *  feature on one call. WMPOC_ISOLATION=state|deferred|manual pins one instead:
 *  on a host that lets a session confirm a particular route without a rebuild,
 *  and locally it is the only way to make the smoke test exercise the two that
 *  Wine would never otherwise reach.
 */
enum { ISO_AUTO = 0, ISO_STATE, ISO_DEFERRED, ISO_MANUAL };
static int g_isolation;
static const char* isolationName(int iso) {
    switch (iso) {
        case ISO_STATE:    return "device context state";
        case ISO_DEFERRED: return "deferred command list";
        case ISO_MANUAL:   return "manual save/restore";
        default:           return "automatic";
    }
}
// Glyph rectangles per clear call, or 0 to use the per-API default below.
// WMPOC_RECTBATCH overrides it.
static int g_rectBatch;

/** How many rectangles to put in one clear. The two APIs want opposite things,
 *  both measured on a live host:
 *
 *   - D3D12 crashes its driver while RECORDING a single clear with ~300
 *     rectangles, so that path has to split them. Batches are recorded once, so
 *     the extra calls cost nothing at run time.
 *   - D3D11 re-issues its clears every frame, and there each ClearView call
 *     costs about 600us into a single-buffered bitblt swapchain: 11 calls a
 *     frame dropped Overcooked 2 from 60 to ~43/s, while one call with all of
 *     them held a steady 60. It does not mind the long list that D3D12 rejects.
 */
static int rectBatchFor(int api) {
    if (g_rectBatch > 0) return g_rectBatch;
    return api == API_D3D12 ? 32 : WM_TEXT_MAX_RECTS;
}

// dxguid.a does not carry this one, so it is defined here from the value
// d3d11_1.h itself declares for the interface.
static const GUID kIID_ID3D11DeviceContext1 =
    { 0xbb2c6faa, 0xb5fb, 0x4082, { 0x8e, 0x6b, 0x38, 0x8b, 0x8c, 0xfa, 0x90, 0xe1 } };
static const GUID kIID_ID3D11Device1 =
    { 0xa04bfb29, 0x08ef, 0x43d6, { 0xa4, 0x9c, 0xa9, 0xbd, 0xbd, 0xcb, 0xe6, 0x86 } };

// ---------------- logging ----------------
// One line per event, written straight to the file so nothing is lost if the
// game crashes. The steady-state rate is one line every few seconds.

static HANDLE g_log = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_logCs;

static void logLine(const char* fmt, ...) {
    if (g_log == INVALID_HANDLE_VALUE) return;
    char line[1024];
    SYSTEMTIME t;
    GetLocalTime(&t);
    int n = _snprintf(line, sizeof(line) - 2, "%02u:%02u:%02u.%03u wmpoc: ",
                      t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    if (n < 0) return;
    va_list ap;
    va_start(ap, fmt);
    int m = _vsnprintf(line + n, sizeof(line) - 2 - n, fmt, ap);
    va_end(ap);
    n = (m < 0) ? (int)sizeof(line) - 2 : n + m;
    line[n++] = '\r';
    line[n++] = '\n';
    EnterCriticalSection(&g_logCs);
    DWORD written = 0;
    WriteFile(g_log, line, (DWORD)n, &written, nullptr);
    LeaveCriticalSection(&g_logCs);
}

/** Open %WMPOC_LOG%, or <user profile>\wmpoc\dxgi-proxy-<pid>.log. The game runs
 *  as Administrator, so its profile is writable and reachable by the admin shell
 *  and by the application log paths feature. The pid keeps a game that spawns
 *  child processes from interleaving two logs. */
static void openLog() {
    char path[MAX_PATH];
    DWORD n = GetEnvironmentVariableA("WMPOC_LOG", path, sizeof(path));
    if (n == 0 || n >= sizeof(path)) {
        char dir[MAX_PATH];
        n = GetEnvironmentVariableA("USERPROFILE", dir, sizeof(dir));
        if (n == 0 || n + 32 >= sizeof(dir)) return;   // leaves room for the suffix
        _snprintf(path, sizeof(path), "%s\\wmpoc", dir);
        CreateDirectoryA(path, nullptr);
        _snprintf(path, sizeof(path), "%s\\wmpoc\\dxgi-proxy-%lu.log", dir, GetCurrentProcessId());
    }
    g_log = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                        nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

// ---------------- export forwarding ----------------
// Every export of the system dxgi.dll that we do not intercept gets a one
// instruction thunk that jumps through a resolved pointer. Written in assembly
// because several of these are undocumented private exports that d3d11.dll and
// d3d12.dll import by name: a thunk forwards any signature, whereas a typed C
// wrapper would need a correct prototype for each.

extern "C" HRESULT WINAPI wmpoc_unresolved(void) { return E_NOTIMPL; }

#define FORWARDED_EXPORTS \
    X(ApplyCompatResolutionQuirking) \
    X(CompatString) \
    X(CompatValue) \
    X(DXGID3D10CreateDevice) \
    X(DXGID3D10CreateLayeredDevice) \
    X(DXGID3D10ETWRundown) \
    X(DXGID3D10GetLayeredDeviceSize) \
    X(DXGID3D10RegisterLayers) \
    X(DXGIDeclareAdapterRemovalSupport) \
    X(DXGIDisableVBlankVirtualization) \
    X(DXGIDumpJournal) \
    X(DXGIGetDebugInterface1) \
    X(DXGIReportAdapterConfiguration) \
    X(PIXBeginCapture) \
    X(PIXEndCapture) \
    X(PIXGetCaptureState) \
    X(PIXGetThreadInfo) \
    X(SetAppCompatStringPointer) \
    X(UpdateHISTORY) \
    X(UpdateHMDEmulationStatus)

#define X(n) \
    extern "C" { void* g_real_##n = (void*)&wmpoc_unresolved; } \
    asm(".text\n.p2align 4\n.globl " #n "\n" #n ":\n\tjmp *g_real_" #n "(%rip)\n");
FORWARDED_EXPORTS
#undef X

static void* g_realCreateDXGIFactory;
static void* g_realCreateDXGIFactory1;
static void* g_realCreateDXGIFactory2;

static const struct { const char* name; void** slot; } g_forwards[] = {
#define X(n) { #n, &g_real_##n },
    FORWARDED_EXPORTS
#undef X
    { "CreateDXGIFactory",  &g_realCreateDXGIFactory  },
    { "CreateDXGIFactory1", &g_realCreateDXGIFactory1 },
    { "CreateDXGIFactory2", &g_realCreateDXGIFactory2 },
};
static const int g_forwardCount = (int)(sizeof(g_forwards) / sizeof(g_forwards[0]));

/** Walk the real dxgi.dll's export table and report anything this proxy does
 *  not re-export. A name missing here is a load-time failure for whichever
 *  module imports it, so the probe must surface it rather than wait for a crash. */
static void auditExports(HMODULE real) {
    const BYTE* base = (const BYTE*)real;
    auto dos = (const IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    auto nt = (const IMAGE_NT_HEADERS64*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    const IMAGE_DATA_DIRECTORY& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
    if (!dir.VirtualAddress) return;
    auto exp = (const IMAGE_EXPORT_DIRECTORY*)(base + dir.VirtualAddress);
    auto names = (const DWORD*)(base + exp->AddressOfNames);
    for (DWORD i = 0; i < exp->NumberOfNames; i++) {
        const char* name = (const char*)(base + names[i]);
        bool known = false;
        for (int j = 0; j < g_forwardCount && !known; j++)
            known = lstrcmpA(name, g_forwards[j].name) == 0;
        if (!known) logLine("WARNING export not forwarded: %s", name);
    }
}

// ---------------- hook bookkeeping ----------------
// A COM vtable is shared by every object of its concrete type, so each is
// patched once and its original entry points are kept here. Entries are only
// ever appended; Present reads the table without taking a lock, so the render
// thread never blocks on a hook lookup.

enum { MAX_VTABLES = 8 };

typedef HRESULT (STDMETHODCALLTYPE *PFN_CreateSwapChain)(
    IDXGIFactory*, IUnknown*, DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**);
typedef HRESULT (STDMETHODCALLTYPE *PFN_CreateSwapChainForHwnd)(
    IDXGIFactory2*, IUnknown*, HWND, const DXGI_SWAP_CHAIN_DESC1*,
    const DXGI_SWAP_CHAIN_FULLSCREEN_DESC*, IDXGIOutput*, IDXGISwapChain1**);
typedef HRESULT (STDMETHODCALLTYPE *PFN_Present)(IDXGISwapChain*, UINT, UINT);
typedef HRESULT (STDMETHODCALLTYPE *PFN_Present1)(
    IDXGISwapChain1*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);
typedef HRESULT (STDMETHODCALLTYPE *PFN_ResizeBuffers)(
    IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);

struct FactoryHooks {
    const void* vtbl;
    PFN_CreateSwapChain CreateSwapChain;
    PFN_CreateSwapChainForHwnd CreateSwapChainForHwnd;
};
struct SwapChainHooks {
    const void* vtbl;
    PFN_Present Present;
    PFN_Present1 Present1;
    PFN_ResizeBuffers ResizeBuffers;
};

static FactoryHooks g_factories[MAX_VTABLES];
static volatile LONG g_factoryCount;
static SwapChainHooks g_swapchains[MAX_VTABLES];
static volatile LONG g_swapchainCount;
static CRITICAL_SECTION g_patchCs;

static const FactoryHooks* factoryHooks(const void* vtbl) {
    LONG n = g_factoryCount;
    for (LONG i = 0; i < n; i++)
        if (g_factories[i].vtbl == vtbl) return &g_factories[i];
    return nullptr;
}
static const SwapChainHooks* swapChainHooks(const void* vtbl) {
    LONG n = g_swapchainCount;
    for (LONG i = 0; i < n; i++)
        if (g_swapchains[i].vtbl == vtbl) return &g_swapchains[i];
    return nullptr;
}

/** Overwrite one vtable slot. DXGI vtables live in read-only data, so the page
 *  protection has to be lifted and restored around the write. */
template <typename T>
static bool patchSlot(T* slot, T replacement) {
    DWORD prev = 0;
    if (!VirtualProtect(slot, sizeof(T), PAGE_READWRITE, &prev)) return false;
    *slot = replacement;
    VirtualProtect(slot, sizeof(T), prev, &prev);
    return true;
}

// ---------------- probe state ----------------
static volatile LONG g_presents;
static volatile LONG g_firstPresentLogged;
static volatile LONG g_present1Logged;
static volatile LONGLONG g_windowStart;   // tick count when the rate window opened
static volatile LONG g_windowBase;        // g_presents when it opened

/** e.g. "R8G8B8A8_UNORM(28)". The number is logged as well because an
 *  unrecognised format is most likely an HDR back buffer, where an additive
 *  step of alpha/255 is the wrong size and has to be scaled. */
static const char* formatName(DXGI_FORMAT f, char* buf, size_t n) {
    const char* s;
    switch (f) {
        case DXGI_FORMAT_R8G8B8A8_UNORM:        s = "R8G8B8A8_UNORM"; break;
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:   s = "R8G8B8A8_UNORM_SRGB"; break;
        case DXGI_FORMAT_B8G8R8A8_UNORM:        s = "B8G8R8A8_UNORM"; break;
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:   s = "B8G8R8A8_UNORM_SRGB"; break;
        case DXGI_FORMAT_R10G10B10A2_UNORM:     s = "R10G10B10A2_UNORM"; break;
        case DXGI_FORMAT_R16G16B16A16_FLOAT:    s = "R16G16B16A16_FLOAT"; break;
        default:                                s = "other"; break;
    }
    _snprintf(buf, n, "%s(%d)", s, (int)f);
    return buf;
}

/** Which graphics API the caller of CreateSwapChain* is using. For D3D12 the
 *  device argument is the command queue the marking pass will later submit to,
 *  which is the whole reason the plan hooks swapchain creation rather than
 *  patching Present alone. */
static const char* deviceApi(IUnknown* device) {
    if (!device) return "none";
    void* p = nullptr;
    if (SUCCEEDED(device->lpVtbl->QueryInterface(device, IID_ID3D12CommandQueue, &p)) && p) {
        ((IUnknown*)p)->lpVtbl->Release((IUnknown*)p);
        return "D3D12";
    }
    p = nullptr;
    if (SUCCEEDED(device->lpVtbl->QueryInterface(device, IID_ID3D11Device, &p)) && p) {
        ((IUnknown*)p)->lpVtbl->Release((IUnknown*)p);
        return "D3D11";
    }
    return "unknown";
}

/** The containing output's colour space, which decides whether an additive step
 *  of alpha/255 means the same thing it does on Proton. In a PQ (HDR10) space
 *  code values are non-linear in luma, so the same step is a different mark
 *  strength and the amplitude has to be scaled. 0 = RGB_FULL_G22_NONE_P709
 *  (SDR), 12 = RGB_FULL_G2084_NONE_P2020 (HDR10). */
static void logColorSpace(IDXGISwapChain* sc) {
    if (!g_draw) return;   // WMPOC_NODRAW means touch nothing beyond the probe
    IDXGIOutput* out = nullptr;
    HRESULT hr = sc->lpVtbl->GetContainingOutput(sc, &out);
    if (FAILED(hr) || !out) {
        logLine("output colour space unknown (GetContainingOutput hr=0x%lx)", hr);
        return;
    }
    void* p = nullptr;
    if (SUCCEEDED(out->lpVtbl->QueryInterface(out, IID_IDXGIOutput6, &p)) && p) {
        auto o6 = (IDXGIOutput6*)p;
        DXGI_OUTPUT_DESC1 d;
        if (SUCCEEDED(o6->lpVtbl->GetDesc1(o6, &d)))
            logLine("output colour space=%d bitsPerColor=%u maxLuminance=%.0f",
                    (int)d.ColorSpace, d.BitsPerColor, d.MaxLuminance);
        o6->lpVtbl->Release(o6);
    } else {
        logLine("output has no IDXGIOutput6; colour space unknown");
    }
    out->lpVtbl->Release(out);
}

static void logLoadedGraphicsModules() {
    static const char* mods[] = { "d3d11.dll", "d3d12.dll", "D3D12Core.dll",
                                  "vulkan-1.dll", "d3d9.dll", "dxvk_d3d11.dll" };
    char buf[512];
    int n = 0;
    for (int i = 0; i < (int)(sizeof(mods) / sizeof(mods[0])); i++) {
        if (!GetModuleHandleA(mods[i])) continue;
        int m = _snprintf(buf + n, sizeof(buf) - n, n ? " %s" : "%s", mods[i]);
        if (m < 0) break;
        n += m;
    }
    logLine("graphics modules loaded: %s", n ? buf : "(none)");
}

// ---------------- visible mode, D3D12 ----------------
// Draws the session ID as large magenta text into the back buffer just before
// the game's Present, on the game's OWN command queue. Using that queue is the
// whole trick: work submitted to it is ordered after everything the game has
// already submitted, so no cross-queue synchronisation is needed and the mark
// lands on the finished frame.
//
// One command list per back buffer is recorded once and re-executed every frame.
// Nothing is reset per frame, so there is no per-frame allocator sync; the fence
// exists only to drain our own work before releasing the back buffers.
//
// Scope: one swapchain. Several swapchains, device removal and HDR scaling are
// milestone M6 in the upstream sample's Windows support plan; a second swapchain is reported
// and left unmarked rather than mishandled.

enum { MAX_BACKBUFFERS = 8 };

struct Marker {
    IDXGISwapChain* sc;            // the one swapchain we mark (not owned)
    int api;                       // which of the two sets below is in use

    // D3D12: a command list per back buffer, submitted on the game's queue.
    IDXGISwapChain3* sc3;          // for GetCurrentBackBufferIndex
    ID3D12CommandQueue* queue;     // the game's queue, captured at creation
    ID3D12Device* device;
    ID3D12DescriptorHeap* rtvHeap;
    ID3D12Resource* buffers[MAX_BACKBUFFERS];
    ID3D12CommandAllocator* allocs[MAX_BACKBUFFERS];
    ID3D12GraphicsCommandList* lists[MAX_BACKBUFFERS];
    UINT bufferCount;
    UINT rtvStride;
    ID3D12Fence* fence;
    HANDLE fenceEvent;
    UINT64 fenceValue;

    // D3D12 forensic mode only: a fullscreen additive pass instead of clears.
    ID3D12RootSignature* rootSig;
    ID3D12PipelineState* pso;

    // D3D11: no command lists or barriers needed, because the immediate context
    // executes in order with the game's own work. ClearView does not touch
    // pipeline state, so the game's bindings do not have to be saved either -
    // but the forensic pass DRAWS, so that one isolates itself; see below.
    ID3D11Device* dev11;
    ID3D11DeviceContext1* ctx11;   // ClearView lives on the 11.1 context
    ID3D11RenderTargetView* rtv11;

    // D3D11 forensic mode only.
    ID3D11VertexShader* vs11;
    ID3D11PixelShader* ps11;
    ID3D11Buffer* cb11;
    ID3D11BlendState* blend11;
    ID3D11RasterizerState* raster11;
    ID3D11DepthStencilState* depth11;
    int iso11;                               // which ISO_* mechanism is in use
    ID3DDeviceContextState* ourState11;      // ISO_STATE: swapped in around the draw
    ID3D11DeviceContext* deferred11;         // ISO_DEFERRED: records cmdList11
    ID3D11CommandList* cmdList11;            // ISO_DEFERRED: records the render
                                             // target view, so it dies with the
                                             // back buffers
    bool pso11Ready;

    bool built;
    bool failed;        // latched: present unmarked from now on
    LONG buildAttempts;
    int nRects;         // kept for D3D11, which clears per frame
    UINT width, height; // back buffer size, for the D3D11 viewport
};
static Marker g_mark;
static CRITICAL_SECTION g_markCs;
// Forensic mode, selected by WMPOC_SEED exactly as the Proton layer selects it.
// The four values the shader needs are passed as root constants on D3D12 and a
// constant buffer on D3D11; the layout matches the cbuffer in
// shaders/wm_ps.hlsl, and happens to need no padding.
struct ShaderConstants { UINT32 seedLo, seedHi, tile; float alpha; };

static const UINT32 WM_TILE_SIZE = 256;   // must match TILE in the verifier's handler.py
static bool g_forensic;                   // WMPOC_SEED parsed successfully
static ShaderConstants g_constants;

/** First 8 bytes of the 128-bit hex seed into two big-endian uint32, matching
 *  seed_words() in the verifier (source/lambdas/PlayTestVerifyWatermark/handler.py) and parseSeed() in the Vulkan layer.
 *  Get this wrong and the mark is undetectable rather than visibly broken. */
static bool parseSeed(const char* hex, UINT32* lo, UINT32* hi) {
    if (!hex || lstrlenA(hex) < 16) return false;
    unsigned char b[8];
    for (int i = 0; i < 8; i++) {
        int v = 0;
        for (int half = 0; half < 2; half++) {
            char c = hex[2 * i + half];
            int d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if ((c | 32) >= 'a' && (c | 32) <= 'f') d = (c | 32) - 'a' + 10;
            else return false;
            v = (v << 4) | d;
        }
        b[i] = (unsigned char)v;
    }
    *lo = ((UINT32)b[0] << 24) | ((UINT32)b[1] << 16) | ((UINT32)b[2] << 8) | b[3];
    *hi = ((UINT32)b[4] << 24) | ((UINT32)b[5] << 16) | ((UINT32)b[6] << 8) | b[7];
    return true;
}

#define RELEASE(p) do { if (p) { (p)->lpVtbl->Release(p); (p) = nullptr; } } while (0)

// The glyph squares, and the colour to paint them. D3D12 records them into its
// command lists once; D3D11 re-issues them from here on every present, so they
// live at file scope. Both are only touched under g_markCs.
static D3D12_RECT g_rects[WM_TEXT_MAX_RECTS];   // D3D11_RECT is the same RECT
static const FLOAT g_magenta[4] = { 1.0f, 0.0f, 1.0f, 1.0f };

/** GetCPUDescriptorHandleForHeapStart, without assuming which ABI the runtime
 *  uses for its return value.
 *
 *  This method returns an 8-byte POD by value, and the two plausible
 *  conventions put the result in different places. The Microsoft x64 ABI
 *  returns such a struct directly in RAX, which is what an MSVC-built
 *  d3d12.dll should do. mingw-w64's C vtable instead declares the slot as
 *  taking a hidden out-parameter and returning a pointer to it - widl's blanket
 *  workaround for aggregate returns - and Wine's vkd3d, built from these same
 *  headers, really does behave that way.
 *
 *  Guessing wrong either reads a handle as a pointer or writes one through an
 *  uninitialised register, so instead this calls the header form, which always
 *  passes a VALID out-pointer, and then works out where the answer landed. That
 *  is safe under both conventions: an out-parameter implementation fills the
 *  struct, and a by-value one ignores the extra argument and leaves the result
 *  in what the header calls the return pointer. */
static D3D12_CPU_DESCRIPTOR_HANDLE rtvHeapStart(ID3D12DescriptorHeap* heap) {
    const SIZE_T sentinel = (SIZE_T)0xD1A6D1A6D1A6D1A6ull;
    D3D12_CPU_DESCRIPTOR_HANDLE out;
    out.ptr = sentinel;
    D3D12_CPU_DESCRIPTOR_HANDLE* ret =
        heap->lpVtbl->GetCPUDescriptorHandleForHeapStart(heap, &out);
    D3D12_CPU_DESCRIPTOR_HANDLE h;
    if (out.ptr != sentinel) {
        h = out;                      // filled the out-parameter
    } else {
        h.ptr = (SIZE_T)ret;          // returned the handle itself, in RAX
    }
    static LONG logged = 0;
    if (InterlockedCompareExchange(&logged, 1, 0) == 0)
        logLine("marker: descriptor handle ABI = %s (ptr=%p)",
                out.ptr != sentinel ? "out-parameter" : "by-value", (void*)h.ptr);
    return h;
}

/** The stream session ID, read from the agent's own metrics file. It is not
 *  known when the session's environment variables are set, so it cannot be
 *  passed in - the same reason the Proton layer reads it from a log filename.
 *  Both are service-internal files whose format could change. */
static bool readSessionId(char* out, size_t outSize) {
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA("C:\\Game\\Logs_*", &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    bool found = false;
    do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        char path[MAX_PATH];
        if (_snprintf(path, sizeof(path), "C:\\Game\\%s\\server-metrics.json", fd.cFileName) < 0)
            continue;
        HANDLE f = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (f == INVALID_HANDLE_VALUE) continue;
        static char buf[65536];
        DWORD got = 0;
        BOOL ok = ReadFile(f, buf, sizeof(buf) - 1, &got, nullptr);
        CloseHandle(f);
        if (!ok || !got) continue;
        buf[got] = '\0';
        // {"Name":"session_id","Value":"..."} - scan rather than parse, since
        // only this one field is wanted out of a file we do not own.
        const char* p = strstr(buf, "session_id");
        if (!p) continue;
        const char* v = strstr(p, "\"Value\"");
        if (!v || v - p > 200) continue;
        v = strchr(v + 7, '"');
        if (!v) continue;
        const char* e = strchr(++v, '"');
        if (!e || (size_t)(e - v) >= outSize || e == v) continue;
        memcpy(out, v, (size_t)(e - v));
        out[e - v] = '\0';
        found = true;
    } while (!found && FindNextFileA(h, &fd));
    FindClose(h);
    return found;
}

/** WMPOC_TEXT, else the session ID, else nothing yet. Returns false while the
 *  session ID is still unavailable, so the caller can wait rather than commit
 *  to a placeholder on the first frame. */
static bool watermarkText(char* out, size_t outSize) {
    DWORD n = GetEnvironmentVariableA("WMPOC_TEXT", out, (DWORD)outSize);
    if (n > 0 && n < outSize) return true;
    return readSessionId(out, outSize);
}

/** Block until everything we have submitted has finished, so the back buffers
 *  can be released. */
static void markerDrain() {
    if (!g_mark.fence || !g_mark.queue || !g_mark.fenceEvent) return;
    UINT64 v = ++g_mark.fenceValue;
    if (FAILED(g_mark.queue->lpVtbl->Signal(g_mark.queue, g_mark.fence, v))) return;
    if (g_mark.fence->lpVtbl->GetCompletedValue(g_mark.fence) >= v) return;
    if (SUCCEEDED(g_mark.fence->lpVtbl->SetEventOnCompletion(g_mark.fence, v, g_mark.fenceEvent)))
        WaitForSingleObject(g_mark.fenceEvent, 2000);
}

/** Release everything tied to the current back buffers. The references we hold
 *  on them would otherwise make ResizeBuffers fail. */
static void markerReleaseBuffers() {
    markerDrain();
    for (UINT i = 0; i < MAX_BACKBUFFERS; i++) {
        RELEASE(g_mark.lists[i]);
        RELEASE(g_mark.allocs[i]);
        RELEASE(g_mark.buffers[i]);
    }
    RELEASE(g_mark.rtvHeap);
    // The D3D11 command list has the render target view recorded into it, so it
    // holds a reference to the back buffer as surely as the view does and has to
    // go at the same time. markerBuild11 records a fresh one afterwards.
    RELEASE(g_mark.cmdList11);
    RELEASE(g_mark.rtv11);
    g_mark.bufferCount = 0;
    g_mark.built = false;
}

// Fails hard: log, latch and give up marking for the rest of the session.
#define MARKER_FAIL(...) do { logLine("marker: " __VA_ARGS__); \
                              g_mark.failed = true; return false; } while (0)

/** Root signature and pipeline state for the forensic pass. Four root constants
 *  rather than a constant buffer, because the shader's four values fit in 16
 *  bytes and that avoids an upload buffer and its lifetime entirely.
 *
 *  The blend state is what makes the pass additive: the shader outputs only the
 *  delta to add, so it never has to read the back buffer. */
static bool buildForensicPipeline12(DXGI_FORMAT rtFormat) {
    Marker& m = g_mark;

    // D3D12SerializeRootSignature is a plain export of d3d12.dll, which the
    // game has already loaded; the proxy links no D3D libraries of its own.
    HMODULE d3d12 = GetModuleHandleA("d3d12.dll");
    if (!d3d12) MARKER_FAIL("d3d12.dll is not loaded, so no root signature");
    typedef HRESULT (WINAPI *PFN_Serialize)(const D3D12_ROOT_SIGNATURE_DESC*,
                                            D3D_ROOT_SIGNATURE_VERSION,
                                            ID3DBlob**, ID3DBlob**);
    PFN_Serialize serialize =
        (PFN_Serialize)(void*)GetProcAddress(d3d12, "D3D12SerializeRootSignature");
    if (!serialize) MARKER_FAIL("D3D12SerializeRootSignature not found");

    D3D12_ROOT_PARAMETER param = {};
    param.ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    param.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    param.Constants.ShaderRegister = 0;      // matches register(b0) in the HLSL
    param.Constants.Num32BitValues = sizeof(ShaderConstants) / 4;

    D3D12_ROOT_SIGNATURE_DESC rsDesc = {};
    rsDesc.NumParameters = 1;
    rsDesc.pParameters = &param;

    ID3DBlob* blob = nullptr;
    ID3DBlob* err = nullptr;
    HRESULT hr = serialize(&rsDesc, D3D_ROOT_SIGNATURE_VERSION_1, &blob, &err);
    if (err) err->lpVtbl->Release(err);
    if (FAILED(hr) || !blob) MARKER_FAIL("SerializeRootSignature failed, hr=0x%lx", hr);

    hr = m.device->lpVtbl->CreateRootSignature(
        m.device, 0, blob->lpVtbl->GetBufferPointer(blob),
        blob->lpVtbl->GetBufferSize(blob), IID_ID3D12RootSignature, (void**)&m.rootSig);
    blob->lpVtbl->Release(blob);
    if (FAILED(hr) || !m.rootSig) MARKER_FAIL("CreateRootSignature failed, hr=0x%lx", hr);

    D3D12_GRAPHICS_PIPELINE_STATE_DESC pd = {};
    pd.pRootSignature = m.rootSig;
    pd.VS.pShaderBytecode = vs_dxil; pd.VS.BytecodeLength = vs_dxil_len;
    pd.PS.pShaderBytecode = ps_dxil; pd.PS.BytecodeLength = ps_dxil_len;

    // dst + src on colour, dst untouched on alpha - the same blend the Vulkan
    // layer sets up, so the embedded amplitude matches.
    pd.BlendState.RenderTarget[0].BlendEnable = TRUE;
    pd.BlendState.RenderTarget[0].SrcBlend = D3D12_BLEND_ONE;
    pd.BlendState.RenderTarget[0].DestBlend = D3D12_BLEND_ONE;
    pd.BlendState.RenderTarget[0].BlendOp = D3D12_BLEND_OP_ADD;
    pd.BlendState.RenderTarget[0].SrcBlendAlpha = D3D12_BLEND_ZERO;
    pd.BlendState.RenderTarget[0].DestBlendAlpha = D3D12_BLEND_ONE;
    pd.BlendState.RenderTarget[0].BlendOpAlpha = D3D12_BLEND_OP_ADD;
    pd.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;

    pd.SampleMask = UINT_MAX;
    pd.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    // CULL_NONE is required, not a preference: the fullscreen triangle the
    // vertex shader builds is counter-clockwise, which D3D treats as back
    // facing, so the default cull mode would silently draw nothing.
    pd.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    pd.RasterizerState.DepthClipEnable = TRUE;
    pd.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pd.NumRenderTargets = 1;
    pd.RTVFormats[0] = rtFormat;
    pd.SampleDesc.Count = 1;

    hr = m.device->lpVtbl->CreateGraphicsPipelineState(
        m.device, &pd, IID_ID3D12PipelineState, (void**)&m.pso);
    if (FAILED(hr) || !m.pso) MARKER_FAIL("CreateGraphicsPipelineState failed, hr=0x%lx", hr);
    logLine("marker: forensic pipeline ready, rt format %d", (int)rtFormat);
    return true;
}

/** D3D12: one command list per back buffer, taking the buffer from PRESENT to
 *  RENDER_TARGET, drawing or clearing into it, and putting it back. */
static bool markerBuild12() {
    Marker& m = g_mark;

    if (!m.device &&
        FAILED(m.queue->lpVtbl->GetDevice(m.queue, IID_ID3D12Device, (void**)&m.device)))
        MARKER_FAIL("GetDevice failed");
    if (!m.sc3 &&
        FAILED(m.sc->lpVtbl->QueryInterface(m.sc, IID_IDXGISwapChain3, (void**)&m.sc3)))
        MARKER_FAIL("no IDXGISwapChain3, cannot find the current back buffer");

    const int nRects = m.nRects;
    D3D12_RECT* d3dRects = g_rects;

    DXGI_SWAP_CHAIN_DESC scd;
    if (FAILED(m.sc->lpVtbl->GetDesc(m.sc, &scd))) MARKER_FAIL("GetDesc failed");
    if (g_forensic && !m.pso && !buildForensicPipeline12(scd.BufferDesc.Format)) return false;

    D3D12_DESCRIPTOR_HEAP_DESC hd = {};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = m.bufferCount;
    if (FAILED(m.device->lpVtbl->CreateDescriptorHeap(m.device, &hd, IID_ID3D12DescriptorHeap,
                                                      (void**)&m.rtvHeap)))
        MARKER_FAIL("CreateDescriptorHeap failed");
    m.rtvStride = m.device->lpVtbl->GetDescriptorHandleIncrementSize(
        m.device, D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    D3D12_CPU_DESCRIPTOR_HANDLE heapStart = rtvHeapStart(m.rtvHeap);
    if (!heapStart.ptr || !m.rtvStride) MARKER_FAIL("bad RTV heap handle");
    if (heapStart.ptr == (SIZE_T)m.rtvHeap)
        MARKER_FAIL("heap start equals the heap object at %p, so the handle is not a"
                    " descriptor handle", (void*)m.rtvHeap);

    for (UINT i = 0; i < m.bufferCount; i++) {
        if (FAILED(m.sc->lpVtbl->GetBuffer(m.sc, i, IID_ID3D12Resource, (void**)&m.buffers[i])))
            MARKER_FAIL("GetBuffer(%u) failed", i);
    }

    const FLOAT* magenta = g_magenta;
    for (UINT i = 0; i < m.bufferCount; i++) {
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = { heapStart.ptr + (SIZE_T)i * m.rtvStride };
        m.device->lpVtbl->CreateRenderTargetView(m.device, m.buffers[i], nullptr, rtv);

        if (FAILED(m.device->lpVtbl->CreateCommandAllocator(
                m.device, D3D12_COMMAND_LIST_TYPE_DIRECT, IID_ID3D12CommandAllocator,
                (void**)&m.allocs[i])))
            MARKER_FAIL("CreateCommandAllocator(%u) failed", i);
        if (FAILED(m.device->lpVtbl->CreateCommandList(
                m.device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT, m.allocs[i], nullptr,
                IID_ID3D12GraphicsCommandList, (void**)&m.lists[i])))
            MARKER_FAIL("CreateCommandList(%u) failed", i);

        ID3D12GraphicsCommandList* cl = m.lists[i];
        D3D12_RESOURCE_BARRIER b = {};
        b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        b.Transition.pResource = m.buffers[i];
        b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        b.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        b.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
        cl->lpVtbl->ResourceBarrier(cl, 1, &b);
        if (g_forensic) {
            // A fullscreen additive pass. The viewport and scissor have to be
            // set explicitly: a command list starts with none, and the pixels
            // would be scissored away with no error reported.
            D3D12_VIEWPORT vp = { 0.0f, 0.0f, (float)scd.BufferDesc.Width,
                                  (float)scd.BufferDesc.Height, 0.0f, 1.0f };
            D3D12_RECT sc = { 0, 0, (LONG)scd.BufferDesc.Width, (LONG)scd.BufferDesc.Height };
            cl->lpVtbl->OMSetRenderTargets(cl, 1, &rtv, FALSE, nullptr);
            cl->lpVtbl->RSSetViewports(cl, 1, &vp);
            cl->lpVtbl->RSSetScissorRects(cl, 1, &sc);
            cl->lpVtbl->SetGraphicsRootSignature(cl, m.rootSig);
            cl->lpVtbl->SetPipelineState(cl, m.pso);
            cl->lpVtbl->SetGraphicsRoot32BitConstants(
                cl, 0, sizeof(ShaderConstants) / 4, &g_constants, 0);
            cl->lpVtbl->IASetPrimitiveTopology(cl, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            cl->lpVtbl->DrawInstanced(cl, 3, 1, 0, 0);
        } else if (g_clearFull) {
            cl->lpVtbl->ClearRenderTargetView(cl, rtv, magenta, 0, nullptr);
        } else {
            // In batches, because recording ONE clear with all ~300 rectangles
            // killed the host driver, while a clear with none at all worked.
            const int batch = rectBatchFor(API_D3D12);
            for (int r = 0; r < nRects; r += batch) {
                int n = nRects - r < batch ? nRects - r : batch;
                cl->lpVtbl->ClearRenderTargetView(cl, rtv, magenta, (UINT)n, d3dRects + r);
            }
        }
        b.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        b.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        cl->lpVtbl->ResourceBarrier(cl, 1, &b);
        if (FAILED(cl->lpVtbl->Close(cl))) MARKER_FAIL("Close(%u) failed", i);
    }

    if (!m.fence &&
        FAILED(m.device->lpVtbl->CreateFence(m.device, 0, D3D12_FENCE_FLAG_NONE,
                                             IID_ID3D12Fence, (void**)&m.fence)))
        MARKER_FAIL("CreateFence failed");
    if (!m.fenceEvent) m.fenceEvent = CreateEventA(nullptr, FALSE, FALSE, nullptr);

    return true;
}

/** Decide how the forensic draw will be kept out of the game's pipeline state,
 *  and record the decision in m.iso11. Each step logs its own outcome, so one
 *  host session says which mechanism that title ended up on.
 *
 *  **1. A second ID3DDeviceContextState, swapped in and out around the draw.**
 *  The cheapest and the hardest to get subtly wrong: one call exchanges the
 *  entire pipeline state and hands back the game's.
 *
 *  This is the call that failed with E_INVALIDARG on Overcooked 2, and the
 *  reason is documented on CreateDeviceContextState's Flags parameter: "If the
 *  original device was created with D3D11_CREATE_DEVICE_SINGLETHREADED, you must
 *  create all context state objects from that device with the
 *  D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED flag." We passed 0, so a
 *  single-threaded device - which a Unity title may well create - has to reject
 *  it. Wine does not enforce the rule and the smoke test's own device is
 *  multithreaded anyway, which is why nothing local could have caught this.
 *
 *  The flag is mirrored FROM the device and never set speculatively. A
 *  single-threaded context state lets the runtime drop the locking that makes
 *  the device thread-safe, so setting it on a device the game created
 *  multithreaded would race whatever the game does on its other threads. An
 *  unmarked frame is recoverable; corrupting the host process is not.
 *
 *  **2. A command list recorded on a deferred context,** executed with
 *  RestoreContextState=TRUE so the runtime saves and restores the immediate
 *  context itself. Core D3D11 rather than 11.1, and pre-recorded like the D3D12
 *  path. It is second because that save and restore happens on every present
 *  rather than being one state swap - and, more to the point, because
 *  CreateDeferredContext is documented to return DXGI_ERROR_INVALID_CALL on
 *  exactly the single-threaded device that step 1 needs its flag for. The two
 *  fail on opposite devices, which is why they are worth having together.
 *
 *  **3. Manual save and restore** (see drawForensicManual11). Verbose, and
 *  faithful in all but a couple of corners, but it asks nothing of the runtime
 *  beyond core D3D11, so it cannot be unavailable. The chain therefore only runs
 *  out when a mechanism was pinned by hand. */
static bool buildIsolation11() {
    Marker& m = g_mark;
    const bool singleThreaded =
        (m.dev11->lpVtbl->GetCreationFlags(m.dev11) & D3D11_CREATE_DEVICE_SINGLETHREADED) != 0;

    if (g_isolation == ISO_AUTO || g_isolation == ISO_STATE) {
        ID3D11Device1* dev1 = nullptr;
        if (SUCCEEDED(m.dev11->lpVtbl->QueryInterface(m.dev11, kIID_ID3D11Device1,
                                                      (void**)&dev1)) && dev1) {
            // The device's own feature level, but no higher than 11_1: the
            // array this call accepts is documented and enumerated, and it stops
            // there, while a D3D11 device may well report 12_0 or above. Asking
            // for a level the call does not list would be a second way to earn
            // E_INVALIDARG, and clamping costs nothing - the pass needs nothing
            // beyond 11_0, and a 12_x device supports all of 11_1.
            D3D_FEATURE_LEVEL fl = m.dev11->lpVtbl->GetFeatureLevel(m.dev11);
            if (fl > D3D_FEATURE_LEVEL_11_1) fl = D3D_FEATURE_LEVEL_11_1;
            UINT flags = singleThreaded
                ? (UINT)D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED : 0u;
            HRESULT hr = dev1->lpVtbl->CreateDeviceContextState(
                dev1, flags, &fl, 1, D3D11_SDK_VERSION, kIID_ID3D11Device1,
                nullptr, &m.ourState11);
            dev1->lpVtbl->Release(dev1);
            if (SUCCEEDED(hr) && m.ourState11) {
                m.iso11 = ISO_STATE;
                logLine("marker: isolation = %s, CreateDeviceContextState flags=0x%x"
                        " feature level 0x%x", isolationName(ISO_STATE), flags, (unsigned)fl);
                return true;
            }
            RELEASE(m.ourState11);
            logLine("marker: CreateDeviceContextState(flags=0x%x, feature level 0x%x)"
                    " failed, hr=0x%lx", flags, (unsigned)fl, hr);
        } else {
            logLine("marker: no ID3D11Device1, so no device context state");
        }
        if (g_isolation == ISO_STATE)
            MARKER_FAIL("WMPOC_ISOLATION=state was pinned and is not available here");
    }

    if (g_isolation == ISO_AUTO || g_isolation == ISO_DEFERRED) {
        HRESULT hr = m.dev11->lpVtbl->CreateDeferredContext(m.dev11, 0, &m.deferred11);
        if (SUCCEEDED(hr) && m.deferred11) {
            m.iso11 = ISO_DEFERRED;
            logLine("marker: isolation = %s", isolationName(ISO_DEFERRED));
            return true;
        }
        RELEASE(m.deferred11);
        // 0x887a0001 is DXGI_ERROR_INVALID_CALL: the documented answer on a
        // single-threaded device, and the complement of the failure above.
        logLine("marker: CreateDeferredContext failed, hr=0x%lx", hr);
        if (g_isolation == ISO_DEFERRED)
            MARKER_FAIL("WMPOC_ISOLATION=deferred was pinned and is not available here");
    }

    m.iso11 = ISO_MANUAL;
    logLine("marker: isolation = %s", isolationName(ISO_MANUAL));
    return true;
}

/** Shaders and state objects for the D3D11 forensic pass, plus the choice of
 *  how to isolate it. All of this belongs to the device rather than to the back
 *  buffers, so it survives a ResizeBuffers; only the render target view and the
 *  command list that records it are rebuilt (see markerBuild11). */
static bool buildForensicPipeline11() {
    Marker& m = g_mark;

    if (FAILED(m.dev11->lpVtbl->CreateVertexShader(m.dev11, vs_dxbc, vs_dxbc_len,
                                                   nullptr, &m.vs11)))
        MARKER_FAIL("CreateVertexShader failed - DXBC rejected by the runtime");
    if (FAILED(m.dev11->lpVtbl->CreatePixelShader(m.dev11, ps_dxbc, ps_dxbc_len,
                                                  nullptr, &m.ps11)))
        MARKER_FAIL("CreatePixelShader failed - DXBC rejected by the runtime");

    // The seed does not change within a session, so the buffer is immutable.
    D3D11_BUFFER_DESC bd = {};
    bd.ByteWidth = sizeof(ShaderConstants);
    bd.Usage = D3D11_USAGE_IMMUTABLE;
    bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem = &g_constants;
    if (FAILED(m.dev11->lpVtbl->CreateBuffer(m.dev11, &bd, &init, &m.cb11)))
        MARKER_FAIL("CreateBuffer for the shader constants failed");

    D3D11_BLEND_DESC bl = {};
    bl.RenderTarget[0].BlendEnable = TRUE;
    bl.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
    bl.RenderTarget[0].DestBlend = D3D11_BLEND_ONE;
    bl.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    bl.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ZERO;
    bl.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ONE;
    bl.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    bl.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    if (FAILED(m.dev11->lpVtbl->CreateBlendState(m.dev11, &bl, &m.blend11)))
        MARKER_FAIL("CreateBlendState failed");

    D3D11_RASTERIZER_DESC rs = {};
    rs.FillMode = D3D11_FILL_SOLID;
    rs.CullMode = D3D11_CULL_NONE;   // see the note in shaders/wm_vs.hlsl
    rs.DepthClipEnable = TRUE;
    if (FAILED(m.dev11->lpVtbl->CreateRasterizerState(m.dev11, &rs, &m.raster11)))
        MARKER_FAIL("CreateRasterizerState failed");

    D3D11_DEPTH_STENCIL_DESC ds = {};   // depth and stencil both off
    if (FAILED(m.dev11->lpVtbl->CreateDepthStencilState(m.dev11, &ds, &m.depth11)))
        MARKER_FAIL("CreateDepthStencilState failed");

    if (!buildIsolation11()) return false;

    m.pso11Ready = true;
    logLine("marker: forensic pipeline ready on D3D11, isolated with the %s",
            isolationName(m.iso11));
    return true;
}

/** Everything the forensic pass binds, then the draw itself.
 *
 *  Shared by all three isolation mechanisms: it runs into our own context state,
 *  into the deferred context while recording, or straight onto the immediate
 *  context between a manual save and restore. One copy means the three cannot
 *  drift into drawing different things.
 *
 *  Nothing here is conditional on the mechanism, and it is re-issued rather than
 *  left set up once, because a ResizeBuffers changes both the render target view
 *  and the viewport. */
static void recordForensicDraw11(ID3D11DeviceContext* c) {
    Marker& m = g_mark;
    D3D11_VIEWPORT vp = { 0.0f, 0.0f, (float)m.width, (float)m.height, 0.0f, 1.0f };
    const FLOAT noFactor[4] = { 0, 0, 0, 0 };
    c->lpVtbl->OMSetRenderTargets(c, 1, &m.rtv11, nullptr);
    c->lpVtbl->RSSetViewports(c, 1, &vp);
    c->lpVtbl->RSSetState(c, m.raster11);
    c->lpVtbl->OMSetBlendState(c, m.blend11, noFactor, 0xffffffff);
    c->lpVtbl->OMSetDepthStencilState(c, m.depth11, 0);
    c->lpVtbl->IASetInputLayout(c, nullptr);
    c->lpVtbl->IASetPrimitiveTopology(c, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    c->lpVtbl->VSSetShader(c, m.vs11, nullptr, 0);
    c->lpVtbl->PSSetShader(c, m.ps11, nullptr, 0);
    c->lpVtbl->PSSetConstantBuffers(c, 0, 1, &m.cb11);
    c->lpVtbl->Draw(c, 3, 0);
}

/** ISO_DEFERRED: record the pass once so each present is a single
 *  ExecuteCommandList, in the spirit of the pre-recorded D3D12 lists.
 *
 *  RestoreDeferredContextState=FALSE because nothing is inherited between
 *  recordings and recordForensicDraw11 sets every piece of state it needs, so
 *  there is nothing worth the runtime saving. The resulting list is immutable
 *  and replayed every frame; it is re-recorded only when the back buffers
 *  change. Not a latching failure: the caller steps down to manual instead. */
static bool recordCommandList11() {
    Marker& m = g_mark;
    if (!m.deferred11) return false;
    recordForensicDraw11(m.deferred11);
    HRESULT hr = m.deferred11->lpVtbl->FinishCommandList(m.deferred11, FALSE, &m.cmdList11);
    if (FAILED(hr) || !m.cmdList11) {
        RELEASE(m.cmdList11);
        logLine("marker: FinishCommandList failed, hr=0x%lx", hr);
        return false;
    }
    return true;
}

/** D3D11: one render target view of back buffer 0, cleared through the
 *  immediate context. No command lists, no barriers and no state to save -
 *  ClearView does not disturb the pipeline, and the immediate context is
 *  already ordered against the game's own work. In the flip model DXGI rotates
 *  the buffers behind GetBuffer(0), so a single view stays correct. */
static bool markerBuild11() {
    Marker& m = g_mark;

    if (!m.ctx11) {
        ID3D11DeviceContext* ctx = nullptr;
        m.dev11->lpVtbl->GetImmediateContext(m.dev11, &ctx);
        if (!ctx) MARKER_FAIL("GetImmediateContext returned nothing");
        HRESULT hr = ctx->lpVtbl->QueryInterface(ctx, kIID_ID3D11DeviceContext1, (void**)&m.ctx11);
        ctx->lpVtbl->Release(ctx);
        if (FAILED(hr) || !m.ctx11)
            MARKER_FAIL("no ID3D11DeviceContext1, so ClearView is unavailable");
    }

    // The device's creation flags, once, whatever happens next. They decide
    // which isolation mechanisms are open to the forensic pass - the first two
    // have opposite requirements - so on a title that does not mark, this line
    // answers immediately what would otherwise cost a stream session to guess.
    static LONG creationFlagsLogged = 0;
    if (InterlockedCompareExchange(&creationFlagsLogged, 1, 0) == 0) {
        UINT cf = m.dev11->lpVtbl->GetCreationFlags(m.dev11);
        logLine("marker: D3D11 device creation flags=0x%x (%s), feature level 0x%x", cf,
                (cf & D3D11_CREATE_DEVICE_SINGLETHREADED) ? "SINGLETHREADED" : "multithreaded",
                (unsigned)m.dev11->lpVtbl->GetFeatureLevel(m.dev11));
    }

    if (g_forensic && !m.pso11Ready && !buildForensicPipeline11()) return false;

    ID3D11Texture2D* tex = nullptr;
    if (FAILED(m.sc->lpVtbl->GetBuffer(m.sc, 0, IID_ID3D11Texture2D, (void**)&tex)) || !tex)
        MARKER_FAIL("GetBuffer(0) failed");
    HRESULT hr = m.dev11->lpVtbl->CreateRenderTargetView(
        m.dev11, (ID3D11Resource*)tex, nullptr, &m.rtv11);
    tex->lpVtbl->Release(tex);
    if (FAILED(hr) || !m.rtv11) MARKER_FAIL("CreateRenderTargetView failed, hr=0x%lx", hr);

    // Recorded here rather than with the device objects because the view goes
    // into the list. Recording is the only part of the deferred route that can
    // still fail this late, and manual save/restore needs nothing created at
    // all, so step down to it rather than give up the mark.
    if (g_forensic && m.iso11 == ISO_DEFERRED && !m.cmdList11 && !recordCommandList11()) {
        m.iso11 = ISO_MANUAL;
        logLine("marker: isolation falls back to %s", isolationName(ISO_MANUAL));
    }
    return true;
}

/** Resolve the text, work out the glyph squares and then hand over to whichever
 *  API this swapchain belongs to. Called with g_markCs held.
 *
 *  Returns false both when the build genuinely failed and when it is simply too
 *  early to build - the two are distinguished by m.failed, which latches so a
 *  real failure is never retried at frame rate. */
static bool markerBuild() {
    Marker& m = g_mark;

    DXGI_SWAP_CHAIN_DESC desc;
    if (FAILED(m.sc->lpVtbl->GetDesc(m.sc, &desc))) MARKER_FAIL("GetDesc failed");
    const UINT W = desc.BufferDesc.Width, H = desc.BufferDesc.Height;
    m.bufferCount = desc.BufferCount;
    if (m.bufferCount > MAX_BACKBUFFERS)
        MARKER_FAIL("%u back buffers exceeds the %d supported", m.bufferCount, MAX_BACKBUFFERS);
    m.width = W;
    m.height = H;

    // Forensic mode draws a pattern keyed by the seed, so unlike visible mode
    // it needs neither the session ID nor any glyph rectangles - and must not
    // wait around for the agent to publish the session ID.
    if (g_forensic) {
        if (!(m.api == API_D3D12 ? markerBuild12() : markerBuild11())) return false;
        m.built = true;
        m.buildAttempts = 0;
        logLine("marker: forensic mode ready on D3D%d - seed %08x%08x, tile %u, alpha %.2f,"
                " over %ux%u, %u back buffers",
                m.api, g_constants.seedLo, g_constants.seedHi, g_constants.tile,
                (double)g_constants.alpha, W, H, m.bufferCount);
        return true;
    }

    char text[WM_TEXT_MAX_CHARS + 1];
    if (!watermarkText(text, sizeof(text))) {
        // The agent may not have written its metrics file yet. Wait a few
        // frames rather than burning in a placeholder for the whole session.
        // Not a failure, so m.failed is left alone and this is retried.
        if (++m.buildAttempts < 300) return false;
        lstrcpynA(text, "WATERMARK", sizeof(text));
        logLine("marker: no session id after %ld frames; falling back to \"%s\"",
                (long)m.buildAttempts, text);
    }

    static WmRect rects[WM_TEXT_MAX_RECTS];
    m.nRects = wmBuildTextRects(text, lstrlenA(text), W, H, rects, WM_TEXT_MAX_RECTS);
    if (m.nRects <= 0) MARKER_FAIL("no rectangles for \"%s\"", text);
    for (int i = 0; i < m.nRects; i++) {
        g_rects[i].left = rects[i].x0; g_rects[i].top = rects[i].y0;
        g_rects[i].right = rects[i].x1; g_rects[i].bottom = rects[i].y1;
    }

    if (!(m.api == API_D3D12 ? markerBuild12() : markerBuild11())) return false;

    m.built = true;
    m.buildAttempts = 0;
    logLine("marker: visible mode ready on D3D%d - \"%s\" as %d rects over %ux%u,"
            " %u back buffers, up to %d rects per clear",
            m.api, text, m.nRects, W, H, m.bufferCount, rectBatchFor(m.api));
    return true;
#undef MARKER_FAIL
}

/** Submit the pre-recorded list for the back buffer about to be presented. */
static void markerSubmit12(bool first) {
    Marker& m = g_mark;
    UINT idx = m.sc3->lpVtbl->GetCurrentBackBufferIndex(m.sc3);
    if (idx >= m.bufferCount || !m.lists[idx]) return;
    ID3D12CommandList* l = (ID3D12CommandList*)m.lists[idx];
    if (g_buildOnly) {
        if (first) logLine("marker: WMPOC_BUILDONLY - list %u ready but not submitted", idx);
        return;
    }
    if (first) logLine("marker: executing list for back buffer %u", idx);
    m.queue->lpVtbl->ExecuteCommandLists(m.queue, 1, &l);
    if (first) logLine("marker: first list executed, drawing every frame now");
}

/** ISO_MANUAL: save by hand the parts of the immediate context this pass
 *  changes, draw, and put them all back. The last resort, because it is the only
 *  one that cannot be refused by the runtime.
 *
 *  Two different jobs. State we SET has to be saved and restored. State the GAME
 *  may have left bound that would otherwise take part in our draw has to be
 *  cleared as well: a geometry, hull or domain shader left bound would be handed
 *  vertices from our vertex shader, which the runtime answers by dropping the
 *  draw, and a predicate left set could predicate the mark away. Both are
 *  silent, which is the failure this whole feature cannot afford.
 *
 *  Stream output needs neither treatment. It is driven by a geometry shader, or
 *  by a vertex shader created with a stream-output signature; we unbind the
 *  first and never use the second, so buffers the game left bound cannot be
 *  written by our draw. Just as well: SOGetTargets does not return their
 *  offsets, so restoring them faithfully would not be possible.
 *
 *  Three things are deliberately not handled, and they are why this is third
 *  choice rather than first:
 *   - class instances on the game's shaders. Reading them back means passing an
 *     array sized for the per-stage maximum on every present, and only a title
 *     using shader interfaces would ever notice.
 *   - unordered access views bound to the output merger alongside the render
 *     targets: OMSetRenderTargets drops them, and only
 *     OMGetRenderTargetsAndUnorderedAccessViews would see them to put back.
 *   - scissor rectangles, which genuinely need nothing: our rasteriser state has
 *     ScissorEnable off, so the game's rectangles cannot clip our draw, and we
 *     never set any of our own. */
static void drawForensicManual11() {
    Marker& m = g_mark;
    auto c = (ID3D11DeviceContext*)m.ctx11;

    ID3D11RenderTargetView* rtvs[D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT] = {};
    ID3D11DepthStencilView* dsv = nullptr;
    c->lpVtbl->OMGetRenderTargets(c, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, rtvs, &dsv);
    ID3D11BlendState* blend = nullptr;
    FLOAT blendFactor[4] = { 0, 0, 0, 0 };
    UINT sampleMask = 0;
    c->lpVtbl->OMGetBlendState(c, &blend, blendFactor, &sampleMask);
    ID3D11DepthStencilState* depth = nullptr;
    UINT stencilRef = 0;
    c->lpVtbl->OMGetDepthStencilState(c, &depth, &stencilRef);
    ID3D11RasterizerState* raster = nullptr;
    c->lpVtbl->RSGetState(c, &raster);
    // MAX_INDEX + 1, not the OBJECT_COUNT the Windows SDK also defines: mingw's
    // header only has the former, and both headers agree on its value.
    enum { MAX_VIEWPORTS = D3D11_VIEWPORT_AND_SCISSORRECT_MAX_INDEX + 1 };
    D3D11_VIEWPORT viewports[MAX_VIEWPORTS] = {};
    UINT numViewports = MAX_VIEWPORTS;
    c->lpVtbl->RSGetViewports(c, &numViewports, viewports);
    ID3D11VertexShader* vs = nullptr;
    ID3D11PixelShader* ps = nullptr;
    ID3D11GeometryShader* gs = nullptr;
    ID3D11HullShader* hs = nullptr;
    ID3D11DomainShader* ds = nullptr;
    c->lpVtbl->VSGetShader(c, &vs, nullptr, nullptr);
    c->lpVtbl->PSGetShader(c, &ps, nullptr, nullptr);
    c->lpVtbl->GSGetShader(c, &gs, nullptr, nullptr);
    c->lpVtbl->HSGetShader(c, &hs, nullptr, nullptr);
    c->lpVtbl->DSGetShader(c, &ds, nullptr, nullptr);
    ID3D11Buffer* psCb0 = nullptr;
    c->lpVtbl->PSGetConstantBuffers(c, 0, 1, &psCb0);
    ID3D11InputLayout* layout = nullptr;
    c->lpVtbl->IAGetInputLayout(c, &layout);
    D3D11_PRIMITIVE_TOPOLOGY topology = D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED;
    c->lpVtbl->IAGetPrimitiveTopology(c, &topology);
    ID3D11Predicate* predicate = nullptr;
    BOOL predicateValue = FALSE;
    c->lpVtbl->GetPredication(c, &predicate, &predicateValue);

    // The stages our draw must not run through, cleared rather than set.
    c->lpVtbl->GSSetShader(c, nullptr, nullptr, 0);
    c->lpVtbl->HSSetShader(c, nullptr, nullptr, 0);
    c->lpVtbl->DSSetShader(c, nullptr, nullptr, 0);
    c->lpVtbl->SetPredication(c, nullptr, FALSE);

    recordForensicDraw11(c);

    c->lpVtbl->SetPredication(c, predicate, predicateValue);
    c->lpVtbl->DSSetShader(c, ds, nullptr, 0);
    c->lpVtbl->HSSetShader(c, hs, nullptr, 0);
    c->lpVtbl->GSSetShader(c, gs, nullptr, 0);
    c->lpVtbl->PSSetConstantBuffers(c, 0, 1, &psCb0);
    c->lpVtbl->PSSetShader(c, ps, nullptr, 0);
    c->lpVtbl->VSSetShader(c, vs, nullptr, 0);
    c->lpVtbl->IASetPrimitiveTopology(c, topology);
    c->lpVtbl->IASetInputLayout(c, layout);
    c->lpVtbl->RSSetViewports(c, numViewports, viewports);
    c->lpVtbl->RSSetState(c, raster);
    c->lpVtbl->OMSetDepthStencilState(c, depth, stencilRef);
    c->lpVtbl->OMSetBlendState(c, blend, blendFactor, sampleMask);
    c->lpVtbl->OMSetRenderTargets(c, D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, rtvs, dsv);

    // Every Get above returned a reference and every Set took its own, so all of
    // ours go back now. RELEASE tolerates the slots that came back empty.
    for (int i = 0; i < D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT; i++) RELEASE(rtvs[i]);
    RELEASE(dsv);
    RELEASE(blend);
    RELEASE(depth);
    RELEASE(raster);
    RELEASE(vs);
    RELEASE(ps);
    RELEASE(gs);
    RELEASE(hs);
    RELEASE(ds);
    RELEASE(psCb0);
    RELEASE(layout);
    RELEASE(predicate);
}

/** Clear the glyph squares straight onto the back buffer. Unlike D3D12 there is
 *  nothing pre-recorded, so the rectangles are issued every frame - still just
 *  a handful of clears, and in the same batches, since a long rectangle list is
 *  what the D3D12 driver choked on. */
static void markerSubmit11(bool first) {
    Marker& m = g_mark;
    if (g_buildOnly) {
        if (first) logLine("marker: WMPOC_BUILDONLY - view ready but nothing drawn");
        return;
    }

    if (g_forensic) {
        if (first)
            logLine("marker: drawing the forensic pass over %ux%u, isolated with the %s",
                    m.width, m.height, isolationName(m.iso11));
        // The conditions are belt and braces: if a mechanism was chosen but its
        // object somehow is not there, fall through to the manual path, which
        // needs nothing. Skipping the mark or dereferencing null are both worse.
        if (m.iso11 == ISO_STATE && m.ourState11) {
            // One call swaps our whole pipeline state in and hands back the
            // game's; the second puts the game's back. Everything between them
            // is ours, so none of the game's state is touched.
            ID3DDeviceContextState* prev = nullptr;
            m.ctx11->lpVtbl->SwapDeviceContextState(m.ctx11, m.ourState11, &prev);
            recordForensicDraw11((ID3D11DeviceContext*)m.ctx11);
            // Restoring the game's state also drops the reference the swap handed us.
            m.ctx11->lpVtbl->SwapDeviceContextState(m.ctx11, prev, nullptr);
            if (prev) prev->lpVtbl->Release(prev);
        } else if (m.iso11 == ISO_DEFERRED && m.cmdList11) {
            // RestoreContextState=TRUE: the runtime saves the immediate
            // context's state before the list and restores it afterwards, which
            // is the guarantee that makes this an alternative to the state
            // object rather than a way to trample the game's bindings.
            m.ctx11->lpVtbl->ExecuteCommandList(m.ctx11, m.cmdList11, TRUE);
        } else {
            drawForensicManual11();
        }
        if (first) logLine("marker: first forensic pass drawn, marking every frame now");
        return;
    }

    if (first) logLine("marker: clearing %d rects through the immediate context", m.nRects);
    if (g_clearFull) {
        m.ctx11->lpVtbl->ClearView(m.ctx11, (ID3D11View*)m.rtv11, g_magenta, nullptr, 0);
    } else {
        const int batch = rectBatchFor(API_D3D11);
        for (int r = 0; r < m.nRects; r += batch) {
            int n = m.nRects - r < batch ? m.nRects - r : batch;
            m.ctx11->lpVtbl->ClearView(m.ctx11, (ID3D11View*)m.rtv11, g_magenta,
                                       g_rects + r, (UINT)n);
        }
    }
    if (first) logLine("marker: first clear issued, drawing every frame now");
}

/** Called from Present, before forwarding. */
static void markerDraw(IDXGISwapChain* sc) {
    if (!g_draw || g_mark.failed) return;
    if (sc != g_mark.sc || g_mark.api == API_NONE) return;

    EnterCriticalSection(&g_markCs);
    bool ready = g_mark.built;
    if (!ready) {
        ready = markerBuild();
        if (!ready) {
            // Release whatever a partial build created, so a retry starts clean
            // and a latched failure leaves nothing behind.
            markerReleaseBuffers();
            if (g_mark.failed) logLine("marker: presenting unmarked from now on");
        }
    }
    if (ready) {
        // Breadcrumbs around the first submission only: the log is written
        // unbuffered, so if this is what kills the process these lines say so,
        // and a session that dies here leaves the first one behind.
        static LONG firstSubmit = 0;
        bool first = InterlockedCompareExchange(&firstSubmit, 1, 0) == 0;
        if (g_mark.api == API_D3D12) markerSubmit12(first);
        else markerSubmit11(first);
    }
    LeaveCriticalSection(&g_markCs);
}

/** The back buffers are about to be recreated, so our references to them have
 *  to go before ResizeBuffers runs or it will fail. */
static void markerOnResize(IDXGISwapChain* sc) {
    if (sc != g_mark.sc) return;
    EnterCriticalSection(&g_markCs);
    markerReleaseBuffers();
    LeaveCriticalSection(&g_markCs);
}

/** Bind the marker to the first swapchain we see. Swapchain creation is the only
 *  place the game's D3D12 queue or D3D11 device is handed to us, so the
 *  reference is taken here and kept for the process lifetime. */
static void markerBind(IDXGISwapChain* sc, IUnknown* device) {
    if (!g_draw || !sc || !device) return;

    int api = API_NONE;
    ID3D12CommandQueue* q = nullptr;
    ID3D11Device* d11 = nullptr;
    if (SUCCEEDED(device->lpVtbl->QueryInterface(device, IID_ID3D12CommandQueue, (void**)&q)) && q)
        api = API_D3D12;
    else if (SUCCEEDED(device->lpVtbl->QueryInterface(device, IID_ID3D11Device, (void**)&d11)) && d11)
        api = API_D3D11;
    else
        return;   // neither: some other runtime, leave the game alone

    EnterCriticalSection(&g_markCs);
    if (g_mark.sc) {
        logLine("marker: a second swapchain was created; it will present unmarked");
        if (q) q->lpVtbl->Release(q);
        if (d11) d11->lpVtbl->Release(d11);
    } else {
        g_mark.sc = sc;
        g_mark.api = api;
        g_mark.queue = q;
        g_mark.dev11 = d11;
        logLine("marker: bound to swapchain %p on D3D%d %s %p", (void*)sc, api,
                api == API_D3D12 ? "command queue" : "device",
                q ? (void*)q : (void*)d11);
    }
    LeaveCriticalSection(&g_markCs);
}

// ---------------- swapchain hooks ----------------

static HRESULT STDMETHODCALLTYPE hkPresent(IDXGISwapChain* self, UINT SyncInterval, UINT Flags) {
    // Always found: the hook table entry is published before the vtable is
    // patched, so anything that can reach this has an entry to forward through.
    const SwapChainHooks* h = swapChainHooks(self->lpVtbl);
    if (!h) return E_FAIL;

    if (InterlockedCompareExchange(&g_firstPresentLogged, 1, 0) == 0) {
        DXGI_SWAP_CHAIN_DESC d;
        char fb[48];
        if (SUCCEEDED(self->lpVtbl->GetDesc(self, &d)))
            logLine("first Present: %ux%u %s buffers=%u windowed=%d swapEffect=%d flags=0x%x",
                    d.BufferDesc.Width, d.BufferDesc.Height,
                    formatName(d.BufferDesc.Format, fb, sizeof(fb)),
                    d.BufferCount, (int)d.Windowed, (int)d.SwapEffect, d.Flags);
        logColorSpace(self);
        logLoadedGraphicsModules();
    }

    // One thread claims each rate window by swapping its start forward, so a
    // game presenting from several threads logs one line per window, not one
    // per thread.
    LONG count = InterlockedIncrement(&g_presents);
    LONGLONG start = g_windowStart;
    LONGLONG now = (LONGLONG)GetTickCount64();
    if (now - start >= 5000 &&
        InterlockedCompareExchange64(&g_windowStart, now, start) == start) {
        LONG base = InterlockedExchange(&g_windowBase, count);
        double fps = (count - base) * 1000.0 / (double)(now - start);
        // Only this thread is in here for a given window, so these are safe.
        // Log while the rate is still settling after launch, then only when it
        // moves by more than a tenth - a steady session should say so once,
        // not every five seconds for as long as it runs.
        static int windows = 0;
        static double logged = 0.0;
        bool settling = ++windows <= 4;
        if (settling || fps < logged * 0.9 || fps > logged * 1.1) {
            logLine("present rate %.1f/s (%ld total, sync=%u flags=0x%x)",
                    fps, (long)count, SyncInterval, Flags);
            logged = fps;
        }
    }
    markerDraw(self);
    return h->Present(self, SyncInterval, Flags);
}

static HRESULT STDMETHODCALLTYPE hkPresent1(IDXGISwapChain1* self, UINT SyncInterval,
                                            UINT Flags, const DXGI_PRESENT_PARAMETERS* params) {
    const SwapChainHooks* h = swapChainHooks(self->lpVtbl);
    if (!h) return E_FAIL;
    if (InterlockedCompareExchange(&g_present1Logged, 1, 0) == 0)
        logLine("game uses Present1 (dirty rects=%u)", params ? params->DirtyRectsCount : 0);
    markerDraw((IDXGISwapChain*)self);
    return h->Present1(self, SyncInterval, Flags, params);
}

static HRESULT STDMETHODCALLTYPE hkResizeBuffers(IDXGISwapChain* self, UINT BufferCount,
                                                 UINT Width, UINT Height,
                                                 DXGI_FORMAT NewFormat, UINT SwapChainFlags) {
    const SwapChainHooks* h = swapChainHooks(self->lpVtbl);
    if (!h) return E_FAIL;
    char fb[48];
    logLine("ResizeBuffers %ux%u %s buffers=%u flags=0x%x",
            Width, Height, formatName(NewFormat, fb, sizeof(fb)), BufferCount, SwapChainFlags);
    markerOnResize(self);
    return h->ResizeBuffers(self, BufferCount, Width, Height, NewFormat, SwapChainFlags);
}

static void hookSwapChain(IDXGISwapChain* sc) {
    if (!sc) return;
    EnterCriticalSection(&g_patchCs);
    if (!swapChainHooks(sc->lpVtbl)) {
        LONG i = g_swapchainCount;
        if (i >= MAX_VTABLES) {
            logLine("WARNING more than %d swapchain vtables; not hooking this one", MAX_VTABLES);
        } else {
            auto vt = (IDXGISwapChainVtbl*)sc->lpVtbl;
            SwapChainHooks& h = g_swapchains[i];
            h.Present = vt->Present;
            h.ResizeBuffers = vt->ResizeBuffers;
            h.Present1 = nullptr;

            // QueryInterface returns the same object and so the same vtable; it
            // only tells us whether the IDXGISwapChain1 slots are really there.
            IDXGISwapChain1Vtbl* vt1 = nullptr;
            void* p = nullptr;
            if (SUCCEEDED(sc->lpVtbl->QueryInterface(sc, IID_IDXGISwapChain1, &p)) && p) {
                auto sc1 = (IDXGISwapChain1*)p;
                auto cand = (IDXGISwapChain1Vtbl*)sc1->lpVtbl;
                sc1->lpVtbl->Release(sc1);
                if ((void*)cand == (void*)vt) { vt1 = cand; h.Present1 = cand->Present1; }
            }

            // Publish the entry, with the originals in it, BEFORE patching the
            // vtable: a present arriving on another thread must either still go
            // straight to the original or find this entry to forward through.
            h.vtbl = vt;
            InterlockedIncrement(&g_swapchainCount);
            g_windowStart = (LONGLONG)GetTickCount64();
            patchSlot(&vt->Present, (PFN_Present)&hkPresent);
            patchSlot(&vt->ResizeBuffers, (PFN_ResizeBuffers)&hkResizeBuffers);
            if (vt1) patchSlot(&vt1->Present1, (PFN_Present1)&hkPresent1);
            logLine("hooked swapchain vtable %p (Present%s, ResizeBuffers)",
                    (void*)vt, vt1 ? ", Present1" : "");
        }
    }
    LeaveCriticalSection(&g_patchCs);
}

// ---------------- factory hooks ----------------

static HRESULT STDMETHODCALLTYPE hkCreateSwapChain(IDXGIFactory* self, IUnknown* device,
                                                   DXGI_SWAP_CHAIN_DESC* desc,
                                                   IDXGISwapChain** out) {
    const FactoryHooks* h = factoryHooks(self->lpVtbl);
    if (!h) return E_FAIL;
    HRESULT hr = h->CreateSwapChain(self, device, desc, out);
    char fb[48];
    if (desc)
        logLine("CreateSwapChain %s %ux%u %s buffers=%u windowed=%d hr=0x%lx",
                deviceApi(device), desc->BufferDesc.Width, desc->BufferDesc.Height,
                formatName(desc->BufferDesc.Format, fb, sizeof(fb)), desc->BufferCount,
                (int)desc->Windowed, hr);
    if (SUCCEEDED(hr) && out) { hookSwapChain(*out); markerBind(*out, device); }
    return hr;
}

static HRESULT STDMETHODCALLTYPE hkCreateSwapChainForHwnd(
        IDXGIFactory2* self, IUnknown* device, HWND hwnd,
        const DXGI_SWAP_CHAIN_DESC1* desc, const DXGI_SWAP_CHAIN_FULLSCREEN_DESC* fs,
        IDXGIOutput* restrictTo, IDXGISwapChain1** out) {
    const FactoryHooks* h = factoryHooks(self->lpVtbl);
    if (!h) return E_FAIL;
    HRESULT hr = h->CreateSwapChainForHwnd(self, device, hwnd, desc, fs, restrictTo, out);
    char fb[48];
    if (desc)
        logLine("CreateSwapChainForHwnd %s %ux%u %s buffers=%u scaling=%d swapEffect=%d "
                "alpha=%d flags=0x%x hwnd=%p hr=0x%lx",
                deviceApi(device), desc->Width, desc->Height,
                formatName(desc->Format, fb, sizeof(fb)),
                desc->BufferCount, (int)desc->Scaling, (int)desc->SwapEffect,
                (int)desc->AlphaMode, desc->Flags, (void*)hwnd, hr);
    if (SUCCEEDED(hr) && out) {
        hookSwapChain((IDXGISwapChain*)*out);
        markerBind((IDXGISwapChain*)*out, device);
    }
    return hr;
}

static void hookFactory(void* factory, const char* via) {
    auto f = (IDXGIFactory*)factory;
    EnterCriticalSection(&g_patchCs);
    if (!factoryHooks(f->lpVtbl)) {
        LONG i = g_factoryCount;
        if (i >= MAX_VTABLES) {
            logLine("WARNING more than %d factory vtables; not hooking this one", MAX_VTABLES);
        } else {
            auto vt = (IDXGIFactoryVtbl*)f->lpVtbl;
            FactoryHooks& h = g_factories[i];
            h.CreateSwapChain = vt->CreateSwapChain;
            h.CreateSwapChainForHwnd = nullptr;

            IDXGIFactory2Vtbl* vt2 = nullptr;
            void* p = nullptr;
            if (SUCCEEDED(f->lpVtbl->QueryInterface(f, IID_IDXGIFactory2, &p)) && p) {
                auto f2 = (IDXGIFactory2*)p;
                auto cand = (IDXGIFactory2Vtbl*)f2->lpVtbl;
                f2->lpVtbl->Release(f2);
                if ((void*)cand == (void*)vt) {
                    vt2 = cand;
                    h.CreateSwapChainForHwnd = cand->CreateSwapChainForHwnd;
                }
            }

            // As in hookSwapChain: publish the originals before the hooks can
            // be reached.
            h.vtbl = vt;
            InterlockedIncrement(&g_factoryCount);
            patchSlot(&vt->CreateSwapChain, (PFN_CreateSwapChain)&hkCreateSwapChain);
            if (vt2) patchSlot(&vt2->CreateSwapChainForHwnd,
                               (PFN_CreateSwapChainForHwnd)&hkCreateSwapChainForHwnd);
            logLine("hooked factory vtable %p from %s (CreateSwapChain%s)", (void*)vt, via,
                    vt2 ? ", CreateSwapChainForHwnd" : "");
        }
    }
    LeaveCriticalSection(&g_patchCs);
}

// ---------------- intercepted exports ----------------
// The only exports with a hand-written body: they are how the proxy reaches a
// real factory vtable. When disabled they are a plain forward.

extern "C" HRESULT WINAPI CreateDXGIFactory(REFIID riid, void** out) {
    typedef HRESULT (WINAPI *Fn)(REFIID, void**);
    HRESULT hr = ((Fn)g_realCreateDXGIFactory)(riid, out);
    if (g_enabled && SUCCEEDED(hr) && out && *out) hookFactory(*out, "CreateDXGIFactory");
    return hr;
}

extern "C" HRESULT WINAPI CreateDXGIFactory1(REFIID riid, void** out) {
    typedef HRESULT (WINAPI *Fn)(REFIID, void**);
    HRESULT hr = ((Fn)g_realCreateDXGIFactory1)(riid, out);
    if (g_enabled && SUCCEEDED(hr) && out && *out) hookFactory(*out, "CreateDXGIFactory1");
    return hr;
}

extern "C" HRESULT WINAPI CreateDXGIFactory2(UINT flags, REFIID riid, void** out) {
    typedef HRESULT (WINAPI *Fn)(UINT, REFIID, void**);
    HRESULT hr = ((Fn)g_realCreateDXGIFactory2)(flags, riid, out);
    if (g_enabled && SUCCEEDED(hr) && out && *out) hookFactory(*out, "CreateDXGIFactory2");
    return hr;
}

// ---------------- init ----------------

static bool envIs(const char* name, const char* want) {
    char v[64];
    DWORD n = GetEnvironmentVariableA(name, v, sizeof(v));
    return n > 0 && n < sizeof(v) && lstrcmpA(v, want) == 0;
}

static void logEnvironment() {
    static const char* keys[] = { "ENABLE_WMPOC", "WMPOC_ALPHA", "WMPOC_TEXT", "WMPOC_LOG",
                                  "WMPOC_ISOLATION" };
    char v[256];
    for (int i = 0; i < (int)(sizeof(keys) / sizeof(keys[0])); i++) {
        DWORD n = GetEnvironmentVariableA(keys[i], v, sizeof(v));
        if (n > 0 && n < sizeof(v)) logLine("env %s=%s", keys[i], v);
    }
    // Only a prefix of the seed: it is what identifies the session, and anyone
    // holding it could reproduce and subtract the mark. 8 characters is enough
    // to tell which seed arrived, and short of the 16 the pattern derives from.
    DWORD n = GetEnvironmentVariableA("WMPOC_SEED", v, sizeof(v));
    if (n > 0 && n < sizeof(v))
        logLine("env WMPOC_SEED=%.8s... (%lu chars)", v, n);
}

static void initProxy(HMODULE self) {
    InitializeCriticalSection(&g_logCs);
    InitializeCriticalSection(&g_patchCs);
    InitializeCriticalSection(&g_markCs);

    g_enabled = envIs("ENABLE_WMPOC", "1") && !envIs("DISABLE_WMPOC", "1");
    g_draw = !envIs("WMPOC_NODRAW", "1");
    g_buildOnly = envIs("WMPOC_BUILDONLY", "1");
    g_clearFull = envIs("WMPOC_CLEARFULL", "1");
    char batch[16];
    DWORD bl = GetEnvironmentVariableA("WMPOC_RECTBATCH", batch, sizeof(batch));
    if (bl > 0 && bl < sizeof(batch)) {
        int v = atoi(batch);
        if (v >= 1 && v <= WM_TEXT_MAX_RECTS) g_rectBatch = v;
    }
    // Pins one of the three isolation mechanisms instead of trying them in
    // order. Parsed here with the rest, but anything to say about it has to wait
    // until the log is open, below.
    char iso[16];
    DWORD isoLen = GetEnvironmentVariableA("WMPOC_ISOLATION", iso, sizeof(iso));
    bool isoGiven = isoLen > 0 && isoLen < sizeof(iso);
    if (isoGiven) {
        if (lstrcmpA(iso, "state") == 0) g_isolation = ISO_STATE;
        else if (lstrcmpA(iso, "deferred") == 0) g_isolation = ISO_DEFERRED;
        else if (lstrcmpA(iso, "manual") == 0) g_isolation = ISO_MANUAL;
    }
    char seed[64];
    DWORD seedLen = GetEnvironmentVariableA("WMPOC_SEED", seed, sizeof(seed));
    bool seedGiven = seedLen > 0 && seedLen < sizeof(seed);
    if (seedGiven && parseSeed(seed, &g_constants.seedLo, &g_constants.seedHi)) {
        g_forensic = true;
        g_constants.tile = WM_TILE_SIZE;
        g_constants.alpha = 3.0f;   // the layer's default; the console passes 8
        char av[32];
        DWORD an = GetEnvironmentVariableA("WMPOC_ALPHA", av, sizeof(av));
        if (an > 0 && an < sizeof(av)) {
            double v = atof(av);
            if (v > 0.0) g_constants.alpha = (float)v;
        }
    }
    if (g_enabled) openLog();

    // The system copy has the same base name as this DLL, so it is loaded by
    // absolute path. Done here, under the loader lock, because an export can be
    // called the moment this returns; it is the standard proxy-DLL trade-off and
    // is safe for a system DLL whose own dependencies are already loaded.
    char path[MAX_PATH];
    UINT n = GetSystemDirectoryA(path, MAX_PATH);
    if (n == 0 || n > MAX_PATH - 16) return;
    lstrcatA(path, "\\dxgi.dll");
    HMODULE real = LoadLibraryA(path);
    if (!real || real == self) {
        // Nothing can be forwarded, so the game is about to misbehave. Worth
        // breaking the "silent when disabled" rule to say why.
        if (!g_enabled) openLog();
        logLine("FATAL could not load %s (handle=%p self=%p)", path, (void*)real, (void*)self);
        return;
    }
    for (int i = 0; i < g_forwardCount; i++) {
        void* fn = (void*)GetProcAddress(real, g_forwards[i].name);
        if (fn) *g_forwards[i].slot = fn;
        else logLine("WARNING %s not found in %s", g_forwards[i].name, path);
    }

    if (!g_enabled) return;

    char exe[MAX_PATH] = "";
    GetModuleFileNameA(nullptr, exe, sizeof(exe));
    char me[MAX_PATH] = "";
    GetModuleFileNameA(self, me, sizeof(me));
    logLine("---- loaded ----");
    logLine("process %s (pid %lu)", exe, GetCurrentProcessId());
    logLine("proxy %s", me);
    logLine("system dxgi %s", path);
    logEnvironment();
    if (!g_draw)
        logLine("mode: WMPOC_NODRAW - forward, hook and log only, exactly like the probe build");
    else if (g_buildOnly)
        logLine("mode: WMPOC_BUILDONLY - record the marking lists but never submit them");
    else if (g_forensic)
        logLine("mode: forensic, seed %08x%08x, tile %u, alpha %.2f",
                g_constants.seedLo, g_constants.seedHi, g_constants.tile,
                (double)g_constants.alpha);
    else if (seedGiven)
        logLine("mode: visible - WMPOC_SEED was set but did not parse as 32 hex"
                " characters, so forensic mode is OFF");
    else
        logLine("mode: visible (D3D11 and D3D12)");
    if (g_isolation != ISO_AUTO)
        logLine("mode: D3D11 forensic isolation pinned to the %s", isolationName(g_isolation));
    else if (isoGiven)
        logLine("mode: WMPOC_ISOLATION is not one of state, deferred or manual, so the"
                " isolation is chosen automatically");
    auditExports(real);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        initProxy((HMODULE)inst);
    }
    return TRUE;
}
