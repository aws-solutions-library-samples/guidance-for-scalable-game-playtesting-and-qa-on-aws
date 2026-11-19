#!/usr/bin/env node
/*
 * Build the forensic watermark host components from source, inside containers, so
 * the only prerequisite is Docker or Finch (no compilers on this machine).
 *
 *   npm run build-watermark                     # both runtimes
 *   npm run build-watermark -- --runtime proton # Vulkan layer only
 *   npm run build-watermark -- --runtime windows
 *
 * Set CONTAINER_CLI=finch to use Finch instead of Docker.
 *
 * Output (never committed; see .gitignore):
 *   watermark/build/proton/wmlayer/libVkLayer_wmpoc.so
 *   watermark/build/proton/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json
 *   watermark/build/windows/dxgi.dll
 *
 * The container steps are those of the upstream GameLift Streams forensic watermarking
 * sample (layer/build.sh, dxgiproxy/build.sh, dxgiproxy/shaders/build.sh). The first
 * Windows build also builds an image with two HLSL compilers, which downloads and
 * compiles them and takes several minutes; it is cached afterwards. Needs network access.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CLI = process.env.CONTAINER_CLI || "docker";
const HOST = path.resolve(__dirname, "../watermark/host");
const OUT = path.resolve(__dirname, "../watermark/build");
const HLSL_IMAGE = "wmpoc-hlsl:vkd3d2.1-dxc1.9.2609";

function run(args, { capture = false } = {}) {
    const r = spawnSync(CLI, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
    if (r.error) {
        console.error(`\n[build-watermark] couldn't run "${CLI}": ${r.error.message}`);
        console.error(`Install Docker (https://docs.docker.com/get-docker/) or Finch and make sure it is running, or set CONTAINER_CLI.`);
        process.exit(1);
    }
    return r;
}

function mustRun(args, what) {
    const r = run(args);
    if (r.status !== 0) {
        console.error(`\n[build-watermark] ${what} failed (exit ${r.status}).`);
        process.exit(r.status || 1);
    }
}

function containerRun(image, workdir, script) {
    mustRun(["run", "--rm", "--platform", "linux/amd64", "-v", `${HOST}:/src`, ...(workdir ? ["-w", workdir] : []), image, "bash", "-c", script], `container step (${image})`);
}

function checkCli() {
    const r = run(["version"], { capture: true });
    if (r.status !== 0) {
        console.error(`[build-watermark] "${CLI}" is installed but its engine isn't responding. Start Docker Desktop (or Finch) and try again.`);
        process.exit(1);
    }
}

function buildProton() {
    console.log("\n[build-watermark] Proton: Vulkan layer (linux/amd64, Ubuntu 22.04)");
    // From upstream layer/build.sh.
    containerRun("ubuntu:22.04", null, `
  set -e
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq g++ libvulkan-dev glslang-tools xxd >/dev/null
  cd /src/layer
  glslangValidator -V shaders/wm.vert -o vert.spv >/dev/null
  glslangValidator -V shaders/wm.frag -o frag.spv >/dev/null
  { xxd -i vert.spv; xxd -i frag.spv; } > shaders_spv.h
  g++ -O2 -fPIC -shared -Wall -o libVkLayer_wmpoc.so vklayer_wmpoc.cpp
  rm -f vert.spv frag.spv
  echo "BUILD_OK"
`);
    const so = path.join(HOST, "layer/libVkLayer_wmpoc.so");
    const dest = path.join(OUT, "proton");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, "wmlayer"), { recursive: true });
    fs.copyFileSync(so, path.join(dest, "wmlayer/libVkLayer_wmpoc.so"));
    fs.cpSync(path.join(HOST, "package/xdg"), path.join(dest, "xdg"), { recursive: true });
    console.log(`[build-watermark] Proton payload ready in ${dest}`);
}

function shadersStale() {
    const header = path.join(HOST, "dxgiproxy/shaders_bytecode.h");
    if (!fs.existsSync(header)) return true;
    const t = fs.statSync(header).mtimeMs;
    return ["wm_vs.hlsl", "wm_ps.hlsl", "Dockerfile"].some((f) => fs.statSync(path.join(HOST, "dxgiproxy/shaders", f)).mtimeMs > t);
}

function buildWindows() {
    console.log("\n[build-watermark] Windows: proxy dxgi.dll (x86-64, mingw-w64)");
    if (shadersStale()) {
        if (run(["image", "inspect", HLSL_IMAGE], { capture: true }).status !== 0) {
            console.log(`[build-watermark] building ${HLSL_IMAGE} (one-time, several minutes)`);
            mustRun(["build", "--platform", "linux/amd64", "-t", HLSL_IMAGE, path.join(HOST, "dxgiproxy/shaders")], "HLSL compiler image build");
        }
        // From upstream dxgiproxy/shaders/build.sh: DXIL via dxc (D3D12), DXBC via vkd3d (D3D11).
        containerRun(HLSL_IMAGE, "/work", `
  set -e
  cp /src/dxgiproxy/shaders/wm_vs.hlsl /src/dxgiproxy/shaders/wm_ps.hlsl .
  echo "[shaders] DXIL via dxc $(dxc --version 2>&1 | head -1)"
  dxc -T vs_6_0 -E main -Fo vs_dxil.bin wm_vs.hlsl
  dxc -T ps_6_0 -E main -Fo ps_dxil.bin wm_ps.hlsl
  dxc -T ps_5_0 -E main -Fo ps_as50.bin wm_ps.hlsl 2>/dev/null || true
  if cmp -s ps_as50.bin ps_dxil.bin; then
    echo "[shaders] confirmed: dxc -T ps_5_0 returns DXIL, not DXBC (so vkd3d is required)"
  else
    echo "[shaders] NOTE: dxc -T ps_5_0 now differs from ps_6_0 - re-check whether it emits DXBC"
  fi
  echo "[shaders] DXBC via $(vkd3d-compiler --version 2>&1 | head -1)"
  vkd3d-compiler -x hlsl -p vs_5_0 -b dxbc-tpf -o vs_dxbc.bin wm_vs.hlsl
  vkd3d-compiler -x hlsl -p ps_5_0 -b dxbc-tpf -o ps_dxbc.bin wm_ps.hlsl
  for f in vs_dxil.bin ps_dxil.bin; do
    echo "[shaders]   dxv $f: $(dxv "$f" | tr -d "\\r\\n")"
  done
  {
    echo "// Generated by scripts/build-watermark.js - do not edit."
    echo "// Forensic-mode shader bytecode: DXIL for D3D12, DXBC for D3D11. Not committed."
    for n in vs_dxil ps_dxil vs_dxbc ps_dxbc; do
      xxd -i -n "$n" "$n.bin"
    done
  } > /src/dxgiproxy/shaders_bytecode.h
  echo "[shaders] sha256 of each blob:"
  sha256sum *_dxil.bin *_dxbc.bin | sed "s/^/[shaders]   /"
`);
    }
    // From upstream dxgiproxy/build.sh. The DLL loads into the game process, so it
    // imports only kernel32 and msvcrt; the export table is exactly dxgi.def.
    containerRun("ubuntu:24.04", null, `
  set -e
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq g++-mingw-w64-x86-64 >/dev/null
  cd /src/dxgiproxy
  x86_64-w64-mingw32-g++ -O2 -Wall -Wextra -shared -fno-exceptions -fno-rtti \\
      -o dxgi.dll dxgi_proxy.cpp dxgi.def \\
      -static-libgcc -Wl,--exclude-all-symbols -ldxguid
  x86_64-w64-mingw32-strip dxgi.dll
  echo "=== imported DLLs ==="
  x86_64-w64-mingw32-objdump -p dxgi.dll | grep "DLL Name:"
  echo BUILD_OK
`);
    const dest = path.join(OUT, "windows");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(HOST, "dxgiproxy/dxgi.dll"), path.join(dest, "dxgi.dll"));
    console.log(`[build-watermark] Windows payload ready in ${dest}`);
}

// True if the payload exists and is newer than every source it is built from.
function upToDate(outputs, sourceDirs) {
    if (!outputs.every((o) => fs.existsSync(o))) return false;
    const built = Math.min(...outputs.map((o) => fs.statSync(o).mtimeMs));
    const newest = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return Math.max(m, newest(p));
        if (/\.(dll|so|spv)$|shaders_bytecode\.h$|shaders_spv\.h$/.test(e.name)) return m; // generated
        return Math.max(m, fs.statSync(p).mtimeMs);
    }, 0);
    return sourceDirs.every((d) => newest(path.join(HOST, d)) <= built);
}

const argv = process.argv.slice(2);
const i = argv.indexOf("--runtime");
const runtime = i >= 0 ? String(argv[i + 1] || "").toLowerCase() : "all";
// --if-available: used by deploy-all. Skip quietly when no container engine is running
// (watermarking is optional), and skip a runtime whose payload is already up to date.
const ifAvailable = argv.includes("--if-available");
if (!["proton", "windows", "all"].includes(runtime)) {
    console.error("Usage: npm run build-watermark -- [--runtime proton|windows|all] [--if-available]");
    process.exit(2);
}
if (ifAvailable) {
    if (process.env.SKIP_WATERMARK_BUILD === "1") {
        console.log("[build-watermark] SKIP_WATERMARK_BUILD=1, skipping.");
        process.exit(0);
    }
    const probe = spawnSync(CLI, ["version"], { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
        const have = ["proton", "windows"].filter((r) => fs.existsSync(path.join(OUT, r)));
        console.log(`[build-watermark] No running container engine ("${CLI}"), so the forensic watermark components weren't built.`);
        console.log(have.length
            ? `[build-watermark] Using the previously built components for: ${have.join(", ")}.`
            : "[build-watermark] Forensic watermarking won't be available in this deployment. To enable it, start Docker (or Finch) and run deploy-all again.");
        process.exit(0);
    }
}
checkCli();
const protonOut = [path.join(OUT, "proton/wmlayer/libVkLayer_wmpoc.so"), path.join(OUT, "proton/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json")];
const windowsOut = [path.join(OUT, "windows/dxgi.dll")];
if (runtime === "proton" || runtime === "all") {
    if (ifAvailable && upToDate(protonOut, ["layer", "common", "package"])) console.log("[build-watermark] Proton components are up to date.");
    else buildProton();
}
if (runtime === "windows" || runtime === "all") {
    if (ifAvailable && upToDate(windowsOut, ["dxgiproxy", "common"])) console.log("[build-watermark] Windows components are up to date.");
    else buildWindows();
}
console.log("\n[build-watermark] done. Next: npm run stage-watermark -- --game s3://<bucket>/<game-folder>/ --runtime <proton|windows> [--exe <path/to/game.exe>]");
