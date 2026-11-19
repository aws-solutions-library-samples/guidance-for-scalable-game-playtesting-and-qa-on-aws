#!/usr/bin/env node
/*
 * Copy the built forensic watermark host components into a game's S3 folder, so a
 * GameLift Streams application created from that folder can be watermarked.
 *
 *   npm run stage-watermark -- --game s3://my-bucket/my-game/ --runtime proton
 *   npm run stage-watermark -- --game s3://my-bucket/my-game/ --runtime windows --exe Binaries/Win64/MyGame.exe
 *
 * Proton: adds wmlayer/ and xdg/ at the root of the game folder.
 * Windows: adds dxgi.dll next to the executable (--exe is relative to the game folder,
 *          or a full s3:// path inside it). Windows only looks there for it.
 *
 * Only the watermark files are written; nothing else in the folder is touched.
 * Uses your normal AWS credentials. Run `npm run build-watermark` first.
 */
const fs = require("fs");
const path = require("path");
const { S3Client, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const BUILD = path.resolve(__dirname, "../watermark/build");
// Local build output for each required key, matched on the end of the key.
const LOCAL_FILES = {
    PROTON: {
        "wmlayer/libVkLayer_wmpoc.so": "proton/wmlayer/libVkLayer_wmpoc.so",
        "xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json": "proton/xdg/vulkan/implicit_layer.d/VkLayer_wmpoc.json",
    },
    WINDOWS: { "dxgi.dll": "windows/dxgi.dll" },
};

function fail(msg) {
    console.error(`[stage-watermark] ${msg}`);
    process.exit(1);
}

function arg(name) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}

const isNotFound = (e) => e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;

async function main() {
    const game = arg("game");
    const runtime = String(arg("runtime") || "").toUpperCase();
    let exe = arg("exe");
    const force = process.argv.includes("--force");
    if (!game || !["PROTON", "WINDOWS"].includes(runtime)) {
        fail("Usage: npm run stage-watermark -- --game s3://<bucket>/<game-folder>/ --runtime <proton|windows> [--exe <path/to/game.exe>] [--force]");
    }

    // Single source of truth for where the files go: the same function the backend
    // uses to check a game package before allowing watermarking.
    const { requiredWatermarkKeys, parseS3Uri, COMPONENT_METADATA_KEY, COMPONENT_METADATA_VALUE } = await import("../lambdas/PlayTestSessions/watermark.js");
    const { bucket, prefix } = parseS3Uri(game);
    if (runtime === "WINDOWS") {
        if (!exe) fail("--exe is required for Windows games: the path to the game's .exe inside the game folder.");
        if (/^s3:\/\//i.test(exe)) {
            const e = parseS3Uri(exe.replace(/\/?$/, "/"));
            const full = e.prefix.replace(/\/$/, "");
            if (e.bucket !== bucket || !full.startsWith(prefix)) fail("--exe must be inside the game folder.");
            exe = full.slice(prefix.length);
        }
    }
    const { keys } = requiredWatermarkKeys({ sourceUri: game, executablePath: exe, runtimeType: runtime });

    const s3 = new S3Client({ followRegionRedirects: true, region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1" });

    if (runtime === "WINDOWS") {
        const exeKey = prefix + exe.replace(/\\/g, "/").replace(/^\/+/, "");
        try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: exeKey }));
        } catch (e) {
            if (isNotFound(e)) fail(`The executable s3://${bucket}/${exeKey} doesn't exist. Check --exe; it's relative to the game folder.`);
            throw e;
        }
    }

    const plan = keys.map((key) => {
        const suffix = Object.keys(LOCAL_FILES[runtime]).find((s) => key.endsWith(s));
        const local = path.join(BUILD, LOCAL_FILES[runtime][suffix]);
        if (!fs.existsSync(local)) fail(`${local} not found. Run "npm run build-watermark -- --runtime ${runtime.toLowerCase()}" first.`);
        return { key, local };
    });

    for (const { key } of plan) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            if (!force) fail(`s3://${bucket}/${key} already exists. Re-run with --force to replace it.`);
        } catch (e) {
            if (!isNotFound(e)) throw e;
        }
    }

    for (const { key, local } of plan) {
        // Same marker the backend stamps, so these count as the solution's own files.
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(local), Metadata: { [COMPONENT_METADATA_KEY]: COMPONENT_METADATA_VALUE } }));
        console.log(`[stage-watermark] uploaded s3://${bucket}/${key}`);
    }
    console.log("\n[stage-watermark] done. Now create a playtest session for this game with Add New Game and turn on Forensic watermarking.");
    console.log("GameLift Streams applications can't be changed after they're created, so games added before staging must be added again.");
}

main().catch((e) => fail(e?.message ?? String(e)));
