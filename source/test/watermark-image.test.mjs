// Unit tests for the analyzer's in-browser image preparation (pure functions only).
// Node 24 runs the TypeScript source directly. Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { lumaFromRgba, findContentBox, checkFile } from "../frontend/src/utils/watermarkImage.ts";

const rgba = (w, h, fill) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [r, g, b] = fill(x, y); const i = (y * w + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
    return px;
};

test("luma: BT.601 with rounding, matching the verifier's reference conversion", () => {
    // Reference: round(0.299 R + 0.587 G + 0.114 B), as in the upstream console and PIL "L".
    const samples = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [12, 200, 77], [128, 128, 128], [254, 1, 133]];
    const px = rgba(samples.length, 1, (x) => samples[x]);
    const y = lumaFromRgba(px, samples.length, 1);
    samples.forEach(([r, g, b], i) => assert.equal(y[i], Math.floor(0.299 * r + 0.587 * g + 0.114 * b + 0.5), `rgb ${r},${g},${b}`));
    // grey stays grey, so a grayscale screenshot's luma is its own pixel values
    for (let v = 0; v <= 255; v += 17) assert.equal(lumaFromRgba(rgba(1, 1, () => [v, v, v]), 1, 1)[0], v);
});

test("letterbox: a frame centred in black bars is trimmed to the content", () => {
    const w = 1000, h = 800, top = 80, bottom = 720; // bars total 20% of the height
    const px = rgba(w, h, (x, y) => (y < top || y >= bottom ? [0, 0, 0] : [90 + (x % 40), 120, 60]));
    assert.deepEqual(findContentBox(px, w, h), { x: 0, y: top, w, h: bottom - top });
});

test("letterbox: bars totalling 25% or more are left alone (upstream rule)", () => {
    const w = 1000, h = 800;
    const px = rgba(w, h, (x, y) => (y < 100 || y >= 700 ? [0, 0, 0] : [90, 120, 60])); // exactly 25%
    assert.equal(findContentBox(px, w, h), null);
});

test("letterbox: dark game content is not mistaken for bars", () => {
    const w = 400, h = 300;
    // bars over 25% of the height are implausible as letterbox
    const px = rgba(w, h, (x, y) => (y < 120 ? [5, 5, 5] : [100, 100, 100]));
    assert.equal(findContentBox(px, w, h), null);
    // no bars at all
    assert.equal(findContentBox(rgba(w, h, () => [80, 90, 100]), w, h), null);
});

test("file checks: type, size and empty files", () => {
    const f = (type, size) => ({ type, size });
    assert.equal(checkFile(f("image/png", 1000)), null);
    assert.equal(checkFile(f("image/webp", 1000)), null);
    assert.match(checkFile(f("image/gif", 1000)), /PNG, JPEG or WebP/);
    assert.match(checkFile(f("image/jpeg", 25 * 1024 * 1024 + 1)), /25 MB/);
    assert.match(checkFile(f("image/jpeg", 0)), /empty/);
});
