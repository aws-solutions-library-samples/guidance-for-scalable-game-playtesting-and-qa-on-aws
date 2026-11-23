/*
 * Pure helpers for the Watermark Analyzer evidence API: request validation, S3 key
 * layout and result summaries. No AWS calls here, so it can be unit tested.
 */

export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;   // uploaded screenshot
export const MAX_LUMA_BYTES = 16 * 1024 * 1024;       // brightness plane (width * height)
export const MIN_DIMENSION = 256;                     // one watermark tile
export const MAX_DIMENSION = 8192;
export const DETECTION_THRESHOLD = 8;

export const CONTENT_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
};

const EVIDENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RequestError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

/**
 * Remove trailing "/" characters from a request path. A loop rather than a regular
 * expression, so it runs in linear time on any input (no backtracking).
 */
export function trimTrailingSlashes(path) {
    const s = String(path ?? "");
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
    return s.slice(0, end);
}

export function isEvidenceId(id) {
    return EVIDENCE_ID.test(String(id ?? ""));
}

export function originalKey(evidenceId, contentType) {
    return `evidence/${evidenceId}/original.${CONTENT_TYPES[contentType]}`;
}
export function reportKey(evidenceId) {
    return `evidence/${evidenceId}/report.json`;
}
export function lumaKey(evidenceId) {
    return `work/${evidenceId}.luma`;
}

/** Keep a display-safe file name: no path, no control characters, bounded length. */
export function sanitizeFileName(name) {
    const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
    const clean = base.replace(/[\u0000-\u001f\u007f<>"`]/g, "").trim();
    return (clean || "screenshot").slice(0, 200);
}

/** Validate a "create evidence" request. Returns the normalized upload description. */
export function validateCreateRequest(body) {
    const contentType = String(body?.contentType ?? "").toLowerCase();
    if (!CONTENT_TYPES[contentType]) {
        throw new RequestError(400, "The screenshot must be a PNG, JPEG or WebP image.");
    }
    const fileSize = Number(body?.fileSize);
    if (!Number.isInteger(fileSize) || fileSize <= 0) {
        throw new RequestError(400, "fileSize is required.");
    }
    if (fileSize > MAX_ORIGINAL_BYTES) {
        throw new RequestError(400, `The screenshot is too large. The limit is ${MAX_ORIGINAL_BYTES / 1024 / 1024} MB.`);
    }
    const width = Number(body?.width), height = Number(body?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
        throw new RequestError(400, "width and height are required.");
    }
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
        throw new RequestError(400, `The image is too small to hold a watermark. It must be at least ${MIN_DIMENSION} x ${MIN_DIMENSION} pixels.`);
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_LUMA_BYTES) {
        throw new RequestError(400, "The prepared image is too large to analyze.");
    }
    return {
        contentType,
        fileSize,
        width,
        height,
        fileName: sanitizeFileName(body?.fileName),
        preparation: String(body?.preparation ?? "").slice(0, 500),
    };
}

/** Optional playtest session filter: absent/empty means all sessions. */
export function validateSessionFilter(value) {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const id = String(value).trim();
    if (id.length > 300 || !/^[A-Za-z0-9_\-.]+$/.test(id)) {
        throw new RequestError(400, "The playtest session filter is not valid.");
    }
    return id;
}

/**
 * Condense a verifier result into the evidence record's summary. The verifier never
 * returns seeds; this keeps only what the evidence list needs.
 */
export function summarizeResult(result) {
    if (result?.error === "no_candidates") {
        return { outcome: "NO_CANDIDATES", message: result.message };
    }
    if (result?.error) {
        throw new RequestError(422, `The image couldn't be analyzed: ${result.message ?? result.error}`);
    }
    const top = result?.results?.[0];
    const identified = result?.identified;
    return {
        outcome: identified ? "IDENTIFIED" : "NOT_IDENTIFIED",
        topPsr: top ? top.psr : 0,
        separation: result?.separation ?? 0,
        threshold: result?.threshold ?? DETECTION_THRESHOLD,
        candidatesChecked: result?.candidates_checked ?? 0,
        identified: identified
            ? {
                playtesterName: identified.playtesterName,
                playtestingID: identified.playtestingID,
                sessionName: identified.sessionName,
                game: identified.game,
                studio: identified.studio,
                streamStartedAt: identified.createdAt,
                location: identified.location,
                streamSessionArn: identified.streamSessionArn,
                isAdmin: identified.isAdmin === true,
                psr: identified.psr,
            }
            : null,
    };
}

/** Group seed records into the list of playtest sessions that have watermarked streams. */
export function groupSessions(items) {
    const byId = new Map();
    for (const it of items ?? []) {
        if (!it?.playtestingID) continue;
        const cur = byId.get(it.playtestingID) ?? {
            playtestingID: it.playtestingID,
            sessionName: it.sessionName ?? "",
            game: it.game ?? "",
            streams: 0,
            lastStreamAt: "",
        };
        cur.streams += 1;
        if ((it.createdAt ?? "") > cur.lastStreamAt) {
            cur.lastStreamAt = it.createdAt;
            if (it.sessionName) cur.sessionName = it.sessionName;
            if (it.game) cur.game = it.game;
        }
        byId.set(it.playtestingID, cur);
    }
    return [...byId.values()].sort((a, b) => (b.lastStreamAt).localeCompare(a.lastStreamAt));
}
