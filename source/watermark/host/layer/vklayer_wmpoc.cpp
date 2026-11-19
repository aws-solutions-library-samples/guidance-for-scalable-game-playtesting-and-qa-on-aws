// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
// From the Amazon GameLift Streams forensic watermarking sample; see source/watermark/NOTICE.md.
// vklayer_wmpoc.cpp - Vulkan layer for the GameLift Streams watermark POC.
//
// Two modes, selected per session by env vars, both drawn into the swapchain
// image at vkQueuePresentKHR (before the capture layer encodes it):
//   * forensic (WMPOC_SEED set): an invisible-ish spread-spectrum luma mark - a
//     tiled +/-1 pattern keyed by the session seed, added to the image by a
//     fullscreen additive-blend pass. The hash matches the verifier (source/lambdas/PlayTestVerifyWatermark/handler.py)
//     and the verifier Lambda so a captured frame can be identified.
//   * visible text (no seed): large magenta text (session id / WMPOC_TEXT) via
//     vkCmdClearAttachments. Debugging / deterrent.
//
// Ordered ABOVE Amazon's capture layer via XDG_CONFIG_DIRS (see the README, Enabling Forensic Watermarking).

#include <vulkan/vulkan.h>
#include <vulkan/vk_layer.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdint>
#include <cmath>
#include <string>
#include <mutex>
#include <unordered_map>
#include <map>
#include <vector>
#include <memory>
#include <dirent.h>
#include "../common/wm_text.h"   // shared with the Windows DXGI proxy
#include "shaders_spv.h"    // generated at build: vert_spv[]/vert_spv_len, frag_spv[]/frag_spv_len

#ifndef VK_LAYER_EXPORT
#define VK_LAYER_EXPORT __attribute__((visibility("default")))
#endif

#define WMLOG(...) do { fprintf(stderr, "wmpoc: " __VA_ARGS__); fprintf(stderr, "\n"); fflush(stderr); } while(0)

static const uint32_t TILE_SIZE = 256;
struct PushConstants { uint32_t seedLo, seedHi, tile; float alpha; };

static std::mutex g_lock;
static inline void* DKey(const void* obj) { return *(void* const*)obj; }

// first 8 bytes of the 128-bit hex seed -> two big-endian uint32 (matches
// seed_words() in the verifier's handler.py)
static bool parseSeed(const char* hex, uint32_t& lo, uint32_t& hi) {
    if (!hex || strlen(hex) < 16) return false;
    auto hv = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        c |= 32; if (c >= 'a' && c <= 'f') return c - 'a' + 10; return -1;
    };
    uint8_t b[8];
    for (int i = 0; i < 8; i++) {
        int h = hv(hex[2*i]), l = hv(hex[2*i+1]);
        if (h < 0 || l < 0) return false;
        b[i] = (uint8_t)((h << 4) | l);
    }
    lo = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    hi = (b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7];
    return true;
}

struct InstanceData {
    PFN_vkGetInstanceProcAddr gipa = nullptr;
    PFN_vkDestroyInstance DestroyInstance = nullptr;
};

struct SwapchainInfo {
    VkFormat format = VK_FORMAT_UNDEFINED;
    VkExtent2D extent = {0, 0};
    std::vector<VkImage> images;
    VkRenderPass renderPass = VK_NULL_HANDLE;
    std::vector<VkImageView> views;
    std::vector<VkFramebuffer> fbs;
    std::vector<VkCommandBuffer> cmds;
    std::vector<VkSemaphore> sems;
    VkCommandPool pool = VK_NULL_HANDLE;
    uint32_t family = UINT32_MAX;   // queue family the command buffers were allocated for
    bool failed = false;            // build failed once; never mark this swapchain again
    bool warnedFamily = false;
    VkPipeline pipeline = VK_NULL_HANDLE;        // forensic
    VkDescriptorPool descPool = VK_NULL_HANDLE;  // forensic
    std::vector<VkDescriptorSet> descSets;       // forensic, per image
    bool built = false;
};

struct DeviceData {
    // Guards this device's maps only. It is never held across a downstream
    // Vulkan call: vkQueuePresentKHR and vkDeviceWaitIdle block, and holding a
    // lock across them serialises the application's render threads and can
    // deadlock against the capture layer below us.
    std::mutex lock;
    VkDevice device = VK_NULL_HANDLE;
    PFN_vkGetDeviceProcAddr gdpa = nullptr;
    PFN_vkDestroyDevice DestroyDevice = nullptr;
    PFN_vkCreateSwapchainKHR CreateSwapchainKHR = nullptr;
    PFN_vkDestroySwapchainKHR DestroySwapchainKHR = nullptr;
    PFN_vkGetSwapchainImagesKHR GetSwapchainImagesKHR = nullptr;
    PFN_vkQueuePresentKHR QueuePresentKHR = nullptr;
    PFN_vkGetDeviceQueue GetDeviceQueue = nullptr;
    PFN_vkCreateCommandPool CreateCommandPool = nullptr;
    PFN_vkAllocateCommandBuffers AllocateCommandBuffers = nullptr;
    PFN_vkBeginCommandBuffer BeginCommandBuffer = nullptr;
    PFN_vkEndCommandBuffer EndCommandBuffer = nullptr;
    PFN_vkCmdBeginRenderPass CmdBeginRenderPass = nullptr;
    PFN_vkCmdEndRenderPass CmdEndRenderPass = nullptr;
    PFN_vkCmdClearAttachments CmdClearAttachments = nullptr;
    PFN_vkCreateRenderPass CreateRenderPass = nullptr;
    PFN_vkCreateImageView CreateImageView = nullptr;
    PFN_vkCreateFramebuffer CreateFramebuffer = nullptr;
    PFN_vkCreateSemaphore CreateSemaphore = nullptr;
    PFN_vkQueueSubmit QueueSubmit = nullptr;
    PFN_vkDeviceWaitIdle DeviceWaitIdle = nullptr;
    PFN_vkDestroyFramebuffer DestroyFramebuffer = nullptr;
    PFN_vkDestroyImageView DestroyImageView = nullptr;
    PFN_vkDestroyRenderPass DestroyRenderPass = nullptr;
    PFN_vkDestroySemaphore DestroySemaphore = nullptr;
    PFN_vkFreeCommandBuffers FreeCommandBuffers = nullptr;
    // forensic pipeline PFNs
    PFN_vkCreateShaderModule CreateShaderModule = nullptr;
    PFN_vkDestroyShaderModule DestroyShaderModule = nullptr;
    PFN_vkCreateDescriptorSetLayout CreateDescriptorSetLayout = nullptr;
    PFN_vkDestroyDescriptorSetLayout DestroyDescriptorSetLayout = nullptr;
    PFN_vkCreateDescriptorPool CreateDescriptorPool = nullptr;
    PFN_vkDestroyDescriptorPool DestroyDescriptorPool = nullptr;
    PFN_vkAllocateDescriptorSets AllocateDescriptorSets = nullptr;
    PFN_vkUpdateDescriptorSets UpdateDescriptorSets = nullptr;
    PFN_vkCreatePipelineLayout CreatePipelineLayout = nullptr;
    PFN_vkDestroyPipelineLayout DestroyPipelineLayout = nullptr;
    PFN_vkCreateGraphicsPipelines CreateGraphicsPipelines = nullptr;
    PFN_vkDestroyPipeline DestroyPipeline = nullptr;
    PFN_vkCmdBindPipeline CmdBindPipeline = nullptr;
    PFN_vkCmdBindDescriptorSets CmdBindDescriptorSets = nullptr;
    PFN_vkCmdPushConstants CmdPushConstants = nullptr;
    PFN_vkCmdDraw CmdDraw = nullptr;

    std::unordered_map<VkQueue, uint32_t> queueFamily;
    std::map<uint32_t, VkCommandPool> familyPool;
    std::unordered_map<VkSwapchainKHR, SwapchainInfo> swapchains;

    // mode
    bool forensic = false;
    uint32_t seedLo = 0, seedHi = 0;
    float alpha = 3.0f;
    // device-level forensic objects (created once)
    bool fInit = false;
    VkShaderModule vsMod = VK_NULL_HANDLE, fsMod = VK_NULL_HANDLE;
    VkDescriptorSetLayout setLayout = VK_NULL_HANDLE;
    VkPipelineLayout pipeLayout = VK_NULL_HANDLE;
};

static std::unordered_map<void*, InstanceData> g_instances;
static std::unordered_map<void*, std::unique_ptr<DeviceData>> g_devices;

/** Look up the device record. g_lock is held only for the lookup itself; the
 *  returned pointer stays valid because the map owns the record and unordered_map
 *  never moves its elements. */
static DeviceData* devData(void* dispatchable) {
    std::lock_guard<std::mutex> g(g_lock);
    auto it = g_devices.find(DKey(dispatchable));
    return it == g_devices.end() ? nullptr : it->second.get();
}

template <typename T>
static T chainInfo(const void* pCreateInfo, VkStructureType type, VkLayerFunction func) {
    auto p = (const VkBaseInStructure*)pCreateInfo;
    while (p) {
        if (p->sType == type && ((const T)p)->function == func) return (T)p;
        p = p->pNext;
    }
    return nullptr;
}

// ---------------- instance ----------------
static VKAPI_ATTR VkResult VKAPI_CALL wmpoc_CreateInstance(
    const VkInstanceCreateInfo* pCreateInfo, const VkAllocationCallbacks* pAllocator, VkInstance* pInstance) {
    auto li = chainInfo<VkLayerInstanceCreateInfo*>(pCreateInfo, VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO, VK_LAYER_LINK_INFO);
    if (!li) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr nextGIPA = li->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    li->u.pLayerInfo = li->u.pLayerInfo->pNext;
    auto createInstance = (PFN_vkCreateInstance)nextGIPA(VK_NULL_HANDLE, "vkCreateInstance");
    VkResult r = createInstance(pCreateInfo, pAllocator, pInstance);
    if (r != VK_SUCCESS) return r;
    std::lock_guard<std::mutex> g(g_lock);
    InstanceData id;
    id.gipa = nextGIPA;
    id.DestroyInstance = (PFN_vkDestroyInstance)nextGIPA(*pInstance, "vkDestroyInstance");
    g_instances[DKey(*pInstance)] = id;
    WMLOG("vkCreateInstance intercepted");
    return VK_SUCCESS;
}

static VKAPI_ATTR void VKAPI_CALL wmpoc_DestroyInstance(VkInstance instance, const VkAllocationCallbacks* pAllocator) {
    PFN_vkDestroyInstance destroy = nullptr;
    {
        std::lock_guard<std::mutex> g(g_lock);
        auto it = g_instances.find(DKey(instance));
        if (it != g_instances.end()) { destroy = it->second.DestroyInstance; g_instances.erase(it); }
    }
    if (destroy) destroy(instance, pAllocator);
}

// ---------------- device ----------------
static VKAPI_ATTR VkResult VKAPI_CALL wmpoc_CreateDevice(
    VkPhysicalDevice physicalDevice, const VkDeviceCreateInfo* pCreateInfo,
    const VkAllocationCallbacks* pAllocator, VkDevice* pDevice) {
    auto li = chainInfo<VkLayerDeviceCreateInfo*>(pCreateInfo, VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO, VK_LAYER_LINK_INFO);
    if (!li) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr gipa = li->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    PFN_vkGetDeviceProcAddr gdpa = li->u.pLayerInfo->pfnNextGetDeviceProcAddr;
    li->u.pLayerInfo = li->u.pLayerInfo->pNext;
    auto createDevice = (PFN_vkCreateDevice)gipa(VK_NULL_HANDLE, "vkCreateDevice");
    VkResult r = createDevice(physicalDevice, pCreateInfo, pAllocator, pDevice);
    if (r != VK_SUCCESS) return r;

    auto owned = std::make_unique<DeviceData>();
    DeviceData& dd = *owned;
    dd.device = *pDevice;
    dd.gdpa = gdpa;
#define LOAD(name) dd.name = (PFN_vk##name)gdpa(*pDevice, "vk" #name)
    LOAD(DestroyDevice); LOAD(CreateSwapchainKHR); LOAD(DestroySwapchainKHR);
    LOAD(GetSwapchainImagesKHR); LOAD(QueuePresentKHR); LOAD(GetDeviceQueue);
    LOAD(CreateCommandPool); LOAD(AllocateCommandBuffers); LOAD(BeginCommandBuffer);
    LOAD(EndCommandBuffer); LOAD(CmdBeginRenderPass); LOAD(CmdEndRenderPass);
    LOAD(CmdClearAttachments); LOAD(CreateRenderPass); LOAD(CreateImageView);
    LOAD(CreateFramebuffer); LOAD(CreateSemaphore); LOAD(QueueSubmit);
    LOAD(DeviceWaitIdle); LOAD(DestroyFramebuffer); LOAD(DestroyImageView);
    LOAD(DestroyRenderPass); LOAD(DestroySemaphore); LOAD(FreeCommandBuffers);
    LOAD(CreateShaderModule); LOAD(DestroyShaderModule); LOAD(CreateDescriptorSetLayout);
    LOAD(DestroyDescriptorSetLayout); LOAD(CreateDescriptorPool); LOAD(DestroyDescriptorPool);
    LOAD(AllocateDescriptorSets); LOAD(UpdateDescriptorSets); LOAD(CreatePipelineLayout);
    LOAD(DestroyPipelineLayout); LOAD(CreateGraphicsPipelines); LOAD(DestroyPipeline);
    LOAD(CmdBindPipeline); LOAD(CmdBindDescriptorSets); LOAD(CmdPushConstants); LOAD(CmdDraw);
#undef LOAD

    const char* seed = getenv("WMPOC_SEED");
    if (parseSeed(seed, dd.seedLo, dd.seedHi)) {
        dd.forensic = true;
        const char* av = getenv("WMPOC_ALPHA");
        if (av && *av) dd.alpha = (float)atof(av);
        WMLOG("forensic mode: seedLo=%08x seedHi=%08x alpha=%.2f", dd.seedLo, dd.seedHi, dd.alpha);
    } else {
        WMLOG("visible-text mode (no WMPOC_SEED)");
    }

    for (uint32_t i = 0; i < pCreateInfo->queueCreateInfoCount; i++) {
        const auto& qci = pCreateInfo->pQueueCreateInfos[i];
        for (uint32_t q = 0; q < qci.queueCount; q++) {
            VkQueue queue = VK_NULL_HANDLE;
            dd.GetDeviceQueue(*pDevice, qci.queueFamilyIndex, q, &queue);
            if (queue) dd.queueFamily[queue] = qci.queueFamilyIndex;
        }
    }

    {
        std::lock_guard<std::mutex> g(g_lock);
        g_devices[DKey(*pDevice)] = std::move(owned);
    }
    WMLOG("vkCreateDevice intercepted (%u queue families)", pCreateInfo->queueCreateInfoCount);
    return VK_SUCCESS;
}

static VKAPI_ATTR void VKAPI_CALL wmpoc_DestroyDevice(VkDevice device, const VkAllocationCallbacks* pAllocator) {
    std::unique_ptr<DeviceData> owned;
    {
        std::lock_guard<std::mutex> g(g_lock);
        auto it = g_devices.find(DKey(device));
        if (it != g_devices.end()) { owned = std::move(it->second); g_devices.erase(it); }
    }
    if (owned) {
        DeviceData& dd = *owned;
        if (dd.fInit) {
            if (dd.pipeLayout) dd.DestroyPipelineLayout(device, dd.pipeLayout, nullptr);
            if (dd.setLayout) dd.DestroyDescriptorSetLayout(device, dd.setLayout, nullptr);
            if (dd.vsMod) dd.DestroyShaderModule(device, dd.vsMod, nullptr);
            if (dd.fsMod) dd.DestroyShaderModule(device, dd.fsMod, nullptr);
        }
        if (dd.DestroyDevice) dd.DestroyDevice(device, pAllocator);
    }
}

static VKAPI_ATTR VkResult VKAPI_CALL wmpoc_CreateSwapchainKHR(
    VkDevice device, const VkSwapchainCreateInfoKHR* pCreateInfo,
    const VkAllocationCallbacks* pAllocator, VkSwapchainKHR* pSwapchain) {
    DeviceData* dd = devData(device);
    if (!dd) return VK_ERROR_INITIALIZATION_FAILED;
    VkSwapchainCreateInfoKHR ci = *pCreateInfo;
    ci.imageUsage |= VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;   // only; GLS surface rejects others
    VkResult r = dd->CreateSwapchainKHR(device, &ci, pAllocator, pSwapchain);
    if (r != VK_SUCCESS) return r;
    SwapchainInfo sc;
    sc.format = pCreateInfo->imageFormat;
    sc.extent = pCreateInfo->imageExtent;
    {
        std::lock_guard<std::mutex> g(dd->lock);
        dd->swapchains[*pSwapchain] = sc;
    }
    WMLOG("vkCreateSwapchainKHR %ux%u fmt=%d forensic=%d", sc.extent.width, sc.extent.height, (int)sc.format, dd->forensic);
    return VK_SUCCESS;
}

static void freeSwapchainResources(DeviceData* dd, VkDevice device, SwapchainInfo& sc) {
    for (auto s : sc.sems) if (s) dd->DestroySemaphore(device, s, nullptr);
    for (auto f : sc.fbs)  if (f) dd->DestroyFramebuffer(device, f, nullptr);
    for (auto v : sc.views) if (v) dd->DestroyImageView(device, v, nullptr);
    if (!sc.cmds.empty() && sc.pool) dd->FreeCommandBuffers(device, sc.pool, (uint32_t)sc.cmds.size(), sc.cmds.data());
    if (sc.pipeline) dd->DestroyPipeline(device, sc.pipeline, nullptr);
    if (sc.descPool) dd->DestroyDescriptorPool(device, sc.descPool, nullptr);  // frees its sets
    if (sc.renderPass) dd->DestroyRenderPass(device, sc.renderPass, nullptr);
    sc.sems.clear(); sc.fbs.clear(); sc.views.clear(); sc.cmds.clear(); sc.descSets.clear();
    sc.pipeline = VK_NULL_HANDLE; sc.descPool = VK_NULL_HANDLE;
    sc.renderPass = VK_NULL_HANDLE; sc.built = false;
}

static VKAPI_ATTR void VKAPI_CALL wmpoc_DestroySwapchainKHR(
    VkDevice device, VkSwapchainKHR swapchain, const VkAllocationCallbacks* pAllocator) {
    DeviceData* dd = devData(device);
    if (!dd) return;

    // Take the record out of the map first, so no present can pick it up again,
    // then wait and free with no lock held: vkDeviceWaitIdle blocks.
    bool had = false;
    SwapchainInfo sc;
    {
        std::lock_guard<std::mutex> g(dd->lock);
        auto it = dd->swapchains.find(swapchain);
        if (it != dd->swapchains.end()) { sc = std::move(it->second); dd->swapchains.erase(it); had = true; }
    }
    if (had) {
        if (dd->DeviceWaitIdle) dd->DeviceWaitIdle(device);   // waits out any in flight mark
        freeSwapchainResources(dd, device, sc);
    }
    dd->DestroySwapchainKHR(device, swapchain, pAllocator);
}

static VKAPI_ATTR VkResult VKAPI_CALL wmpoc_GetSwapchainImagesKHR(
    VkDevice device, VkSwapchainKHR swapchain, uint32_t* pCount, VkImage* pImages) {
    DeviceData* dd = devData(device);
    if (!dd) return VK_ERROR_INITIALIZATION_FAILED;
    VkResult r = dd->GetSwapchainImagesKHR(device, swapchain, pCount, pImages);
    if (r == VK_SUCCESS && pImages) {
        std::lock_guard<std::mutex> g(dd->lock);
        auto& sc = dd->swapchains[swapchain];
        sc.images.assign(pImages, pImages + *pCount);
        WMLOG("captured %u swapchain images", *pCount);
    }
    return r;
}

// ---------------- visible-text helpers (unchanged) ----------------
static std::string deriveSessionId() {
    DIR* dp = opendir("/home/unpriv/logs");
    if (!dp) return "";
    struct dirent* e; std::string best;
    while ((e = readdir(dp))) {
        std::string n = e->d_name;
        auto tail = n.rfind(".log"); auto mid = n.find(".unpriv.");
        if (tail == std::string::npos || mid == std::string::npos) continue;
        size_t s = mid + 8; if (tail <= s) continue;
        std::string id = n.substr(s, tail - s);
        if (!id.empty() && id.find('.') == std::string::npos) { best = id; break; }
    }
    closedir(dp);
    return best;
}
static std::string watermarkText() {
    const char* ov = getenv("WMPOC_TEXT");
    if (ov && *ov) return ov;
    std::string sid = deriveSessionId();
    return sid.empty() ? std::string("WATERMARK") : sid;
}
static std::vector<VkClearRect> buildTextRects(uint32_t W, uint32_t H) {
    std::string text = watermarkText();
    if (text.size() > WM_TEXT_MAX_CHARS) text.resize(WM_TEXT_MAX_CHARS);
    if (text.empty()) return {};
    WMLOG("watermark text = \"%s\" (%d chars)", text.c_str(), (int)text.size());
    std::vector<WmRect> rects(WM_TEXT_MAX_RECTS);
    int n = wmBuildTextRects(text.c_str(), (int)text.size(), W, H,
                             rects.data(), WM_TEXT_MAX_RECTS);
    std::vector<VkClearRect> out;
    out.reserve(n);
    for (int i = 0; i < n; i++) {
        VkClearRect cr{};
        cr.rect.offset = {rects[i].x0, rects[i].y0};
        cr.rect.extent = {(uint32_t)(rects[i].x1 - rects[i].x0),
                          (uint32_t)(rects[i].y1 - rects[i].y0)};
        cr.baseArrayLayer = 0; cr.layerCount = 1;
        out.push_back(cr);
    }
    return out;
}

static VkCommandPool poolFor(DeviceData* dd, uint32_t family) {
    auto it = dd->familyPool.find(family);
    if (it != dd->familyPool.end()) return it->second;
    VkCommandPoolCreateInfo pci{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pci.queueFamilyIndex = family;
    VkCommandPool pool = VK_NULL_HANDLE;
    if (dd->CreateCommandPool(dd->device, &pci, nullptr, &pool) == VK_SUCCESS) dd->familyPool[family] = pool;
    return pool;
}

static VkShaderModule mkShader(DeviceData* dd, const unsigned char* code, unsigned len) {
    VkShaderModuleCreateInfo ci{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    ci.codeSize = len; ci.pCode = (const uint32_t*)code;
    VkShaderModule m = VK_NULL_HANDLE;
    dd->CreateShaderModule(dd->device, &ci, nullptr, &m);
    return m;
}

// device-level forensic objects (shaders, descriptor-set layout, pipeline layout)
static bool initForensicDevice(DeviceData* dd) {
    if (dd->fInit) return dd->pipeLayout != VK_NULL_HANDLE;
    dd->fInit = true;
    dd->vsMod = mkShader(dd, vert_spv, vert_spv_len);
    dd->fsMod = mkShader(dd, frag_spv, frag_spv_len);
    if (!dd->vsMod || !dd->fsMod) { WMLOG("shader module creation failed"); return false; }
    // Additive-blend embed: push constants only, no descriptor sets (no texture read).
    VkPushConstantRange pcr{VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof(PushConstants)};
    VkPipelineLayoutCreateInfo plci{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    plci.setLayoutCount = 0; plci.pSetLayouts = nullptr;
    plci.pushConstantRangeCount = 1; plci.pPushConstantRanges = &pcr;
    if (dd->CreatePipelineLayout(dd->device, &plci, nullptr, &dd->pipeLayout) != VK_SUCCESS) return false;
    return true;
}

static bool buildForensicPipeline(DeviceData* dd, SwapchainInfo& sc) {
    const uint32_t W = sc.extent.width, H = sc.extent.height;
    VkPipelineShaderStageCreateInfo st[2] = {};
    st[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    st[0].stage = VK_SHADER_STAGE_VERTEX_BIT; st[0].module = dd->vsMod; st[0].pName = "main";
    st[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    st[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT; st[1].module = dd->fsMod; st[1].pName = "main";
    VkPipelineVertexInputStateCreateInfo vi{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
    VkPipelineInputAssemblyStateCreateInfo ia{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
    ia.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkViewport vp{0, 0, (float)W, (float)H, 0, 1};
    VkRect2D sciss{{0, 0}, {W, H}};
    VkPipelineViewportStateCreateInfo vps{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
    vps.viewportCount = 1; vps.pViewports = &vp; vps.scissorCount = 1; vps.pScissors = &sciss;
    VkPipelineRasterizationStateCreateInfo rs{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
    rs.polygonMode = VK_POLYGON_MODE_FILL; rs.cullMode = VK_CULL_MODE_NONE;
    rs.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE; rs.lineWidth = 1.0f;
    VkPipelineMultisampleStateCreateInfo ms{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
    ms.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
    VkPipelineColorBlendAttachmentState cba{};
    cba.blendEnable = VK_TRUE;                 // dst + src (additive); preserve dst alpha
    cba.srcColorBlendFactor = VK_BLEND_FACTOR_ONE;  cba.dstColorBlendFactor = VK_BLEND_FACTOR_ONE;  cba.colorBlendOp = VK_BLEND_OP_ADD;
    cba.srcAlphaBlendFactor = VK_BLEND_FACTOR_ZERO; cba.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE;  cba.alphaBlendOp = VK_BLEND_OP_ADD;
    cba.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    VkPipelineColorBlendStateCreateInfo cb{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
    cb.attachmentCount = 1; cb.pAttachments = &cba;
    VkGraphicsPipelineCreateInfo gp{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
    gp.stageCount = 2; gp.pStages = st; gp.pVertexInputState = &vi; gp.pInputAssemblyState = &ia;
    gp.pViewportState = &vps; gp.pRasterizationState = &rs; gp.pMultisampleState = &ms;
    gp.pColorBlendState = &cb; gp.layout = dd->pipeLayout; gp.renderPass = sc.renderPass; gp.subpass = 0;
    return dd->CreateGraphicsPipelines(dd->device, VK_NULL_HANDLE, 1, &gp, nullptr, &sc.pipeline) == VK_SUCCESS;
}

/** Build (once) the resources used to mark this swapchain. On any failure the
 *  partial resources are released and the swapchain is latched as failed: the
 *  caller then presents unmarked instead of retrying, which would otherwise leak
 *  a render pass, pipeline, views and command buffers on every single frame. */
static bool buildSwapchainInner(DeviceData* dd, SwapchainInfo& sc, VkCommandPool pool, uint32_t family);

static bool buildSwapchain(DeviceData* dd, SwapchainInfo& sc, VkCommandPool pool, uint32_t family) {
    if (sc.failed) return false;
    if (sc.built) return true;
    if (!buildSwapchainInner(dd, sc, pool, family)) {
        WMLOG("resource build failed; presenting unmarked from now on");
        freeSwapchainResources(dd, dd->device, sc);
        sc.failed = true;
        return false;
    }
    return true;
}

static bool buildSwapchainInner(DeviceData* dd, SwapchainInfo& sc, VkCommandPool pool, uint32_t family) {
    if (sc.images.empty()) return false;
    const uint32_t W = sc.extent.width, H = sc.extent.height;
    const bool forensic = dd->forensic;

    // Shared color-only render pass (LOAD; keep the game's pixels). Both modes.
    {
        VkAttachmentDescription att{};
        att.format = sc.format; att.samples = VK_SAMPLE_COUNT_1_BIT;
        att.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD; att.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
        att.stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE; att.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
        att.initialLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR; att.finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
        VkAttachmentReference ref{0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
        VkSubpassDescription sub{}; sub.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
        sub.colorAttachmentCount = 1; sub.pColorAttachments = &ref;
        VkSubpassDependency deps[2] = {};
        deps[0].srcSubpass = VK_SUBPASS_EXTERNAL; deps[0].dstSubpass = 0;
        deps[0].srcStageMask = VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT;
        deps[0].dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        deps[0].dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
        deps[1].srcSubpass = 0; deps[1].dstSubpass = VK_SUBPASS_EXTERNAL;
        deps[1].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        deps[1].dstStageMask = VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT;
        deps[1].srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
        VkRenderPassCreateInfo rpci{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};
        rpci.attachmentCount = 1; rpci.pAttachments = &att;
        rpci.subpassCount = 1; rpci.pSubpasses = &sub;
        rpci.dependencyCount = 2; rpci.pDependencies = deps;
        if (dd->CreateRenderPass(dd->device, &rpci, nullptr, &sc.renderPass) != VK_SUCCESS) { WMLOG("CreateRenderPass failed"); return false; }
    }
    if (forensic) {
        if (!initForensicDevice(dd)) { WMLOG("forensic device init failed"); return false; }
        if (!buildForensicPipeline(dd, sc)) { WMLOG("forensic pipeline failed"); return false; }
    }

    const size_t n = sc.images.size();
    sc.views.resize(n); sc.fbs.resize(n); sc.cmds.resize(n); sc.sems.resize(n);

    VkCommandBufferAllocateInfo cbai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    cbai.commandPool = pool; cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cbai.commandBufferCount = (uint32_t)n;
    if (dd->AllocateCommandBuffers(dd->device, &cbai, sc.cmds.data()) != VK_SUCCESS) { WMLOG("AllocateCommandBuffers failed"); return false; }
    sc.pool = pool;
    sc.family = family;

    // Text mode clear spec
    VkClearAttachment clr{}; clr.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT; clr.colorAttachment = 0;
    clr.clearValue.color = {{1.0f, 0.0f, 1.0f, 1.0f}};
    std::vector<VkClearRect> rects = forensic ? std::vector<VkClearRect>{} : buildTextRects(W, H);

    for (size_t i = 0; i < n; i++) {
        VkImageViewCreateInfo vci{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
        vci.image = sc.images[i]; vci.viewType = VK_IMAGE_VIEW_TYPE_2D; vci.format = sc.format;
        vci.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
        if (dd->CreateImageView(dd->device, &vci, nullptr, &sc.views[i]) != VK_SUCCESS) { WMLOG("CreateImageView failed"); return false; }

        VkFramebufferCreateInfo fci{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};
        fci.renderPass = sc.renderPass; fci.attachmentCount = 1; fci.pAttachments = &sc.views[i];
        fci.width = W; fci.height = H; fci.layers = 1;
        if (dd->CreateFramebuffer(dd->device, &fci, nullptr, &sc.fbs[i]) != VK_SUCCESS) { WMLOG("CreateFramebuffer failed"); return false; }

        VkSemaphoreCreateInfo sci2{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
        dd->CreateSemaphore(dd->device, &sci2, nullptr, &sc.sems[i]);

        VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
        dd->BeginCommandBuffer(sc.cmds[i], &bi);
        VkRenderPassBeginInfo rbi{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};
        rbi.renderPass = sc.renderPass; rbi.framebuffer = sc.fbs[i];
        rbi.renderArea.offset = {0, 0}; rbi.renderArea.extent = {W, H};
        if (forensic) {
            dd->CmdBeginRenderPass(sc.cmds[i], &rbi, VK_SUBPASS_CONTENTS_INLINE);
            dd->CmdBindPipeline(sc.cmds[i], VK_PIPELINE_BIND_POINT_GRAPHICS, sc.pipeline);
            PushConstants pc{dd->seedLo, dd->seedHi, TILE_SIZE, dd->alpha};
            dd->CmdPushConstants(sc.cmds[i], dd->pipeLayout, VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof(pc), &pc);
            dd->CmdDraw(sc.cmds[i], 3, 1, 0, 0);
            dd->CmdEndRenderPass(sc.cmds[i]);
        } else if (!rects.empty()) {
            dd->CmdBeginRenderPass(sc.cmds[i], &rbi, VK_SUBPASS_CONTENTS_INLINE);
            dd->CmdClearAttachments(sc.cmds[i], 1, &clr, (uint32_t)rects.size(), rects.data());
            dd->CmdEndRenderPass(sc.cmds[i]);
        }
        dd->EndCommandBuffer(sc.cmds[i]);
    }
    sc.built = true;
    WMLOG("built %s resources for %zu images (%ux%u)", forensic ? "forensic" : "text", n, W, H);
    return true;
}

static VKAPI_ATTR VkResult VKAPI_CALL wmpoc_QueuePresentKHR(VkQueue queue, const VkPresentInfoKHR* pPresentInfo) {
    DeviceData* dd = devData(queue);
    if (!dd) return VK_ERROR_INITIALIZATION_FAILED;

    // Resolve and lazily build under the device lock, then release it. The
    // submit and the downstream present below must never run with a lock held:
    // present blocks, and blocking other render threads on it deadlocks the
    // application against the capture layer.
    std::vector<VkCommandBuffer> cmds; std::vector<VkSemaphore> signals;
    bool ok;
    {
        std::lock_guard<std::mutex> g(dd->lock);
        uint32_t family = 0;
        auto qf = dd->queueFamily.find(queue);
        if (qf != dd->queueFamily.end()) family = qf->second;
        VkCommandPool pool = poolFor(dd, family);
        ok = pool != VK_NULL_HANDLE;
        for (uint32_t i = 0; ok && i < pPresentInfo->swapchainCount; i++) {
            auto it = dd->swapchains.find(pPresentInfo->pSwapchains[i]);
            if (it == dd->swapchains.end()) { ok = false; break; }
            SwapchainInfo& sc = it->second;
            if (!buildSwapchain(dd, sc, pool, family)) { ok = false; break; }
            // Command buffers belong to one queue family. If the application
            // starts presenting the same swapchain from another family, using
            // them would be invalid, so present unmarked rather than risk it.
            if (sc.family != family) {
                if (!sc.warnedFamily) {
                    WMLOG("present queue family changed (%u -> %u); presenting unmarked",
                          sc.family, family);
                    sc.warnedFamily = true;
                }
                ok = false; break;
            }
            uint32_t idx = pPresentInfo->pImageIndices[i];
            if (idx >= sc.cmds.size()) { ok = false; break; }
            cmds.push_back(sc.cmds[idx]); signals.push_back(sc.sems[idx]);
        }
    }
    if (!ok || cmds.empty()) return dd->QueuePresentKHR(queue, pPresentInfo);

    std::vector<VkPipelineStageFlags> waitStages(pPresentInfo->waitSemaphoreCount, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    si.waitSemaphoreCount = pPresentInfo->waitSemaphoreCount;
    si.pWaitSemaphores = pPresentInfo->pWaitSemaphores;
    si.pWaitDstStageMask = pPresentInfo->waitSemaphoreCount ? waitStages.data() : nullptr;
    si.commandBufferCount = (uint32_t)cmds.size(); si.pCommandBuffers = cmds.data();
    si.signalSemaphoreCount = (uint32_t)signals.size(); si.pSignalSemaphores = signals.data();
    if (dd->QueueSubmit(queue, 1, &si, VK_NULL_HANDLE) != VK_SUCCESS)
        return dd->QueuePresentKHR(queue, pPresentInfo);

    VkPresentInfoKHR pi = *pPresentInfo;
    pi.waitSemaphoreCount = (uint32_t)signals.size(); pi.pWaitSemaphores = signals.data();
    return dd->QueuePresentKHR(queue, &pi);
}

// ---------------- proc addr ----------------
#define INTERCEPT(name) if (!strcmp(pName, "vk" #name)) return (PFN_vkVoidFunction)&wmpoc_##name

extern "C" VK_LAYER_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL wmpoc_GetDeviceProcAddr(VkDevice device, const char* pName) {
    INTERCEPT(GetDeviceProcAddr); INTERCEPT(DestroyDevice); INTERCEPT(CreateSwapchainKHR);
    INTERCEPT(DestroySwapchainKHR); INTERCEPT(GetSwapchainImagesKHR); INTERCEPT(QueuePresentKHR);
    DeviceData* dd = devData(device);
    return dd && dd->gdpa ? dd->gdpa(device, pName) : nullptr;
}

extern "C" VK_LAYER_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL wmpoc_GetInstanceProcAddr(VkInstance instance, const char* pName) {
    INTERCEPT(GetInstanceProcAddr); INTERCEPT(CreateInstance); INTERCEPT(DestroyInstance);
    INTERCEPT(CreateDevice); INTERCEPT(GetDeviceProcAddr); INTERCEPT(DestroyDevice);
    INTERCEPT(CreateSwapchainKHR); INTERCEPT(DestroySwapchainKHR);
    INTERCEPT(GetSwapchainImagesKHR); INTERCEPT(QueuePresentKHR);
    PFN_vkGetInstanceProcAddr next = nullptr;
    {
        std::lock_guard<std::mutex> g(g_lock);
        auto it = g_instances.find(instance ? DKey(instance) : nullptr);
        if (it != g_instances.end()) next = it->second.gipa;
    }
    return next ? next(instance, pName) : nullptr;
}
