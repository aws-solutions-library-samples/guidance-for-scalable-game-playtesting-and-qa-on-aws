/*
 * Forensic watermarking: per-playtest-session settings and the game package check.
 *
 * The watermark is drawn on the GameLift Streams host by components that must ship
 * inside the game's application package (a Vulkan layer on Proton, a proxy dxgi.dll
 * on Windows). If they are missing, the stream still plays normally but carries no
 * mark, and that would only be discovered when a leak can't be traced. So when an
 * admin turns watermarking on, we verify the package and refuse with a clear message
 * instead of failing silently.
 */

export const WATERMARK_ALPHA_DEFAULT = 8;
export const WATERMARK_ALPHA_MIN = 1;
export const WATERMARK_ALPHA_MAX = 64;

// Runtimes the watermark host components support. Ubuntu has no injection path.
export const WATERMARK_RUNTIMES = ["PROTON", "WINDOWS"];

// Files the host components need, relative to the package root (Proton) or to the
// executable's folder (Windows, where the DLL search order only looks next to the exe).
const PROTON_FILES = [
    "wmlayer/libVkLayer_wmpoc.so",
    "xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json",
];
const WINDOWS_FILE = "dxgi.dll";

// Where each required file lives in the deployment's watermark payload bucket
// (uploaded by the stack from source/watermark/build/), matched on the end of the key.
const PAYLOAD_KEYS = {
    PROTON: {
        "wmlayer/libVkLayer_wmpoc.so": "proton/wmlayer/libVkLayer_wmpoc.so",
        "xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json": "proton/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json",
    },
    WINDOWS: { "dxgi.dll": "windows/dxgi.dll" },
};

// Object metadata stamped on every watermark component the solution writes into a game
// folder, so we can tell our own files (safe to replace with a newer build) from a file
// the game ships itself (never overwritten). S3 returns metadata keys in lower case.
export const COMPONENT_METADATA_KEY = "playtesting-watermark";
export const COMPONENT_METADATA_VALUE = "component";

/** Error whose message is safe and useful to show to the admin. */
export class WatermarkConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "WatermarkConfigError";
    }
}

/**
 * Normalize the watermark fields from a request body.
 * Returns { watermarkEnabled: boolean, watermarkAlpha: number }.
 * Absent fields mean "off, default strength", so existing sessions and older
 * clients keep working.
 */
export function normalizeWatermarkSettings(body) {
    const watermarkEnabled = body?.watermarkEnabled === true || body?.watermarkEnabled === "true";

    const raw = body?.watermarkAlpha;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return { watermarkEnabled, watermarkAlpha: WATERMARK_ALPHA_DEFAULT };
    }
    const watermarkAlpha = Number(raw);
    if (!Number.isFinite(watermarkAlpha) || watermarkAlpha < WATERMARK_ALPHA_MIN || watermarkAlpha > WATERMARK_ALPHA_MAX) {
        throw new WatermarkConfigError(
            `Watermark strength must be a number between ${WATERMARK_ALPHA_MIN} and ${WATERMARK_ALPHA_MAX}.`
        );
    }
    return { watermarkEnabled, watermarkAlpha };
}

// Longest s3:// URI we accept: "s3://" + a 63-character bucket name + "/" + a 1,024-byte key.
const MAX_S3_URI_LENGTH = 5 + 63 + 1 + 1024;

/**
 * Split "s3://bucket/some/prefix" into { bucket, prefix } with prefix ending in "/" (or "").
 * Plain string operations rather than a regular expression, so it runs in linear time on
 * any input (no backtracking), and the input length is bounded.
 */
export function parseS3Uri(uri) {
    const s = String(uri ?? "").trim();
    const invalid = () => new WatermarkConfigError(`The game location "${s.slice(0, 200)}" is not an s3:// path.`);
    if (s.length > MAX_S3_URI_LENGTH || s.slice(0, 5).toLowerCase() !== "s3://") throw invalid();
    const rest = s.slice(5);
    const slash = rest.indexOf("/");
    const bucket = slash < 0 ? rest : rest.slice(0, slash);
    if (!bucket) throw invalid();
    let prefix = slash < 0 ? "" : rest.slice(slash + 1);
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    return { bucket, prefix };
}

/**
 * The S3 keys that must exist for the watermark to render.
 * executablePath is relative to the package root, as GameLift Streams stores it.
 */
export function requiredWatermarkKeys({ sourceUri, executablePath, runtimeType }) {
    const { bucket, prefix } = parseS3Uri(sourceUri);

    if (runtimeType === "PROTON") {
        return { bucket, keys: PROTON_FILES.map((f) => prefix + f) };
    }

    if (runtimeType === "WINDOWS") {
        const exe = String(executablePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!exe) {
            throw new WatermarkConfigError("The game's executable path is required to check for the Windows watermark component.");
        }
        const slash = exe.lastIndexOf("/");
        const exeDir = slash >= 0 ? exe.slice(0, slash + 1) : "";
        return { bucket, keys: [prefix + exeDir + WINDOWS_FILE] };
    }

    if (runtimeType === "UBUNTU") {
        throw new WatermarkConfigError(
            "Forensic watermarking isn't supported on the Ubuntu 22.04 runtime. It's available for Proton and Windows games."
        );
    }
    throw new WatermarkConfigError(
        `Forensic watermarking couldn't determine the game's runtime${runtimeType ? ` ("${runtimeType}")` : ""}. It's available for Proton and Windows games.`
    );
}

/**
 * Verify the watermark host components are present in the package.
 *
 * headObject(bucket, key) must resolve if the object exists and reject otherwise;
 * it is injected so this logic can be tested without S3.
 * existingApplication controls the advice: a GameLift Streams application can't be
 * changed after it is created, so an existing game must be added again.
 */
export async function assertWatermarkPackage({ sourceUri, executablePath, runtimeType, existingApplication }, headObject) {
    const { bucket, keys } = requiredWatermarkKeys({ sourceUri, executablePath, runtimeType });

    const missing = [];
    for (const key of keys) {
        try {
            await headObject(bucket, key);
        } catch (err) {
            const status = err?.$metadata?.httpStatusCode;
            if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) {
                missing.push(`s3://${bucket}/${key}`);
            } else if (err?.name === "AccessDenied" || err?.name === "Forbidden" || status === 403) {
                throw new WatermarkConfigError(
                    `Couldn't check the game package for the watermark components: access to s3://${bucket}/ was denied.`
                );
            } else {
                throw err;
            }
        }
    }

    if (missing.length === 0) return { bucket, keys };

    if (existingApplication) {
        throw new WatermarkConfigError(
            `This game was added without the forensic watermark components (missing: ${missing.join(", ")}), and GameLift Streams applications can't be changed after they're created. To watermark it, create the playtest session with Add New Game, choose the same game folder and turn on Forensic watermarking; the components are added for you.`
        );
    }
    throw new WatermarkConfigError(
        `The forensic watermark components are missing from the game package: ${missing.join(", ")}. See "Enabling Forensic Watermarking" in the README.`
    );
}

/**
 * Unreal Engine Windows builds ship a small launcher .exe at the package root that starts
 * the real game from <Project>/Binaries/Win64/<Name>-Win64-Shipping.exe. Windows only
 * loads the watermark's dxgi.dll from the folder of the process that renders, so a
 * session pointed at the launcher would stream with NO mark. Refuse that, naming the
 * executable to use instead.
 *
 * listKeys(bucket, prefix) resolves to the package's object keys (injected for testing).
 */
export async function assertNotUnrealLauncher({ sourceUri, executablePath, runtimeType }, listKeys) {
    if (runtimeType !== "WINDOWS") return;
    const exe = String(executablePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (/-Win64-Shipping\.exe$/i.test(exe)) return;
    const { bucket, prefix } = parseS3Uri(sourceUri);
    const shipping = (await listKeys(bucket, prefix))
        .map((k) => k.slice(prefix.length))
        .filter((k) => /(^|\/)Binaries\/Win64\/[^/]+-Win64-Shipping\.exe$/i.test(k) && !/^Engine\//i.test(k));
    if (shipping.length === 0) return;
    throw new WatermarkConfigError(
        `"${exe}" looks like an Unreal Engine launcher that starts the game from ${shipping.join(" or ")}. The watermark is only added to the program that actually renders the game, so choose ${shipping.length === 1 ? "that file" : "the right one of those files"} as the game's executable instead.`
    );
}

/**
 * Add the watermark host components to a NEW game's S3 folder (Add New Game), copying
 * them from this deployment's payload bucket. Must run before CreateApplication, because
 * an application's files can't change after it's created.
 *
 * s3 = { head(bucket, key) -> { Metadata } (rejects with NotFound if absent),
 *        copy(srcBucket, srcKey, dstBucket, dstKey) } is injected for testing.
 * availableRuntimes lists the runtimes this deployment built components for.
 * A file of the same name that the solution didn't write (for example a game's own
 * dxgi.dll) is never overwritten.
 */
export async function includeWatermarkComponents({ sourceUri, executablePath, runtimeType, availableRuntimes, payloadBucket }, s3) {
    const { bucket, keys } = requiredWatermarkKeys({ sourceUri, executablePath, runtimeType });
    if (!payloadBucket || !(availableRuntimes ?? []).includes(runtimeType)) {
        const name = runtimeType === "PROTON" ? "Proton" : "Windows";
        throw new WatermarkConfigError(
            `This deployment doesn't include the forensic watermark components for ${name} games. Start Docker (or Finch), run "npm run deploy-all" again to build them, then create the playtest session.`
        );
    }

    const copied = [];
    for (const key of keys) {
        const suffix = Object.keys(PAYLOAD_KEYS[runtimeType]).find((s) => key.endsWith(s));
        let existing = null;
        try {
            existing = await s3.head(bucket, key);
        } catch (err) {
            const status = err?.$metadata?.httpStatusCode;
            if (!(err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404)) {
                if (err?.name === "AccessDenied" || err?.name === "Forbidden" || status === 403) {
                    throw new WatermarkConfigError(`Couldn't add the watermark components to the game folder: access to s3://${bucket}/ was denied.`);
                }
                throw err;
            }
        }
        if (existing && existing.Metadata?.[COMPONENT_METADATA_KEY] !== COMPONENT_METADATA_VALUE) {
            throw new WatermarkConfigError(
                `The game folder already contains s3://${bucket}/${key}, which wasn't added by this solution, so it won't be overwritten. A game that ships its own ${suffix.split("/").pop()} can't be watermarked.`
            );
        }
        try {
            await s3.copy(payloadBucket, PAYLOAD_KEYS[runtimeType][suffix], bucket, key);
        } catch (err) {
            const status = err?.$metadata?.httpStatusCode;
            if (err?.name === "AccessDenied" || status === 403) {
                throw new WatermarkConfigError(`Couldn't add the watermark components to the game folder: writing to s3://${bucket}/ was denied. Check the bucket's policy and encryption settings.`);
            }
            throw err;
        }
        copied.push(`s3://${bucket}/${key}`);
    }
    return copied;
}
