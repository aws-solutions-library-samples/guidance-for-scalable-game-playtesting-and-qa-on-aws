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

/** Split "s3://bucket/some/prefix" into { bucket, prefix } with prefix ending in "/" (or ""). */
export function parseS3Uri(uri) {
    const match = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(String(uri ?? "").trim());
    if (!match || !match[1]) {
        throw new WatermarkConfigError(`The game location "${uri}" is not an s3:// path.`);
    }
    let prefix = match[2];
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    return { bucket: match[1], prefix };
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

    const fix = existingApplication
        ? "Stage them into the game's S3 folder, then choose Add New Game to add the game again. GameLift Streams applications can't be changed after they're created, so this existing game can't be watermarked."
        : "Stage them into the game's S3 folder, then create the playtest session again.";
    throw new WatermarkConfigError(
        `Forensic watermarking needs the watermark host components in the game package, but these files are missing: ${missing.join(", ")}. ${fix} See "Enabling Forensic Watermarking" in the README.`
    );
}
