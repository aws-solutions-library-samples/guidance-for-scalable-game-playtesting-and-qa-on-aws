// Unit tests for the forensic watermark settings and game package check.
// Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeWatermarkSettings,
    parseS3Uri,
    requiredWatermarkKeys,
    assertWatermarkPackage,
    includeWatermarkComponents,
    assertNotUnrealLauncher,
    COMPONENT_METADATA_KEY,
    COMPONENT_METADATA_VALUE,
    WatermarkConfigError,
} from "../lambdas/PlayTestSessions/watermark.js";

// Fake S3: resolves for keys in `present`, rejects like the SDK otherwise.
const fakeS3 = (present, failWith) => async (bucket, key) => {
    if (failWith) throw failWith;
    if (present.has(`${bucket}/${key}`)) return {};
    const err = new Error("NotFound");
    err.name = "NotFound";
    err.$metadata = { httpStatusCode: 404 };
    throw err;
};

test("settings: absent fields mean off at default strength", () => {
    assert.deepEqual(normalizeWatermarkSettings({}), { watermarkEnabled: false, watermarkAlpha: 8 });
    assert.deepEqual(normalizeWatermarkSettings(undefined), { watermarkEnabled: false, watermarkAlpha: 8 });
});

test("settings: enabled flag and numeric-string strength are accepted", () => {
    assert.deepEqual(normalizeWatermarkSettings({ watermarkEnabled: true, watermarkAlpha: "12" }), { watermarkEnabled: true, watermarkAlpha: 12 });
    assert.deepEqual(normalizeWatermarkSettings({ watermarkEnabled: "true", watermarkAlpha: "" }), { watermarkEnabled: true, watermarkAlpha: 8 });
    // only a real true enables it
    assert.equal(normalizeWatermarkSettings({ watermarkEnabled: "yes" }).watermarkEnabled, false);
});

test("settings: out-of-range or non-numeric strength is rejected", () => {
    for (const bad of [0, 65, -3, "abc", "8x"]) {
        assert.throws(() => normalizeWatermarkSettings({ watermarkAlpha: bad }), WatermarkConfigError, `alpha ${bad}`);
    }
    assert.equal(normalizeWatermarkSettings({ watermarkAlpha: 1 }).watermarkAlpha, 1);
    assert.equal(normalizeWatermarkSettings({ watermarkAlpha: 64 }).watermarkAlpha, 64);
});

test("parseS3Uri: normalizes the prefix to end with a slash", () => {
    assert.deepEqual(parseS3Uri("s3://my-bucket/games/mygame"), { bucket: "my-bucket", prefix: "games/mygame/" });
    assert.deepEqual(parseS3Uri("s3://my-bucket/games/mygame/"), { bucket: "my-bucket", prefix: "games/mygame/" });
    assert.deepEqual(parseS3Uri("S3://my-bucket"), { bucket: "my-bucket", prefix: "" });
    assert.throws(() => parseS3Uri("https://example.com/x"), WatermarkConfigError);
    assert.throws(() => parseS3Uri(""), WatermarkConfigError);
});

test("parseS3Uri: same results as the regex it replaced, on normal input", () => {
    const old = (uri) => {
        const m = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(String(uri ?? "").trim());
        if (!m || !m[1]) return "invalid";
        let prefix = m[2];
        if (prefix && !prefix.endsWith("/")) prefix += "/";
        return { bucket: m[1], prefix };
    };
    const cases = ["s3://b", "s3://b/", "s3://b/a", "s3://b/a/", "s3://b//a", "S3://B/x/y.exe", "  s3://b/g/  ", "s3:///x", "s3://", "http://b/x", "", "s3:/b/x", "s3://b/a b/c"];
    for (const c of cases) {
        let got;
        try { got = parseS3Uri(c); } catch { got = "invalid"; }
        assert.deepEqual(got, old(c), JSON.stringify(c));
    }
});

test("parseS3Uri: linear on hostile input and rejects oversized URIs (CodeQL js/polynomial-redos)", () => {
    const hostile = "s3://." + "..".repeat(540);   // the pattern CodeQL reported, within the length limit
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) parseS3Uri(hostile);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 500, "1,000 hostile parses should take well under 500 ms");
    assert.throws(() => parseS3Uri("s3://b/" + "a".repeat(2000)), WatermarkConfigError);
});

test("required keys: Proton needs the layer and its manifest at the package root", () => {
    assert.deepEqual(requiredWatermarkKeys({ sourceUri: "s3://b/game/", runtimeType: "PROTON" }), {
        bucket: "b",
        keys: ["game/wmlayer/libVkLayer_wmpoc.so", "game/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json"],
    });
});

test("required keys: Windows needs dxgi.dll next to the executable", () => {
    const k = (exe) => requiredWatermarkKeys({ sourceUri: "s3://b/game", executablePath: exe, runtimeType: "WINDOWS" }).keys;
    assert.deepEqual(k("CarConfigurator/Binaries/Win64/Car.exe"), ["game/CarConfigurator/Binaries/Win64/dxgi.dll"]);
    assert.deepEqual(k("Overcooked2.exe"), ["game/dxgi.dll"]);
    assert.deepEqual(k("/Bin\\Win64\\Game.exe"), ["game/Bin/Win64/dxgi.dll"]); // leading slash and backslashes
    assert.throws(() => k(""), WatermarkConfigError);
});

test("required keys: Ubuntu and unknown runtimes are refused with a clear message", () => {
    assert.throws(() => requiredWatermarkKeys({ sourceUri: "s3://b/g/", runtimeType: "UBUNTU" }), /isn't supported on the Ubuntu 22.04 runtime/);
    assert.throws(() => requiredWatermarkKeys({ sourceUri: "s3://b/g/", runtimeType: undefined }), /couldn't determine the game's runtime/);
});

test("package check: passes when every file is present", async () => {
    const present = new Set(["b/g/wmlayer/libVkLayer_wmpoc.so", "b/g/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json"]);
    await assertWatermarkPackage({ sourceUri: "s3://b/g", runtimeType: "PROTON" }, fakeS3(present));
});

test("package check: lists exactly the missing files, with advice for a new game", async () => {
    const present = new Set(["b/g/wmlayer/libVkLayer_wmpoc.so"]);
    await assert.rejects(
        assertWatermarkPackage({ sourceUri: "s3://b/g/", runtimeType: "PROTON", existingApplication: false }, fakeS3(present)),
        (err) => {
            assert.ok(err instanceof WatermarkConfigError);
            assert.match(err.message, /s3:\/\/b\/g\/xdg\/vulkan\/implicit_layer\.d\/VkLayer_wmpoc\.json/);
            assert.doesNotMatch(err.message, /libVkLayer_wmpoc\.so/);
            assert.match(err.message, /missing from the game package/);
            return true;
        }
    );
});

test("package check: an existing game gets 'add it again' advice", async () => {
    await assert.rejects(
        assertWatermarkPackage({ sourceUri: "s3://b/g/", executablePath: "Game.exe", runtimeType: "WINDOWS", existingApplication: true }, fakeS3(new Set())),
        /added without the forensic watermark components.*s3:\/\/b\/g\/dxgi\.dll.*Add New Game.*added for you/s
    );
});

// Fake S3 for includeWatermarkComponents: objects map key -> metadata; records copies.
function fakeGameBucket(objects = {}) {
    const copies = [];
    return {
        copies,
        s3: {
            head: async (bucket, key) => {
                if (`${bucket}/${key}` in objects) return { Metadata: objects[`${bucket}/${key}`] };
                throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
            },
            copy: async (sb, sk, db, dk) => { copies.push(`${sb}/${sk} -> ${db}/${dk}`); objects[`${db}/${dk}`] = { [COMPONENT_METADATA_KEY]: COMPONENT_METADATA_VALUE }; },
        },
    };
}
const avail = { availableRuntimes: ["PROTON", "WINDOWS"], payloadBucket: "payload" };

test("include: a new Proton game gets the layer and manifest at its root", async () => {
    const f = fakeGameBucket();
    const added = await includeWatermarkComponents({ sourceUri: "s3://games/lyra", runtimeType: "PROTON", ...avail }, f.s3);
    assert.deepEqual(f.copies, [
        "payload/proton/wmlayer/libVkLayer_wmpoc.so -> games/lyra/wmlayer/libVkLayer_wmpoc.so",
        "payload/proton/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json -> games/lyra/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json",
    ]);
    assert.equal(added.length, 2);
});

test("include: a new Windows game gets dxgi.dll next to its executable", async () => {
    const f = fakeGameBucket();
    await includeWatermarkComponents({ sourceUri: "s3://games/lyra/", executablePath: "Lyra/Binaries/Win64/LyraGame.exe", runtimeType: "WINDOWS", ...avail }, f.s3);
    assert.deepEqual(f.copies, ["payload/windows/dxgi.dll -> games/lyra/Lyra/Binaries/Win64/dxgi.dll"]);
});

test("include: replaces an older copy the solution wrote, never a game's own file", async () => {
    const ours = fakeGameBucket({ "games/g/dxgi.dll": { [COMPONENT_METADATA_KEY]: COMPONENT_METADATA_VALUE } });
    await includeWatermarkComponents({ sourceUri: "s3://games/g/", executablePath: "Game.exe", runtimeType: "WINDOWS", ...avail }, ours.s3);
    assert.equal(ours.copies.length, 1);

    const theirs = fakeGameBucket({ "games/g/dxgi.dll": {} });
    await assert.rejects(
        includeWatermarkComponents({ sourceUri: "s3://games/g/", executablePath: "Game.exe", runtimeType: "WINDOWS", ...avail }, theirs.s3),
        /wasn't added by this solution, so it won't be overwritten.*ships its own dxgi\.dll/s
    );
    assert.equal(theirs.copies.length, 0);
});

test("include: refused with a clear fix when this deployment didn't build that runtime", async () => {
    const f = fakeGameBucket();
    await assert.rejects(
        includeWatermarkComponents({ sourceUri: "s3://games/g/", executablePath: "Game.exe", runtimeType: "WINDOWS", availableRuntimes: ["PROTON"], payloadBucket: "payload" }, f.s3),
        /doesn't include the forensic watermark components for Windows games.*deploy-all/s
    );
    await assert.rejects(
        includeWatermarkComponents({ sourceUri: "s3://games/g/", runtimeType: "UBUNTU", ...avail }, f.s3),
        /isn't supported on the Ubuntu 22.04 runtime/
    );
    assert.equal(f.copies.length, 0);
});

// The real layout of an Unreal Engine (Lyra) Windows package.
const lyra = ["lyra/LyraGame.exe", "lyra/Engine/Binaries/Win64/EpicWebHelper.exe",
    "lyra/LyraStarterGame/Binaries/Win64/LyraGame-Win64-Shipping.exe", "lyra/LyraStarterGame/Binaries/Win64/D3D12/D3D12Core.dll"];
const lister = (keys) => async (bucket, prefix) => keys.filter((k) => k.startsWith(prefix));

test("unreal launcher: refused, naming the shipping executable to use", async () => {
    await assert.rejects(
        assertNotUnrealLauncher({ sourceUri: "s3://games/lyra/", executablePath: "LyraGame.exe", runtimeType: "WINDOWS" }, lister(lyra)),
        /"LyraGame\.exe" looks like an Unreal Engine launcher.*LyraStarterGame\/Binaries\/Win64\/LyraGame-Win64-Shipping\.exe/s
    );
});

test("unreal launcher: the shipping exe, non-Unreal games and Proton are fine", async () => {
    await assertNotUnrealLauncher({ sourceUri: "s3://games/lyra/", executablePath: "LyraStarterGame/Binaries/Win64/LyraGame-Win64-Shipping.exe", runtimeType: "WINDOWS" }, lister(lyra));
    await assertNotUnrealLauncher({ sourceUri: "s3://games/other/", executablePath: "Game.exe", runtimeType: "WINDOWS" }, lister(["other/Game.exe", "other/data.pak"]));
    await assertNotUnrealLauncher({ sourceUri: "s3://games/lyra/", executablePath: "LyraGame.exe", runtimeType: "PROTON" }, lister(lyra));
    // Engine tools are not the game
    await assertNotUnrealLauncher({ sourceUri: "s3://games/x/", executablePath: "X.exe", runtimeType: "WINDOWS" }, lister(["x/X.exe", "x/Engine/Binaries/Win64/CrashReportClient-Win64-Shipping.exe"]));
});

test("include: write access denied is explained", async () => {
    const f = fakeGameBucket();
    f.s3.copy = async () => { throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); };
    await assert.rejects(
        includeWatermarkComponents({ sourceUri: "s3://games/g/", runtimeType: "PROTON", ...avail }, f.s3),
        /writing to s3:\/\/games\/ was denied/
    );
});

test("package check: access denied is reported, not mistaken for a missing file", async () => {
    const denied = Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } });
    await assert.rejects(
        assertWatermarkPackage({ sourceUri: "s3://b/g/", runtimeType: "PROTON" }, fakeS3(new Set(), denied)),
        /access to s3:\/\/b\/ was denied/
    );
});

test("package check: unexpected S3 errors propagate unchanged", async () => {
    const boom = Object.assign(new Error("Throttled"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    await assert.rejects(
        assertWatermarkPackage({ sourceUri: "s3://b/g/", runtimeType: "PROTON" }, fakeS3(new Set(), boom)),
        (err) => err === boom
    );
});
