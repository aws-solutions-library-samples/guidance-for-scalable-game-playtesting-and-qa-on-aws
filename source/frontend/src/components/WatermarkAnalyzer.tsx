/*
 * Watermark Analyzer (admin only): identify which playtester and playtest session a
 * screenshot of leaked footage came from, and manage the saved evidence.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { get, post, del } from "aws-amplify/api";
import { fetchAuthSession } from "aws-amplify/auth";
import {
    Alert, Box, Button, ColumnLayout, Container, ExpandableSection, FileUpload, FormField,
    Header, KeyValuePairs, Modal, Select, SelectProps, SpaceBetween, StatusIndicator, Table,
} from "@cloudscape-design/components";
import { apiErrorMessage } from "./Utility/apiErrorMessage";
import { checkFile, prepareImageFile, PreparedImage } from "../utils/watermarkImage";

const API = "playtesting-api";
const ALL_SESSIONS: SelectProps.Option = { label: "All sessions", value: "" };

interface WatermarkSession { playtestingID: string; sessionName: string; game: string; streams: number; lastStreamAt: string; }
interface Identified {
    playtesterName: string; playtestingID: string; sessionName: string; game: string; studio: string;
    streamStartedAt: string; location: string; streamSessionArn: string; isAdmin: boolean; psr: number;
}
interface Summary {
    outcome: "IDENTIFIED" | "NOT_IDENTIFIED" | "NO_CANDIDATES";
    topPsr?: number; separation?: number; threshold?: number; candidatesChecked?: number;
    identified?: Identified | null; message?: string;
}
interface EvidenceRecord {
    evidenceId: string; createdAt: string; createdBy: string; fileName: string; contentType: string;
    width: number; height: number; status: string; outcome?: string; summary?: Summary;
    sha256?: string; originalBytes?: number; analyzedAt?: string; analyzedBy?: string;
    sessionFilter?: string; failureReason?: string; preparation?: string;
}
interface Candidate { psr: number; playtesterName: string; playtestingID: string; sessionName: string; createdAt: string; }
interface Report {
    summary: Summary;
    sessionFilter: string | null;
    original: { fileName: string; bytes: number; sha256: string };
    verifier: {
        results?: Candidate[];
        image?: { width: number; height: number; tiles_folded: number; scale_used: number };
        scale_searched?: boolean; scales_scanned?: number; search_seconds?: number; elapsed_ms?: number;
    };
}

async function authHeaders() {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(await fetchAuthSession()).tokens?.idToken?.toString()}`,
    };
}

async function apiGet<T>(path: string): Promise<T> {
    const op = get({ apiName: API, path, options: { headers: await authHeaders() } });
    return JSON.parse(await (await op.response).body.text()) as T;
}

async function apiPost<T>(path: string, body: object): Promise<T> {
    const op = post({ apiName: API, path, options: { headers: await authHeaders(), body: body as any } });
    return JSON.parse(await (await op.response).body.text()) as T;
}

/** Upload one part to S3 with a presigned POST (fields first, file last). */
async function presignedUpload(upload: { url: string; fields: Record<string, string> }, data: Blob, what: string) {
    const form = new FormData();
    Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
    form.append("file", data);
    const res = await fetch(upload.url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Uploading the ${what} failed (HTTP ${res.status}). Please try again.`);
}

const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "-");
const shortId = (id?: string) => (id && id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-12)}` : id ?? "-");

function sessionLabel(id: string | undefined, sessions: WatermarkSession[]) {
    if (!id) return "All sessions";
    const s = sessions.find((x) => x.playtestingID === id);
    return s ? `${s.sessionName || shortId(id)}${s.game ? ` (${s.game})` : ""}` : shortId(id);
}

/** Outcome badge used in the result card and the evidence table. */
function OutcomeIndicator({ record }: { record: Pick<EvidenceRecord, "status" | "outcome" | "summary"> }) {
    if (record.status === "FAILED") return <StatusIndicator type="error">Analysis failed</StatusIndicator>;
    if (record.status === "UPLOADING") return <StatusIndicator type="stopped">Not analyzed</StatusIndicator>;
    if (record.status === "ANALYZING") return <StatusIndicator type="in-progress">Analyzing</StatusIndicator>;
    switch (record.outcome ?? record.summary?.outcome) {
        case "IDENTIFIED": return <StatusIndicator type="warning">Watermark identified</StatusIndicator>;
        case "NO_CANDIDATES": return <StatusIndicator type="info">No watermarked streams</StatusIndicator>;
        default: return <StatusIndicator type="success">No watermark found</StatusIndicator>;
    }
}

/** Plain-language strength of an identification. */
function confidence(s: Summary) {
    const psr = s.identified?.psr ?? 0, sep = s.separation ?? 0;
    if (psr >= 40 && sep >= 30) return "Strong match. The detection score is far above the threshold and far above every other playtester.";
    if (psr >= 15 && sep >= 8) return "Clear match. The detection score is well above the threshold and clearly separated from every other playtester.";
    return "Weak match. The score is only just above the threshold. Try a sharper, higher-resolution frame to confirm.";
}

function ResultSummary({ summary }: { summary: Summary }) {
    if (summary.outcome === "IDENTIFIED" && summary.identified) {
        const id = summary.identified;
        return (
            <SpaceBetween size="m">
                <Alert type="warning" header={`Watermark identified: ${id.playtesterName}`}>{confidence(summary)}</Alert>
                {id.isAdmin && <Alert type="info">This stream was started by an admin account, not a playtester.</Alert>}
                <KeyValuePairs columns={3} items={[
                    { label: "Playtester", value: id.playtesterName },
                    { label: "Playtest session", value: id.sessionName || shortId(id.playtestingID) },
                    { label: "Game", value: [id.game, id.studio].filter(Boolean).join(" / ") || "-" },
                    { label: "Stream started", value: formatDate(id.streamStartedAt) },
                    { label: "Stream region", value: id.location || "-" },
                    { label: "Detection score", value: `${id.psr.toFixed(1)} (match threshold ${summary.threshold ?? 8})` },
                    { label: "Gap to next playtester", value: (summary.separation ?? 0).toFixed(1) },
                    { label: "Watermarked streams compared", value: String(summary.candidatesChecked ?? "-") },
                    { label: "Session ID", value: <Box variant="code">{id.playtestingID}</Box> },
                ]} />
            </SpaceBetween>
        );
    }
    if (summary.outcome === "NO_CANDIDATES") {
        return <Alert type="info" header="Nothing to compare against">{summary.message} Watermark records are created each time a playtester starts a stream in a watermarked session.</Alert>;
    }
    return (
        <Alert type="success" header="No watermark found">
            <SpaceBetween size="xs">
                <div>No recorded watermark scored above the match threshold (best score {(summary.topPsr ?? 0).toFixed(1)}, threshold {summary.threshold ?? 8}, {summary.candidatesChecked ?? 0} streams compared).</div>
                <div>Common reasons: the playtest session wasn't watermarked; the wrong session was selected (try <b>All sessions</b>); the image is rotated at an angle; or the frame is too small, blurry, dark or heavily processed. A sharper frame at full resolution gives the best result.</div>
            </SpaceBetween>
        </Alert>
    );
}

function ReportDetails({ report }: { report: Report }) {
    const v = report.verifier ?? {};
    return (
        <ExpandableSection headerText="Details">
            <SpaceBetween size="m">
                <KeyValuePairs columns={3} items={[
                    { label: "Analyzed image", value: v.image ? `${v.image.width} x ${v.image.height}` : "-" },
                    { label: "Watermark tiles folded", value: String(v.image?.tiles_folded ?? "-") },
                    { label: "Scale used", value: v.image ? `${v.image.scale_used}x${v.scale_searched ? ` (searched ${v.scales_scanned} scales)` : ""}` : "-" },
                    { label: "Analysis time", value: v.search_seconds !== undefined ? `${v.search_seconds}s` : "-" },
                    { label: "Original file", value: `${report.original?.fileName} (${Math.round((report.original?.bytes ?? 0) / 1024)} KB)` },
                    { label: "SHA-256 of original", value: <Box variant="code" fontSize="body-s">{report.original?.sha256}</Box> },
                ]} />
                <Table
                    variant="embedded"
                    header={<Header variant="h3" description="Highest-scoring recorded streams. A real match scores far above the rest.">Closest candidates</Header>}
                    items={v.results ?? []}
                    columnDefinitions={[
                        { id: "psr", header: "Score", cell: (c) => c.psr.toFixed(1) },
                        { id: "who", header: "Playtester", cell: (c) => c.playtesterName },
                        { id: "session", header: "Session", cell: (c) => c.sessionName || shortId(c.playtestingID) },
                        { id: "when", header: "Stream started", cell: (c) => formatDate(c.createdAt) },
                    ]}
                    empty="No candidates"
                />
            </SpaceBetween>
        </ExpandableSection>
    );
}

export default function WatermarkAnalyzer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [sessions, setSessions] = useState<WatermarkSession[]>([]);
    const [sessionOption, setSessionOption] = useState<SelectProps.Option>(ALL_SESSIONS);
    const [files, setFiles] = useState<File[]>([]);
    const [prepared, setPrepared] = useState<PreparedImage | null>(null);
    const [fileError, setFileError] = useState("");
    const [analyzing, setAnalyzing] = useState(false);
    const [stage, setStage] = useState("");
    const [error, setError] = useState("");
    const [result, setResult] = useState<{ record: EvidenceRecord; report: Report } | null>(null);

    const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
    const [loadingEvidence, setLoadingEvidence] = useState(true);
    const [selected, setSelected] = useState<EvidenceRecord[]>([]);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [view, setView] = useState<{ record: EvidenceRecord; report: Report | null; screenshotUrl: string | null } | null>(null);
    const [listError, setListError] = useState("");

    const loadEvidence = useCallback(async () => {
        setLoadingEvidence(true);
        try {
            setEvidence((await apiGet<{ evidence: EvidenceRecord[] }>("/watermark/evidence")).evidence);
            setListError("");
        } catch (e) {
            setListError(apiErrorMessage(e, "The evidence list couldn't be loaded."));
        } finally {
            setLoadingEvidence(false);
        }
    }, []);

    useEffect(() => {
        apiGet<{ sessions: WatermarkSession[] }>("/watermark/sessions")
            .then((r) => setSessions(r.sessions))
            .catch((e) => setError(apiErrorMessage(e, "The list of watermarked sessions couldn't be loaded.")));
        loadEvidence();
    }, [loadEvidence]);

    const onFileChange = async (next: File[]) => {
        setFiles(next);
        setPrepared(null);
        setResult(null);
        setFileError("");
        setError("");
        const file = next[0];
        if (!file) return;
        const problem = checkFile(file);
        if (problem) { setFileError(problem); return; }
        try {
            setPrepared(await prepareImageFile(file, canvasRef.current!));
        } catch (e: any) {
            setFileError(e?.message ?? "The image couldn't be read.");
        }
    };

    const analyze = async () => {
        const file = files[0];
        if (!file || !prepared) return;
        setAnalyzing(true);
        setError("");
        setResult(null);
        try {
            setStage("Uploading the screenshot…");
            const created = await apiPost<{ evidenceId: string; uploads: { original: any; luma: any } }>("/watermark/evidence", {
                fileName: file.name, contentType: file.type, fileSize: file.size,
                width: prepared.width, height: prepared.height, preparation: prepared.note,
            });
            await Promise.all([
                presignedUpload(created.uploads.original, file, "screenshot"),
                presignedUpload(created.uploads.luma, new Blob([prepared.luma as BlobPart], { type: "application/octet-stream" }), "prepared image"),
            ]);
            setStage("Analyzing. This can take up to 20 seconds when the screenshot's scale has to be searched…");
            const out = await apiPost<{ record: EvidenceRecord; report: Report }>(`/watermark/evidence/${created.evidenceId}/analyze`, {
                playtestingID: sessionOption.value || undefined,
            });
            setResult(out);
            loadEvidence();
        } catch (e) {
            setError(apiErrorMessage(e, e instanceof Error ? e.message : "The screenshot couldn't be analyzed."));
            loadEvidence();
        } finally {
            setAnalyzing(false);
            setStage("");
        }
    };

    const openRecord = async (record: EvidenceRecord) => {
        try {
            setView(await apiGet(`/watermark/evidence/${record.evidenceId}`));
        } catch (e) {
            setListError(apiErrorMessage(e, "That evidence record couldn't be opened."));
        }
    };

    const deleteSelected = async () => {
        setDeleting(true);
        const failed: string[] = [];
        for (const r of selected) {
            try {
                await (del({ apiName: API, path: `/watermark/evidence/${r.evidenceId}`, options: { headers: await authHeaders() } })).response;
            } catch {
                failed.push(r.fileName);
            }
        }
        setDeleting(false);
        setConfirmDelete(false);
        setSelected([]);
        if (result && selected.some((r) => r.evidenceId === result.record.evidenceId)) setResult(null);
        if (failed.length) setListError(`These couldn't be deleted: ${failed.join(", ")}. Please try again.`);
        loadEvidence();
    };

    const sessionOptions: SelectProps.Option[] = [
        ALL_SESSIONS,
        ...sessions.map((s) => ({
            label: s.sessionName || shortId(s.playtestingID),
            value: s.playtestingID,
            description: [s.game, `${s.streams} watermarked stream${s.streams === 1 ? "" : "s"}`, `last ${formatDate(s.lastStreamAt)}`].filter(Boolean).join(" · "),
        })),
    ];

    return (
        <SpaceBetween size="l">
            <canvas ref={canvasRef} style={{ display: "none" }} />

            <Container header={
                <Header variant="h2" description="Find out which playtester and playtest session a screenshot of leaked footage came from. Only works for playtest sessions with forensic watermarking turned on.">
                    Watermark Analyzer
                </Header>
            }>
                <SpaceBetween size="l">
                    {error && <Alert type="error" dismissible onDismiss={() => setError("")} header="The screenshot wasn't analyzed">{error}</Alert>}
                    <ColumnLayout columns={2}>
                        <SpaceBetween size="m">
                            <FormField label="Playtest session" description="Choose the session you think the footage came from, or All sessions if you're not sure. One session is faster and more reliable.">
                                <Select selectedOption={sessionOption} onChange={({ detail }) => setSessionOption(detail.selectedOption)}
                                    options={sessionOptions} filteringType="auto" empty="No watermarked streams have been recorded yet" disabled={analyzing} />
                            </FormField>
                            <FormField label="Screenshot" errorText={fileError}
                                description="PNG, JPEG or WebP, at least 256 x 256 pixels. Use the sharpest frame you can: pause the video at full screen and highest quality, and crop out the player if you can."
                                constraintText="Black letterbox bars are trimmed automatically.">
                                <FileUpload value={files} onChange={({ detail }) => onFileChange(detail.value)} accept="image/png,image/jpeg,image/webp"
                                    showFileSize showFileThumbnail constraintText=""
                                    i18nStrings={{
                                        uploadButtonText: (multiple) => (multiple ? "Choose files" : "Choose screenshot"),
                                        dropzoneText: () => "Drop a screenshot here",
                                        removeFileAriaLabel: () => "Remove screenshot",
                                        limitShowFewer: "Show fewer", limitShowMore: "Show more", errorIconAriaLabel: "Error",
                                    }} />
                            </FormField>
                            <SpaceBetween direction="horizontal" size="s" alignItems="center">
                                <Button variant="primary" onClick={analyze} loading={analyzing} disabled={!prepared || !!fileError}>Analyze</Button>
                                {stage && <StatusIndicator type="loading">{stage}</StatusIndicator>}
                            </SpaceBetween>
                        </SpaceBetween>
                        <div>
                            {prepared && (
                                <SpaceBetween size="xs">
                                    <Box variant="awsui-key-label">Image to analyze</Box>
                                    <img src={prepared.preview} alt="Screenshot to analyze" style={{ maxWidth: "100%", maxHeight: 300, border: "1px solid #e9ebed" }} />
                                    <Box color="text-body-secondary" fontSize="body-s">{prepared.note}</Box>
                                </SpaceBetween>
                            )}
                        </div>
                    </ColumnLayout>

                    {result && (
                        <Container header={<Header variant="h3" description={`Saved as evidence · ${formatDate(result.record.analyzedAt)} · compared against ${sessionLabel(result.record.sessionFilter, sessions)}`}>Result</Header>}>
                            <SpaceBetween size="m">
                                <ResultSummary summary={result.record.summary!} />
                                <ReportDetails report={result.report} />
                            </SpaceBetween>
                        </Container>
                    )}
                </SpaceBetween>
            </Container>

            <Table
                header={
                    <Header variant="h2" counter={`(${evidence.length})`}
                        description="Every analysis is saved with the screenshot, the result, who ran it and a SHA-256 fingerprint of the file. Evidence is kept until you delete it."
                        actions={
                            <SpaceBetween direction="horizontal" size="xs">
                                <Button iconName="refresh" ariaLabel="Refresh" onClick={loadEvidence} />
                                <Button disabled={selected.length !== 1} onClick={() => openRecord(selected[0])}>View</Button>
                                <Button disabled={selected.length === 0} onClick={() => setConfirmDelete(true)}>Delete</Button>
                            </SpaceBetween>
                        }>
                        Evidence
                    </Header>
                }
                loading={loadingEvidence}
                loadingText="Loading evidence"
                items={evidence}
                trackBy="evidenceId"
                selectionType="multi"
                selectedItems={selected}
                onSelectionChange={({ detail }) => setSelected(detail.selectedItems)}
                empty={<Box textAlign="center" color="inherit">No evidence yet. Analyze a screenshot to create a record.</Box>}
                columnDefinitions={[
                    { id: "createdAt", header: "Date", cell: (r) => formatDate(r.createdAt), sortingField: "createdAt" },
                    { id: "file", header: "Screenshot", cell: (r) => <Button variant="inline-link" onClick={() => openRecord(r)}>{r.fileName}</Button> },
                    { id: "outcome", header: "Result", cell: (r) => <OutcomeIndicator record={r} /> },
                    { id: "who", header: "Identified playtester", cell: (r) => r.summary?.identified?.playtesterName ?? "-" },
                    { id: "session", header: "Session", cell: (r) => r.summary?.identified?.sessionName || (r.summary?.identified ? shortId(r.summary.identified.playtestingID) : "-") },
                    { id: "score", header: "Score", cell: (r) => (r.summary?.topPsr !== undefined ? r.summary.topPsr.toFixed(1) : "-") },
                    { id: "by", header: "Run by", cell: (r) => r.analyzedBy ?? r.createdBy },
                ]}
            />
            {listError && <Alert type="error" dismissible onDismiss={() => setListError("")}>{listError}</Alert>}

            <Modal visible={confirmDelete} onDismiss={() => setConfirmDelete(false)} header="Delete evidence"
                footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
                    <Button variant="link" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    <Button variant="primary" loading={deleting} onClick={deleteSelected}>Delete permanently</Button>
                </SpaceBetween></Box>}>
                This permanently deletes {selected.length === 1 ? `the evidence for "${selected[0]?.fileName}"` : `${selected.length} evidence records`}, including the screenshot{selected.length === 1 ? "" : "s"} and the analysis result{selected.length === 1 ? "" : "s"}. This can't be undone.
            </Modal>

            <Modal visible={!!view} onDismiss={() => setView(null)} size="large"
                header={view ? `Evidence: ${view.record.fileName}` : ""}
                footer={<Box float="right"><Button onClick={() => setView(null)}>Close</Button></Box>}>
                {view && (
                    <SpaceBetween size="m">
                        <KeyValuePairs columns={3} items={[
                            { label: "Uploaded", value: `${formatDate(view.record.createdAt)} by ${view.record.createdBy}` },
                            { label: "Analyzed", value: view.record.analyzedAt ? `${formatDate(view.record.analyzedAt)} by ${view.record.analyzedBy}` : "-" },
                            { label: "Compared against", value: sessionLabel(view.record.sessionFilter, sessions) },
                        ]} />
                        {view.screenshotUrl
                            ? <img src={view.screenshotUrl} alt={view.record.fileName} style={{ maxWidth: "100%", maxHeight: 420 }} />
                            : <Alert type="info">The screenshot file isn't available.</Alert>}
                        {view.record.status === "FAILED" && <Alert type="error" header="Analysis failed">{view.record.failureReason}</Alert>}
                        {view.report && <ResultSummary summary={view.report.summary} />}
                        {view.report && <ReportDetails report={view.report} />}
                    </SpaceBetween>
                )}
            </Modal>
        </SpaceBetween>
    );
}
