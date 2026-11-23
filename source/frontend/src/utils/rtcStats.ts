/*
 * Turn WebRTC RTCStatsReport objects from the GameLift Streams SDK
 * (getVideoRTCStats / getAudioRTCStats) into a short list of readable figures for the
 * playtester page. Browsers report different fields, so any figure that is missing from
 * the report is left out rather than shown as blank.
 */

/** The part of RTCStatsReport used here; a Map of id -> stats object also satisfies it. */
export interface StatsReportLike {
    forEach(callback: (value: any) => void): void;
}

export interface StatRow {
    label: string;
    value: string;
}

function entries(report: StatsReportLike | undefined | null): any[] {
    const out: any[] = [];
    report?.forEach((v) => out.push(v));
    return out;
}

function find(report: any[], type: string, kind?: string): any | undefined {
    return report.find((s) => s?.type === type && (kind === undefined || s.kind === kind || s.mediaType === kind));
}

function isNum(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function codecName(report: any[], codecId: unknown): string | undefined {
    if (typeof codecId !== "string") return undefined;
    const codec = report.find((s) => s?.type === "codec" && s.id === codecId);
    if (!codec || typeof codec.mimeType !== "string") return undefined;
    const name = codec.mimeType.split("/").pop();
    return isNum(codec.clockRate) && codec.mimeType.startsWith("audio/")
        ? `${name} (${codec.clockRate / 1000} kHz)` : name;
}

// The candidate pair the connection is actually using: the transport's selected pair if the
// browser reports it, otherwise the nominated, succeeded pair.
function activePair(report: any[]): any | undefined {
    const transport = find(report, "transport");
    if (transport && typeof transport.selectedCandidatePairId === "string") {
        const pair = report.find((s) => s?.type === "candidate-pair" && s.id === transport.selectedCandidatePairId);
        if (pair) return pair;
    }
    return report.find((s) => s?.type === "candidate-pair" && s.state === "succeeded" && s.nominated)
        ?? report.find((s) => s?.type === "candidate-pair" && s.state === "succeeded");
}

function lossText(lost: unknown, received: unknown): string | undefined {
    if (!isNum(lost)) return undefined;
    const total = isNum(received) ? received + lost : 0;
    return total > 0 ? `${lost} (${((lost / total) * 100).toFixed(2)}%)` : `${lost}`;
}

/** Bits per second between two samples of the same inbound stream, or undefined. */
export function bitrateBps(earlier: any, later: any): number | undefined {
    if (!earlier || !later) return undefined;
    const bytes = later.bytesReceived - earlier.bytesReceived;
    const elapsedMs = later.timestamp - earlier.timestamp;
    if (!isNum(bytes) || !isNum(elapsedMs) || elapsedMs <= 0 || bytes < 0) return undefined;
    return (bytes * 8 * 1000) / elapsedMs;
}

function formatBitrate(bps: number): string {
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function ms(seconds: unknown): string | undefined {
    return isNum(seconds) ? `${Math.round(seconds * 1000)} ms` : undefined;
}

/**
 * Summarize the stream's current stats.
 * @param video        latest video report
 * @param audio        latest audio report (optional)
 * @param earlierVideo an earlier video report, used to measure bitrate (optional)
 */
export function summarizeRtcStats(
    video: StatsReportLike | undefined | null,
    audio?: StatsReportLike | null,
    earlierVideo?: StatsReportLike | null
): StatRow[] {
    const v = entries(video);
    const a = entries(audio);
    const rows: StatRow[] = [];
    const add = (label: string, value: string | undefined) => { if (value !== undefined) rows.push({ label, value }); };

    const vin = find(v, "inbound-rtp", "video");
    if (vin) {
        add("Resolution", isNum(vin.frameWidth) && isNum(vin.frameHeight) ? `${vin.frameWidth} x ${vin.frameHeight}` : undefined);
        add("Frame rate", isNum(vin.framesPerSecond) ? `${Math.round(vin.framesPerSecond)} fps` : undefined);
        const bps = bitrateBps(find(entries(earlierVideo), "inbound-rtp", "video"), vin);
        add("Video bitrate", bps !== undefined ? formatBitrate(bps) : undefined);
        add("Video codec", codecName(v, vin.codecId));
        add("Video packets lost", lossText(vin.packetsLost, vin.packetsReceived));
        add("Video jitter", ms(vin.jitter));
        add("Frames dropped", isNum(vin.framesDropped) ? `${vin.framesDropped}` : undefined);
        add("Freezes", isNum(vin.freezeCount) ? `${vin.freezeCount}` : undefined);
    }

    const pair = activePair(v) ?? activePair(a);
    if (pair) {
        add("Round-trip time", ms(pair.currentRoundTripTime));
        add("Available bandwidth", isNum(pair.availableIncomingBitrate) ? formatBitrate(pair.availableIncomingBitrate) : undefined);
    }

    const ain = find(a, "inbound-rtp", "audio");
    if (ain) {
        add("Audio codec", codecName(a, ain.codecId));
        add("Audio packets lost", lossText(ain.packetsLost, ain.packetsReceived));
        add("Audio jitter", ms(ain.jitter));
    }
    return rows;
}

/** Plain-text version of the rows, for copying into an observation or a bug report. */
export function statsToText(rows: StatRow[]): string {
    return rows.map((r) => `${r.label}: ${r.value}`).join("\n");
}
