/*
 * Watermark Analyzer API (admin only; the API authorizer denies Playtesters).
 *
 *   GET    /watermark/sessions                    playtest sessions with watermarked streams
 *   GET    /watermark/evidence                    list evidence records
 *   POST   /watermark/evidence                    create a record + presigned uploads
 *   GET    /watermark/evidence/{id}               record, report, screenshot URL
 *   POST   /watermark/evidence/{id}/analyze       run the verifier on the upload
 *   DELETE /watermark/evidence/{id}               permanently delete the evidence
 *
 * Screenshots never pass through API Gateway: the browser uploads the original and its
 * brightness (luma) plane straight to S3 with short-lived presigned POSTs, because the
 * API's WAF rejects bodies over 8 KB. Evidence is kept until an admin deletes it.
 */
import crypto from "crypto";
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
    RequestError, isEvidenceId, originalKey, reportKey, lumaKey,
    validateCreateRequest, validateSessionFilter, summarizeResult, groupSessions,
    MAX_ORIGINAL_BYTES,
} from "./evidenceLogic.js";

const BUCKET = process.env.EVIDENCE_BUCKET;
const EVIDENCE_TABLE = process.env.EVIDENCE_TABLE;
const SEED_TABLE = process.env.WATERMARK_SEED_TABLE;
const VERIFY_FN = process.env.VERIFY_FUNCTION;
const UPLOAD_EXPIRY_S = 300;
const VIEW_EXPIRY_S = 300;
// The verifier's own deadline. API Gateway gives the whole request 29s, so leave room
// for reading the upload, writing the report and replying.
const VERIFY_BUDGET_S = 16;

const s3 = new S3Client({});
const lam = new LambdaClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
};
const respond = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function getRecord(evidenceId) {
    const item = (await ddb.send(new GetCommand({ TableName: EVIDENCE_TABLE, Key: { evidenceId } }))).Item;
    if (!item) throw new RequestError(404, "That evidence record doesn't exist.");
    return item;
}

async function listSessions() {
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await ddb.send(new ScanCommand({
            TableName: SEED_TABLE,
            ProjectionExpression: "playtestingID, sessionName, game, createdAt",
            ExclusiveStartKey,
        }));
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < 10000);
    return respond(200, { sessions: groupSessions(items) });
}

async function listEvidence() {
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await ddb.send(new ScanCommand({ TableName: EVIDENCE_TABLE, ExclusiveStartKey }));
        items.push(...(out.Items ?? []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return respond(200, { evidence: items });
}

async function createEvidence(event, username) {
    const req = validateCreateRequest(JSON.parse(event.body || "{}"));
    const evidenceId = crypto.randomUUID();
    const lumaBytes = req.width * req.height;

    await ddb.send(new PutCommand({
        TableName: EVIDENCE_TABLE,
        Item: {
            evidenceId,
            createdAt: new Date().toISOString(),
            createdBy: username,
            fileName: req.fileName,
            contentType: req.contentType,
            fileSize: req.fileSize,
            width: req.width,
            height: req.height,
            preparation: req.preparation,
            status: "UPLOADING",
        },
        ConditionExpression: "attribute_not_exists(evidenceId)",
    }));

    // Each upload is bound to its exact key, type and size, so a URL can't be reused
    // to write anything else.
    const original = await createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: originalKey(evidenceId, req.contentType),
        Conditions: [["content-length-range", 1, Math.min(req.fileSize, MAX_ORIGINAL_BYTES)], ["eq", "$Content-Type", req.contentType]],
        Fields: { "Content-Type": req.contentType },
        Expires: UPLOAD_EXPIRY_S,
    });
    const luma = await createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: lumaKey(evidenceId),
        Conditions: [["content-length-range", lumaBytes, lumaBytes], ["eq", "$Content-Type", "application/octet-stream"]],
        Fields: { "Content-Type": "application/octet-stream" },
        Expires: UPLOAD_EXPIRY_S,
    });
    return respond(201, { evidenceId, uploads: { original, luma } });
}

async function sha256OfObject(key) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const hash = crypto.createHash("sha256");
    for await (const chunk of obj.Body) hash.update(chunk);
    return hash.digest("hex");
}

async function headOrNull(key) {
    try {
        return await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (e) {
        if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
    }
}

async function analyzeEvidence(event, evidenceId, username) {
    const body = JSON.parse(event.body || "{}");
    const sessionFilter = validateSessionFilter(body.playtestingID);
    const record = await getRecord(evidenceId);
    if (record.status === "ANALYZING") {
        throw new RequestError(409, "This screenshot is already being analyzed.");
    }

    const origKey = originalKey(evidenceId, record.contentType);
    const [orig, luma] = await Promise.all([headOrNull(origKey), headOrNull(lumaKey(evidenceId))]);
    if (!orig) throw new RequestError(409, "The screenshot hasn't finished uploading. Please try again.");
    if (!luma) {
        throw new RequestError(409, record.status === "COMPLETE"
            ? "This screenshot has already been analyzed. Upload it again to re-run the analysis."
            : "The prepared image hasn't finished uploading. Please try again.");
    }
    if (Number(luma.ContentLength) !== record.width * record.height) {
        throw new RequestError(400, "The prepared image doesn't match its declared size.");
    }

    await ddb.send(new UpdateCommand({
        TableName: EVIDENCE_TABLE,
        Key: { evidenceId },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "ANALYZING" },
    }));

    try {
        const [sha256, out] = await Promise.all([
            sha256OfObject(origKey),
            lam.send(new InvokeCommand({
                FunctionName: VERIFY_FN,
                Payload: Buffer.from(JSON.stringify({
                    width: record.width,
                    height: record.height,
                    s3_bucket: BUCKET,
                    s3_key: lumaKey(evidenceId),
                    playtestingID: sessionFilter ?? undefined,
                    search_scale: true,
                    budget_s: VERIFY_BUDGET_S,
                })),
            })),
        ]);
        const result = JSON.parse(Buffer.from(out.Payload ?? []).toString() || "{}");
        if (out.FunctionError) {
            console.error("verifier failed", out.FunctionError, result?.errorType);
            throw new RequestError(502, "The watermark verifier failed. Please try again.");
        }
        const summary = summarizeResult(result);
        const analyzedAt = new Date().toISOString();

        const report = {
            evidenceId,
            analyzedAt,
            analyzedBy: username,
            original: { key: origKey, fileName: record.fileName, contentType: record.contentType, bytes: Number(orig.ContentLength), sha256 },
            preparation: record.preparation,
            sessionFilter,
            summary,
            verifier: result,
        };
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: reportKey(evidenceId),
            Body: JSON.stringify(report, null, 2),
            ContentType: "application/json",
        }));

        const updated = (await ddb.send(new UpdateCommand({
            TableName: EVIDENCE_TABLE,
            Key: { evidenceId },
            UpdateExpression: "SET #s = :s, sha256 = :h, originalBytes = :b, analyzedAt = :t, analyzedBy = :u, sessionFilter = :f, outcome = :o, summary = :sum",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":s": "COMPLETE", ":h": sha256, ":b": Number(orig.ContentLength), ":t": analyzedAt, ":u": username,
                ":f": sessionFilter ?? "", ":o": summary.outcome, ":sum": summary,
            },
            ReturnValues: "ALL_NEW",
        }))).Attributes;

        // The luma plane is only an intermediate; the original and report are the evidence.
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: lumaKey(evidenceId) }))
            .catch((e) => console.error("could not delete the luma plane", e?.name));

        return respond(200, { record: updated, report });
    } catch (e) {
        await ddb.send(new UpdateCommand({
            TableName: EVIDENCE_TABLE,
            Key: { evidenceId },
            UpdateExpression: "SET #s = :s, failureReason = :r",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":s": "FAILED", ":r": String(e?.message ?? e).slice(0, 500) },
        })).catch(() => {});
        throw e;
    }
}

async function getEvidence(evidenceId) {
    const record = await getRecord(evidenceId);
    let report = null;
    if (record.status === "COMPLETE") {
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: reportKey(evidenceId) }));
        report = JSON.parse(await obj.Body.transformToString());
    }
    const origKey = originalKey(evidenceId, record.contentType);
    const screenshotUrl = (await headOrNull(origKey))
        ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: origKey }), { expiresIn: VIEW_EXPIRY_S })
        : null;
    return respond(200, { record, report, screenshotUrl });
}

async function deleteEvidence(evidenceId) {
    await getRecord(evidenceId);
    const keys = [{ Key: lumaKey(evidenceId) }];
    let ContinuationToken;
    do {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `evidence/${evidenceId}/`, ContinuationToken }));
        keys.push(...(out.Contents ?? []).map((o) => ({ Key: o.Key })));
        ContinuationToken = out.NextContinuationToken;
    } while (ContinuationToken);
    const del = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
    if (del.Errors?.length) {
        console.error("evidence delete errors", del.Errors.map((e) => e.Code));
        throw new RequestError(500, "Some evidence files couldn't be deleted. Please try again.");
    }
    await ddb.send(new DeleteCommand({ TableName: EVIDENCE_TABLE, Key: { evidenceId } }));
    return respond(200, { deleted: evidenceId });
}

export const handler = async (event) => {
    const method = event.httpMethod;
    const path = (event.path || "").replace(/\/+$/, "");
    const username = event.requestContext?.authorizer?.username ?? "unknown";
    const groups = String(event.requestContext?.authorizer?.groups ?? "").split(",");
    try {
        // Defence in depth: the authorizer already restricts these routes to Admins.
        if (!groups.includes("Admin")) throw new RequestError(403, "Only admins can use the Watermark Analyzer.");

        if (method === "GET" && path.endsWith("/watermark/sessions")) return await listSessions();
        if (method === "GET" && path.endsWith("/watermark/evidence")) return await listEvidence();
        if (method === "POST" && path.endsWith("/watermark/evidence")) return await createEvidence(event, username);

        const id = event.pathParameters?.evidenceId;
        if (id !== undefined) {
            if (!isEvidenceId(id)) throw new RequestError(400, "That evidence id is not valid.");
            if (method === "POST" && path.endsWith("/analyze")) return await analyzeEvidence(event, id, username);
            if (method === "GET") return await getEvidence(id);
            if (method === "DELETE") return await deleteEvidence(id);
        }
        return respond(404, { message: `No route for ${method} ${path}` });
    } catch (e) {
        if (e instanceof RequestError) return respond(e.statusCode, { message: e.message });
        if (e instanceof SyntaxError) return respond(400, { message: "Invalid request body." });
        console.error("watermark evidence request failed", e?.name, e?.message);
        return respond(500, { message: "Something went wrong. Please try again." });
    }
};
