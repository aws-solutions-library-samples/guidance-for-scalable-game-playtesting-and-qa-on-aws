// Unit tests for the forensic watermark settings and game package check.
// Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeWatermarkSettings,
    parseS3Uri,
    requiredWatermarkKeys,
    assertWatermarkPackage,
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
            assert.match(err.message, /create the playtest session again/);
            return true;
        }
    );
});

test("package check: an existing game gets 'add it again' advice", async () => {
    await assert.rejects(
        assertWatermarkPackage({ sourceUri: "s3://b/g/", executablePath: "Game.exe", runtimeType: "WINDOWS", existingApplication: true }, fakeS3(new Set())),
        /s3:\/\/b\/g\/dxgi\.dll.*Add New Game/s
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
