// Unit tests for stream-start identity, registration binding and watermark session variables.
// Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import sw from "../lambdas/PlayTestStartStream/streamWatermark.js";
import getStream from "../lambdas/PlayTestGetStream/PlayTestGetStream.js";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("opaqueUserId: deterministic, opaque, valid GameLift Streams UserId", () => {
    const id = sw.opaqueUserId("playtester_one");
    assert.match(id, /^u[0-9a-f]{16}$/);
    assert.equal(sw.opaqueUserId("playtester_one"), id);
    assert.notEqual(sw.opaqueUserId("playtester_two"), id);
    assert.ok(!id.includes("playtester"), "raw username must not appear");
});

test("opaqueUserId: start-stream and get-stream copies agree", () => {
    for (const u of ["a", "playtester_one", "Admin.User-9"]) {
        assert.equal(getStream.opaqueUserId(u), sw.opaqueUserId(u));
    }
});

test("registrationHash: matches the formula registration uses (drift guard)", () => {
    const reg = src("../lambdas/PlayTestRegisterPlayer/PlayerRegistration.js");
    assert.match(reg, /pbkdf2Sync\(stringValue,\s*salt,\s*1000,\s*64,\s*"sha512"\)/, "PlayerRegistration hash parameters changed");
    assert.match(reg, /generateHash\(playtesterId,\s*playtestsessionId\)/, "PlayerRegistration hash inputs changed");
    const expected = crypto.pbkdf2Sync("playtester_one", "sg-abc--a-def", 1000, 64, "sha512").toString("hex");
    assert.equal(sw.registrationHash("playtester_one", "sg-abc--a-def"), expected);
});

test("newWatermarkSeed: 32 hex characters, unique", () => {
    const seeds = new Set(Array.from({ length: 200 }, () => sw.newWatermarkSeed()));
    assert.equal(seeds.size, 200);
    for (const s of seeds) assert.match(s, /^[0-9a-f]{32}$/);
});

test("watermarkEnvironment: Proton arms the layer through XDG_CONFIG_DIRS", () => {
    const seed = "0123456789abcdef0123456789abcdef";
    assert.deepEqual(sw.watermarkEnvironment("PROTON", 8, seed), {
        ENABLE_WMPOC: "1",
        WMPOC_ALPHA: "8",
        WMPOC_SEED: seed,
        XDG_CONFIG_DIRS: "/home/unpriv/games/xdg:/etc/xdg",
    });
    // XDG_CONFIG_HOME breaks the host audio client; it must never be set.
    assert.ok(!("XDG_CONFIG_HOME" in sw.watermarkEnvironment("PROTON", 8, seed)));
});

test("watermarkEnvironment: Windows needs no loader configuration", () => {
    const seed = "fedcba9876543210fedcba9876543210";
    assert.deepEqual(sw.watermarkEnvironment("WINDOWS", 12, seed), { ENABLE_WMPOC: "1", WMPOC_ALPHA: "12", WMPOC_SEED: seed });
});

test("watermarkEnvironment: unsupported runtimes get nothing; bad seeds are refused", () => {
    assert.equal(sw.watermarkEnvironment("UBUNTU", 8, "0".repeat(32)), null);
    assert.equal(sw.watermarkEnvironment(undefined, 8, "0".repeat(32)), null);
    assert.throws(() => sw.watermarkEnvironment("PROTON", 8, "not-a-seed"));
    assert.throws(() => sw.watermarkEnvironment("PROTON", 8, "0".repeat(31)));
});

test("sessionAlpha: stored strength, falling back to 8", () => {
    assert.equal(sw.sessionAlpha({ watermarkAlpha: 12 }), 12);
    assert.equal(sw.sessionAlpha({}), 8);
    assert.equal(sw.sessionAlpha({ watermarkAlpha: 0 }), 8);
    assert.equal(sw.sessionAlpha({ watermarkAlpha: "abc" }), 8);
});

test("sessionUnavailableReason: enabled and inside the date window (inclusive, UTC)", () => {
    const now = new Date("2026-11-20T23:30:00Z");
    const s = { enabled: true, startDate: "2026-11-20", endDate: "2026-11-22" };
    assert.equal(sw.sessionUnavailableReason(s, now), null);                                         // first day
    assert.equal(sw.sessionUnavailableReason({ ...s, startDate: "2026-11-18", endDate: "2026-11-20" }, now), null); // last day
    assert.match(sw.sessionUnavailableReason({ ...s, enabled: false }, now), /disabled/);
    assert.match(sw.sessionUnavailableReason({ ...s, startDate: "2026-11-21" }, now), /hasn't started/);
    assert.match(sw.sessionUnavailableReason({ ...s, endDate: "2026-11-19" }, now), /has ended/);
    assert.match(sw.sessionUnavailableReason({}, now), /disabled/);
});

test("bot session list only offers ACTIVE sessions", () => {
    const code = src("../lambdas/PlayTestGetPlayTestSessions/PlayTestGetPlayTestSessions.js");
    assert.match(code, /#status = :active/);
    assert.match(code, /":active": "ACTIVE"/);
});

test("ownsSession: only the user who started a session may see it", () => {
    const mine = sw.opaqueUserId("playtester_one");
    assert.equal(getStream.ownsSession(mine, "playtester_one"), true);
    assert.equal(getStream.ownsSession(mine, "playtester_two"), false);
    assert.equal(getStream.ownsSession(mine, undefined), false);
    assert.equal(getStream.ownsSession(undefined, "anyone"), true); // sessions from before the check
});

test("seed confidentiality: no log statement references the seed or session variables", () => {
    for (const file of ["../lambdas/PlayTestStartStream/PlayTestStartStream.js", "../lambdas/PlayTestGetStream/PlayTestGetStream.js"]) {
        const code = src(file).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""'); // drop string literals
        const calls = code.match(/console\.(log|info|warn|error|debug)\([^;]*\)/g) ?? [];
        for (const call of calls) {
            assert.doesNotMatch(call, /\b(seed|environment|AdditionalEnvironmentVariables|streamSession)\b/, `${file}: ${call}`);
        }
    }
});

test("seed confidentiality: stream responses only return the four safe fields", () => {
    for (const file of ["../lambdas/PlayTestStartStream/PlayTestStartStream.js", "../lambdas/PlayTestGetStream/PlayTestGetStream.js"]) {
        const code = src(file);
        assert.match(code, /signalResponse: streamSession\.SignalResponse \?\? '',\s*arn: streamSession\.Arn,\s*region: streamSession\.Location,\s*status: streamSession\.Status\s*\}/, file);
        assert.doesNotMatch(code, /JSON\.stringify\(streamSession\)/, file);
    }
});
