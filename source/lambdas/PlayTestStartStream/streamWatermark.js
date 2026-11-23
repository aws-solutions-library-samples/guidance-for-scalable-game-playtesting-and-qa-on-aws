/*
 * Helpers for starting a playtester's stream: identity, registration lookup key, and the
 * forensic watermark session variables.
 *
 * The watermark logic is adapted from the GameLift Streams forensic watermarking console
 * API (WatermarkApi.js). The seed is minted here, bound to the signed-in playtester in
 * DynamoDB, and handed to the stream host in AdditionalEnvironmentVariables. It is never
 * returned to the browser and never logged.
 */
const crypto = require("crypto");

/**
 * Opaque GameLift Streams UserId for a signed-in user. GetStreamSession echoes UserId
 * back, so we send a digest rather than the raw username. It must match the copy in
 * PlayTestGetStream, which uses it to stop one user reconnecting to another's session.
 * UserId must match [-_a-zA-Z0-9/=+]*.
 */
function opaqueUserId(username) {
    return "u" + crypto.createHash("sha256").update(String(username)).digest("hex").slice(0, 16);
}

/**
 * The playtesters table key for a registration. Must match generateHash() in
 * PlayTestRegisterPlayer/PlayerRegistration.js, which keys a registration on
 * pbkdf2(Discord username, salt = playtest session id).
 */
function registrationHash(username, playtestingID) {
    return crypto.pbkdf2Sync(String(username), String(playtestingID), 1000, 64, "sha512").toString("hex");
}

/** A random 128-bit watermark seed, as 32 hex characters (the format the host expects). */
function newWatermarkSeed() {
    return crypto.randomBytes(16).toString("hex");
}

// Where GameLift Streams mounts the application package on a Proton host. This is a
// platform path, not an account value: the Vulkan loader finds the watermark layer's
// manifest through XDG_CONFIG_DIRS. It must be XDG_CONFIG_DIRS, not XDG_CONFIG_HOME,
// which breaks the host's audio client and silently kills the audio stream.
const PROTON_PACKAGE_DIR = "/home/unpriv/games";

const WATERMARK_RUNTIMES = ["PROTON", "WINDOWS"];

/**
 * The session variables that arm the watermark, which differ by runtime: Proton loads a
 * Vulkan layer found through XDG_CONFIG_DIRS; Windows loads a proxy dxgi.dll beside the
 * executable, which needs no configuration. Returns null for an unsupported runtime.
 */
function watermarkEnvironment(runtimeType, alpha, seed) {
    if (!WATERMARK_RUNTIMES.includes(runtimeType)) return null;
    if (!/^[0-9a-f]{32}$/.test(String(seed))) throw new Error("invalid watermark seed");
    const env = {
        ENABLE_WMPOC: "1",
        WMPOC_ALPHA: String(alpha),
        WMPOC_SEED: seed,
    };
    if (runtimeType === "PROTON") {
        env.XDG_CONFIG_DIRS = `${PROTON_PACKAGE_DIR}/xdg:/etc/xdg`;
    }
    return env;
}

/**
 * Why a playtester can't stream this session right now, or null if they can. Same rules
 * as PlayTesterValidation/PlayerValidate.js (enabled, and today's UTC date within
 * startDate..endDate inclusive), enforced server-side at stream start.
 */
function sessionUnavailableReason(session, now) {
    if (!session?.enabled) return "This playtest session is disabled.";
    const today = now.toISOString().split("T")[0];
    if (session.startDate && today < session.startDate) return "This playtest session hasn't started yet.";
    if (session.endDate && today > session.endDate) return "This playtest session has ended.";
    return null;
}

/** Watermark strength stored on the session, falling back to the default of 8. */
function sessionAlpha(session) {
    const n = Number(session?.watermarkAlpha);
    return Number.isFinite(n) && n >= 1 && n <= 64 ? n : 8;
}

module.exports = {
    opaqueUserId,
    registrationHash,
    newWatermarkSeed,
    watermarkEnvironment,
    sessionAlpha,
    sessionUnavailableReason,
    PROTON_PACKAGE_DIR,
};
