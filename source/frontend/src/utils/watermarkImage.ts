/*
 * Prepare an uploaded screenshot for forensic watermark analysis.
 *
 * Adapted from the GameLift Streams forensic watermarking console (capture.js,
 * prepareImageFile / findContentBox / lumaBase64). The file is decoded and measured in
 * the browser; uniform dark letterbox borders are trimmed, very wide images are
 * resampled, and the BT.601 brightness (luma) plane is computed, which is what the
 * verifier analyzes. Scale is deliberately NOT guessed here: the verifier searches for it.
 */

export const MAX_ANALYSIS_WIDTH = 2200;   // keeps the brightness plane within the verifier's limit
export const MIN_DIMENSION = 256;         // one watermark tile
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface PreparedImage {
    width: number;
    height: number;
    luma: Uint8Array;      // width * height bytes, row-major
    note: string;          // what was done to the image, for the report
    preview: string;       // data URL of exactly what is analyzed
}

function drawTo(canvas: HTMLCanvasElement, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser can't process images (no 2D canvas).");
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx);
    return ctx;
}

/** BT.601 luma, matching the verifier's reference conversion. */
export function lumaFromRgba(px: Uint8ClampedArray, w: number, h: number): Uint8Array {
    const y = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < y.length; i += 4, j++) {
        y[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] + 0.5) | 0;
    }
    return y;
}

/**
 * Detect uniform dark borders (letterbox or pillarbox) and return the content rectangle,
 * or null if there is nothing worth trimming. A border must be almost entirely very dark
 * and between 1% and 25% of the dimension, so dark game content isn't cropped.
 */
export function findContentBox(px: Uint8ClampedArray, w: number, h: number) {
    const DARK = 18, COVERAGE = 0.995;
    const lumaAt = (x: number, y: number) => {
        const i = (y * w + x) * 4;
        return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };
    const rowDark = (y: number) => {
        let dark = 0;
        for (let x = 0; x < w; x += 2) if (lumaAt(x, y) <= DARK) dark++;
        return dark / Math.ceil(w / 2) >= COVERAGE;
    };
    const colDark = (x: number) => {
        let dark = 0;
        for (let y = 0; y < h; y += 2) if (lumaAt(x, y) <= DARK) dark++;
        return dark / Math.ceil(h / 2) >= COVERAGE;
    };
    let top = 0, bottom = h - 1, left = 0, right = w - 1;
    while (top < bottom && rowDark(top)) top++;
    while (bottom > top && rowDark(bottom)) bottom--;
    while (left < right && colDark(left)) left++;
    while (right > left && colDark(right)) right--;

    const trimmedY = top + (h - 1 - bottom), trimmedX = left + (w - 1 - right);
    const plausible = (trimmed: number, total: number) => trimmed > total * 0.01 && trimmed < total * 0.25;
    if (!plausible(trimmedY, h) && !plausible(trimmedX, w)) return null;
    if (!plausible(trimmedY, h)) { top = 0; bottom = h - 1; }
    if (!plausible(trimmedX, w)) { left = 0; right = w - 1; }
    return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Check the file before decoding it. Returns an error message, or null if acceptable. */
export function checkFile(file: File): string | null {
    if (!ACCEPTED_TYPES.includes(file.type)) return "Choose a PNG, JPEG or WebP image.";
    if (file.size > MAX_FILE_BYTES) return "The image is larger than 25 MB.";
    if (file.size === 0) return "The file is empty.";
    return null;
}

export async function prepareImageFile(file: File, canvas: HTMLCanvasElement): Promise<PreparedImage> {
    let bmp: ImageBitmap;
    try {
        bmp = await createImageBitmap(file);
    } catch {
        throw new Error("The image couldn't be read. It may be corrupt or in an unsupported format.");
    }
    let w = bmp.width, h = bmp.height;
    let ctx = drawTo(canvas, w, h, (c) => c.drawImage(bmp, 0, 0));
    const steps = [`${w}x${h}`];

    const box = findContentBox(ctx.getImageData(0, 0, w, h).data, w, h);
    if (box) {
        const frame = ctx.getImageData(box.x, box.y, box.w, box.h);
        ctx = drawTo(canvas, box.w, box.h, (c) => c.putImageData(frame, 0, 0));
        w = box.w; h = box.h;
        steps.push(`trimmed letterbox to ${w}x${h}`);
    }

    if (w > MAX_ANALYSIS_WIDTH) {
        const k = MAX_ANALYSIS_WIDTH / w;
        const tmp = await createImageBitmap(canvas);
        const nw = Math.round(w * k), nh = Math.round(h * k);
        ctx = drawTo(canvas, nw, nh, (c) => c.drawImage(tmp, 0, 0, nw, nh));
        w = nw; h = nh;
        steps.push(`resampled to ${nw}x${nh}`);
    }

    if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
        throw new Error(`The image is too small to hold a watermark (${w}x${h}). It must be at least ${MIN_DIMENSION} x ${MIN_DIMENSION} pixels.`);
    }

    return {
        width: w,
        height: h,
        luma: lumaFromRgba(ctx.getImageData(0, 0, w, h).data, w, h),
        note: steps.join(", "),
        preview: canvas.toDataURL("image/jpeg", 0.7),
    };
}
