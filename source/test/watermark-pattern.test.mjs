// Guards the one failure in forensic watermarking that is completely silent: if the
// pattern a host shader draws drifts from the one the verifier looks for, every stream
// still looks normal and every analysis just says "no watermark found".
//
// 1. The integer hash in the Proton shader (GLSL), the Windows shader (HLSL) and the
//    verifier (Python) must use the same constants and shifts in the same order.
// 2. A JavaScript port of that hash must reproduce golden fingerprints taken from the
//    verifier's pattern_for_seed() (sha256 of the 256x256 "+1 cell" bitmap).
// Replaces the upstream dxgiproxy/shaders/check-pattern.sh. Run from source/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const glsl = read("../watermark/host/layer/shaders/wm.frag");
const hlsl = read("../watermark/host/dxgiproxy/shaders/wm_ps.hlsl");
const py = read("../lambdas/PlayTestVerifyWatermark/handler.py");

// The ordered sequence of hash constants and shift amounts in a source's hash function.
function hashSequence(src, start, end) {
    const body = src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
    return [...body.matchAll(/0x[0-9A-Fa-f]{8}|>>\s*(?:u\()?(\d+)/g)].map((m) => (m[1] ? `>>${m[1]}` : m[0].toUpperCase().replace("0X", "0x")));
}

test("shader and verifier hashes use identical constants and shifts", () => {
    const g = hashSequence(glsl, "uint wmhash", "return h");
    const h = hashSequence(hlsl, "uint wmhash", "return h");
    const p = hashSequence(py, "def pattern_for_seed", "p = np.where");
    const expected = ["0x9E3779B1", "0x85EBCA77", "0x27D4EB2F", ">>15", "0x2C1B3C6D", ">>12", "0x297A2D39", ">>15"];
    assert.deepEqual(g, expected, "GLSL (Proton) hash changed");
    assert.deepEqual(h, expected, "HLSL (Windows) hash changed");
    assert.deepEqual(p, expected, "verifier hash changed");
});

test("shaders and verifier agree on the tile and which cells are +1", () => {
    assert.match(py, /^TILE = 256$/m);
    for (const [name, src] of [["GLSL", glsl], ["HLSL", hlsl]]) {
        assert.match(src, /\(wmhash\(x, y\) & 1u\) == 0u\) \? 1\.0 : 0\.0/, `${name}: +1 cells are where the hash's low bit is 0`);
    }
    assert.match(py, /np\.where\(\(h & u\(1\)\) == u\(0\), 1\.0, -1\.0\)/, "verifier: +1 cells are where the hash's low bit is 0");
});

// JavaScript port of the shared hash (uint32 arithmetic).
function bitmap(seedHex) {
    const lo = parseInt(seedHex.slice(0, 8), 16) >>> 0, hi = parseInt(seedHex.slice(8, 16), 16) >>> 0;
    const out = new Uint8Array(256 * 256);
    const hiMix = Math.imul(hi, 0x27D4EB2F) >>> 0;
    for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
            let h = (lo ^ Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ hiMix) >>> 0;
            h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x2C1B3C6D) >>> 0;
            h = (h ^ (h >>> 12)) >>> 0; h = Math.imul(h, 0x297A2D39) >>> 0;
            h = (h ^ (h >>> 15)) >>> 0;
            out[y * 256 + x] = (h & 1) === 0 ? 1 : 0;
        }
    }
    return out;
}

// Golden values from the verifier: sha256((pattern_for_seed(seed) > 0).astype(uint8)), count.
const GOLDEN = {
    "0123456789abcdef0123456789abcdef": ["06a069b6af51ca8158f48ad22d59bc094ad672c24e54506a4a1487cbb643db4c", 32956],
    "ffffffffffffffffffffffffffffffff": ["eba1067f481a95e992b53ee1888f0cfbe7bd8e5d17b75546244d8cfc86a76984", 32620],
    "00000000000000000000000000000000": ["df1020ed76dfa13b127e12f445d23af74f8722005115d6cc9e36ede44ca22672", 32763],
    "a3f1c08e52b7d461a3f1c08e52b7d461": ["fedb4de473b795c9312ef70ba6b6a9c3586e3161352d530b7e11587e34e6eef5", 32688],
};

test("the shared hash reproduces the verifier's pattern bit for bit", () => {
    for (const [seed, [sha, ones]] of Object.entries(GOLDEN)) {
        const b = bitmap(seed);
        assert.equal(b.reduce((a, v) => a + v, 0), ones, `${seed.slice(0, 8)}: +1 cell count`);
        assert.equal(crypto.createHash("sha256").update(b).digest("hex"), sha, `${seed.slice(0, 8)}: bitmap fingerprint`);
    }
});
