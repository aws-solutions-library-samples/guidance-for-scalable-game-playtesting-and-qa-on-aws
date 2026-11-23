// Unit tests for the Watermark Analyzer evidence API helpers.
// Run from source/:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    validateCreateRequest, validateSessionFilter, summarizeResult, groupSessions,
    sanitizeFileName, isEvidenceId, originalKey, lumaKey, reportKey, RequestError, trimTrailingSlashes,
} from "../lambdas/PlayTestWatermarkEvidence/evidenceLogic.js";

const ok = { contentType: "image/png", fileSize: 1000, width: 1920, height: 1080, fileName: "leak.png" };

test("create: accepts a normal PNG/JPEG/WebP screenshot", () => {
    for (const ct of ["image/png", "image/jpeg", "image/webp", "IMAGE/PNG"]) {
        assert.equal(validateCreateRequest({ ...ok, contentType: ct }).contentType, ct.toLowerCase());
    }
});

test("create: rejects other types, oversize files and tiny or huge images", () => {
    const bad = [
        { contentType: "image/gif" }, { contentType: "text/html" },
        { fileSize: 0 }, { fileSize: 25 * 1024 * 1024 + 1 }, { fileSize: 1.5 },
        { width: 255 }, { height: 100 }, { width: 8193 }, { width: 4096, height: 4097 }, { width: "x" },
    ];
    for (const b of bad) {
        assert.throws(() => validateCreateRequest({ ...ok, ...b }), (e) => e instanceof RequestError && e.statusCode === 400, JSON.stringify(b));
    }
});

test("create: the too-small message explains the 256 px minimum", () => {
    assert.throws(() => validateCreateRequest({ ...ok, width: 200 }), /at least 256 x 256 pixels/);
});

test("trimTrailingSlashes: same as the regex it replaced, and linear on hostile input", () => {
    for (const p of ["", "/", "///", "/watermark/evidence", "/watermark/evidence/", "/watermark/evidence///", "/a//b/", undefined, null]) {
        assert.equal(trimTrailingSlashes(p), String(p ?? "").replace(/\/+$/, ""), JSON.stringify(p));
    }
    const hostile = "/".repeat(200000) + "x";   // the pattern CodeQL reported: many '/'
    const t0 = process.hrtime.bigint();
    assert.equal(trimTrailingSlashes(hostile), hostile);
    assert.equal(trimTrailingSlashes("/".repeat(200000)), "");
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, "hostile paths should trim in well under 200 ms");
});

test("file names are made display-safe", () => {
    assert.equal(sanitizeFileName("C:\\Users\\me\\leak.png"), "leak.png");
    assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFileName('<img src=x onerror="a">.png'), "img src=x onerror=a.png");
    assert.equal(sanitizeFileName(""), "screenshot");
    assert.equal(sanitizeFileName("a".repeat(500)).length, 200);
});

test("session filter: empty means all; ids are validated", () => {
    assert.equal(validateSessionFilter(undefined), null);
    assert.equal(validateSessionFilter("  "), null);
    assert.equal(validateSessionFilter("sg-abc123--a-def456"), "sg-abc123--a-def456");
    assert.throws(() => validateSessionFilter("sg-x--a-y; DROP"), RequestError);
    assert.throws(() => validateSessionFilter("x".repeat(301)), RequestError);
});

test("evidence ids and S3 keys", () => {
    const id = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    assert.ok(isEvidenceId(id));
    assert.ok(!isEvidenceId("../" + id));
    assert.ok(!isEvidenceId("not-an-id"));
    assert.equal(originalKey(id, "image/jpeg"), `evidence/${id}/original.jpg`);
    assert.equal(reportKey(id), `evidence/${id}/report.json`);
    assert.equal(lumaKey(id), `work/${id}.luma`);
});

test("summary: identified result keeps who/where, never a seed", () => {
    const identified = { psr: 210.5, playtesterName: "alice", playtestingID: "sg-1--a-1", sessionName: "Weekend", game: "G", studio: "S",
        createdAt: "2026-11-01T10:00:00Z", location: "us-east-2", streamSessionArn: "arn:x", isAdmin: false };
    const s = summarizeResult({ results: [identified, { psr: 5 }], identified, separation: 205.5, threshold: 8, candidates_checked: 2 });
    assert.equal(s.outcome, "IDENTIFIED");
    assert.equal(s.identified.playtesterName, "alice");
    assert.equal(s.identified.streamStartedAt, "2026-11-01T10:00:00Z");
    assert.equal(s.topPsr, 210.5);
    assert.ok(!JSON.stringify(s).includes("seed"));
});

test("summary: below threshold is NOT_IDENTIFIED; no candidates is explained", () => {
    assert.equal(summarizeResult({ results: [{ psr: 5.6 }], identified: null, separation: 0.4 }).outcome, "NOT_IDENTIFIED");
    const none = summarizeResult({ error: "no_candidates", message: "No watermarked streams have been recorded for this playtest session." });
    assert.equal(none.outcome, "NO_CANDIDATES");
    assert.match(none.message, /No watermarked streams/);
});

test("summary: verifier errors become a 422 with the reason", () => {
    assert.throws(() => summarizeResult({ error: "image 100x100 smaller than one 256px tile" }), (e) => e.statusCode === 422 && /smaller than one 256px tile/.test(e.message));
});

test("sessions: grouped by playtest session, newest first, latest name wins", () => {
    const g = groupSessions([
        { playtestingID: "A", sessionName: "Old name", game: "G", createdAt: "2026-01-01" },
        { playtestingID: "B", sessionName: "B", game: "H", createdAt: "2026-03-01" },
        { playtestingID: "A", sessionName: "New name", game: "G", createdAt: "2026-02-01" },
        { sessionName: "no id" },
    ]);
    assert.deepEqual(g.map((s) => [s.playtestingID, s.streams, s.sessionName]), [["B", 1, "B"], ["A", 2, "New name"]]);
});
