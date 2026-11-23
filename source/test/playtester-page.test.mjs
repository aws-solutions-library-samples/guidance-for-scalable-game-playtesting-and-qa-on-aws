// Unit tests for the playtester page helpers (pure functions only).
// Node 24 runs the TypeScript source directly. Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTextEntryElement } from "../frontend/src/utils/streamInput.ts";
import { summarizeRtcStats, statsToText, bitrateBps } from "../frontend/src/utils/rtcStats.ts";

test("text fields count as typing targets (#40)", () => {
    assert.equal(isTextEntryElement({ tagName: "TEXTAREA" }), true);
    assert.equal(isTextEntryElement({ tagName: "INPUT", type: "text" }), true);
    assert.equal(isTextEntryElement({ tagName: "INPUT" }), true);
    assert.equal(isTextEntryElement({ tagName: "input", type: "search" }), true);
    assert.equal(isTextEntryElement({ tagName: "DIV", isContentEditable: true }), true);
});

test("non-text controls and empty targets are not typing targets (#40)", () => {
    for (const type of ["button", "checkbox", "radio", "range", "submit", "file"]) {
        assert.equal(isTextEntryElement({ tagName: "INPUT", type }), false, type);
    }
    assert.equal(isTextEntryElement({ tagName: "BUTTON" }), false);
    assert.equal(isTextEntryElement({ tagName: "VIDEO" }), false);
    assert.equal(isTextEntryElement({ tagName: "TEXTAREA", readOnly: true }), false);
    assert.equal(isTextEntryElement({ tagName: "TEXTAREA", disabled: true }), false);
    assert.equal(isTextEntryElement(null), false);
    assert.equal(isTextEntryElement(undefined), false);
});

const report = (...stats) => new Map(stats.map((s) => [s.id, s]));

const video1 = report(
    { id: "in", type: "inbound-rtp", kind: "video", timestamp: 1000, bytesReceived: 1_000_000 }
);
const video2 = report(
    { id: "in", type: "inbound-rtp", kind: "video", timestamp: 2000, bytesReceived: 1_750_000,
      frameWidth: 1920, frameHeight: 1080, framesPerSecond: 59.8, codecId: "c1",
      packetsLost: 5, packetsReceived: 995, jitter: 0.004, framesDropped: 2 },
    { id: "c1", type: "codec", mimeType: "video/H264" },
    { id: "t", type: "transport", selectedCandidatePairId: "p2" },
    { id: "p1", type: "candidate-pair", state: "failed", currentRoundTripTime: 0.9 },
    { id: "p2", type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.031 }
);
const audio = report(
    { id: "ain", type: "inbound-rtp", kind: "audio", codecId: "c2", packetsLost: 0, packetsReceived: 100, jitter: 0.002 },
    { id: "c2", type: "codec", mimeType: "audio/opus", clockRate: 48000 }
);

test("summarizes video, connection and audio stats (#42)", () => {
    const rows = Object.fromEntries(summarizeRtcStats(video2, audio, video1).map((r) => [r.label, r.value]));
    assert.deepEqual(rows, {
        "Resolution": "1920 x 1080",
        "Frame rate": "60 fps",
        "Video bitrate": "6.00 Mbps",
        "Video codec": "H264",
        "Video packets lost": "5 (0.50%)",
        "Video jitter": "4 ms",
        "Frames dropped": "2",
        "Round-trip time": "31 ms",
        "Audio codec": "opus (48 kHz)",
        "Audio packets lost": "0 (0.00%)",
        "Audio jitter": "2 ms"
    });
});

test("leaves out figures the browser did not report (#42)", () => {
    const rows = summarizeRtcStats(report({ id: "in", type: "inbound-rtp", kind: "video", framesPerSecond: 30 }));
    assert.deepEqual(rows, [{ label: "Frame rate", value: "30 fps" }]);
    assert.deepEqual(summarizeRtcStats(new Map()), []);
    assert.deepEqual(summarizeRtcStats(null, null, null), []);
});

test("falls back to the nominated succeeded candidate pair for round-trip time", () => {
    const rows = summarizeRtcStats(report(
        { id: "p", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.012 }
    ));
    assert.deepEqual(rows, [{ label: "Round-trip time", value: "12 ms" }]);
});

test("bitrate needs two ordered samples", () => {
    assert.equal(bitrateBps({ timestamp: 0, bytesReceived: 0 }, { timestamp: 500, bytesReceived: 12_500 }), 200_000);
    assert.equal(bitrateBps({ timestamp: 1000, bytesReceived: 0 }, { timestamp: 1000, bytesReceived: 10 }), undefined);
    assert.equal(bitrateBps(undefined, { timestamp: 1, bytesReceived: 1 }), undefined);
    const low = summarizeRtcStats(report({ id: "in", type: "inbound-rtp", kind: "video", timestamp: 1000, bytesReceived: 62_500 }),
        null, report({ id: "in", type: "inbound-rtp", kind: "video", timestamp: 0, bytesReceived: 0 }));
    assert.deepEqual(low, [{ label: "Video bitrate", value: "500 kbps" }]);
});

test("stats copy as one line per figure", () => {
    assert.equal(statsToText([{ label: "A", value: "1" }, { label: "B", value: "2" }]), "A: 1\nB: 2");
});
