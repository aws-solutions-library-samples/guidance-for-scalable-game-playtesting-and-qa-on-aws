# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Adapted from the Amazon GameLift Streams forensic watermarking verifier
# (lambda/VerifyWatermark/handler.py). Changes for the Playtesting solution are
# limited to how candidates are read and how the image is supplied; they are
# marked "Playtesting:". The pattern, fold, correlation and scale search are
# unchanged and MUST stay identical to the host-side shaders.
"""Forensic watermark verification Lambda (informed detection).

Input (invoked directly, not public):
  {"width": int, "height": int,
   "luma_b64": str,                         # raw 8-bit luma, row-major w*h, OR
   "s3_bucket": str, "s3_key": str,         # Playtesting: the same bytes in S3
   "playtestingID": str (optional),         # Playtesting: only this session's seeds
   "threshold": float (optional), "limit": int (optional)}

Reads candidate per-session seeds from DynamoDB, folds the image's watermark
tiles, and FFT-correlates (spectrally whitened, over the 8 flip/transpose
orientations) against every candidate pattern. Returns PSR-ranked candidates and
the identified session/user if the top score clears the threshold.

If nothing clears the threshold and the caller asks for it, a scale search
handles captures where the stream is a sub-rectangle at an unknown scale. It is
fanned out across concurrent invocations of a separate worker function
(search_worker below, deployed from this same file) when WM_SEARCH_FN is set, and
runs in-process otherwise.

Must stay numerically consistent with forensic/wm_forensic.py and the layer's
GLSL embed shader (same integer-hash pattern).
"""
import base64
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import boto3

TILE = 256
DEFAULT_THRESHOLD = 8.0
# Playtesting: no default table name; it always comes from the stack.
TABLE = os.environ.get("WM_TABLE")
# Playtesting: GSI on the seed table (playtestingID, createdAt).
SESSION_INDEX = os.environ.get("WM_SESSION_INDEX", "playtestingID-createdAt-index")
# Playtesting: largest luma plane accepted from S3 (bounds memory).
MAX_LUMA_BYTES = 16 * 1024 * 1024
# Upper bound on records pulled from the table, so a large store cannot make a
# single verification unbounded. DEFAULT_LIMIT bounds the correlation work: each
# candidate costs 8 FFT correlations on the fast path, and one per scale step on
# the fallback scale search, which is already time-boxed by DEFAULT_BUDGET_S.
MAX_SCAN_ITEMS = 2000
DEFAULT_LIMIT = 250

# Playtesting: created lazily so the scale-search worker, which has no table or
# bucket access, never builds clients it doesn't need.
_ddb = None
_s3 = None


def _ddb_resource():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def seed_words(seed_hex):
    b = bytes.fromhex(seed_hex)
    return int.from_bytes(b[0:4], "big"), int.from_bytes(b[4:8], "big")


def pattern_for_seed(seed_hex):
    lo, hi = (np.uint32(w) for w in seed_words(seed_hex))
    u = np.uint32
    xs = np.arange(TILE, dtype=np.uint32)
    X = np.tile(xs, (TILE, 1))
    Y = X.T.copy()
    h = (lo ^ (X * u(0x9E3779B1)) ^ (Y * u(0x85EBCA77)) ^ (hi * u(0x27D4EB2F))).astype(np.uint32)
    h ^= h >> u(15); h = (h * u(0x2C1B3C6D)).astype(np.uint32)
    h ^= h >> u(12); h = (h * u(0x297A2D39)).astype(np.uint32)
    h ^= h >> u(15)
    p = np.where((h & u(1)) == u(0), 1.0, -1.0)
    p -= p.mean(); p /= (p.std() + 1e-9)
    return p


def fold(Y):
    """Fold every whole TILE x TILE block into one zero-mean accumulator."""
    h, w = Y.shape
    nty, ntx = h // TILE, w // TILE
    if nty < 1 or ntx < 1:
        raise ValueError(f"image {w}x{h} smaller than one {TILE}px tile")
    blk = Y[:nty * TILE, :ntx * TILE].reshape(nty, TILE, ntx, TILE)
    blk = blk - blk.mean(axis=(1, 3), keepdims=True)   # per-tile DC removal
    acc = blk.sum(axis=(0, 2))
    acc -= acc.mean(); acc /= (acc.std() + 1e-9)
    return acc, nty * ntx


# Correlation is almost all of the cost: every candidate, in 8 orientations on
# the fast path and at every step of the scale search. The candidate spectra do
# not change during a request, so they are computed once, and a frame is scored
# against all candidates with one forward FFT and a batched inverse FFT. Batches
# are chunked to bound memory: a chunk of 64 is about 35 MB of spectra and 35 MB
# of correlation output.
#
# Single precision: the correlation is memory bound, float32 is about 1.5x
# faster, and the PSRs match float64 to well inside the 0.01 they are reported to.
CHUNK = 64


def pattern_spectra(patterns):
    """Conjugate spectra of the candidate patterns, shape (K, TILE, TILE//2 + 1)."""
    return np.conj(np.fft.rfft2(np.stack(patterns).astype(np.float32), axes=(1, 2)))


def psr_all(acc, spectra):
    """Peak-to-sidelobe ratio of acc against every candidate, shape (K,).

    Spectrally whitened circular correlation: peak minus mean, over the
    standard deviation of the correlation surface.
    """
    A = np.fft.rfft2(acc.astype(np.float32))
    # The tiny constant keeps a blank capture (an all-black frame has no
    # spectrum at all) at a PSR of 0 instead of 0/0 = NaN, which is not valid
    # JSON and failed the whole request. It is negligible for any real image.
    A = A / (np.abs(A) + 1e-3 * np.abs(A).mean() + 1e-12)
    out = np.empty(len(spectra))
    for i in range(0, len(spectra), CHUNK):
        c = np.fft.irfft2(A[None] * spectra[i:i + CHUNK], s=acc.shape, axes=(1, 2))
        c = c.reshape(len(c), -1)
        out[i:i + CHUNK] = (c.max(axis=1) - c.mean(axis=1)) / (c.std(axis=1) + 1e-9)
    return out


def orientations(acc):
    return [acc, np.fliplr(acc), np.flipud(acc), np.flipud(np.fliplr(acc)),
            acc.T, np.fliplr(acc).T, np.flipud(acc).T, np.flipud(np.fliplr(acc)).T]


def resize_bilinear(Y, factor):
    h, w = Y.shape
    nh, nw = max(1, int(round(h * factor))), max(1, int(round(w * factor)))
    ys = np.linspace(0, h - 1, nh)
    xs = np.linspace(0, w - 1, nw)
    y0 = np.floor(ys).astype(np.int64); y1 = np.minimum(y0 + 1, h - 1)
    x0 = np.floor(xs).astype(np.int64); x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None]; wx = (xs - x0)[None, :]
    top = Y[y0][:, x0] * (1 - wx) + Y[y0][:, x1] * wx
    bot = Y[y1][:, x0] * (1 - wx) + Y[y1][:, x1] * wx
    return top * (1 - wy) + bot * wy


# Scale search, used only when the fast path finds nothing.
#
# Translation is already handled by the circular correlation, so for an axis
# aligned capture scale is the only unknown. It arises whenever the stream is a
# sub-rectangle of the capture: a screenshot of a browser window, or a photo of
# a monitor.
#
# The grid has to be FINE. The mark folds over 256 pixel tiles, so a scale error
# of e drifts the tile phase by e * 256 pixels; measured on real captures, 0.5%
# off the true scale already drops the score from over 100 to noise. A 1% grid
# steps straight over the peak.
#
# A fine grid over the whole image would be far too slow, so the sweep runs on a
# small central patch. That is cheap enough to afford the fine grid, and the
# patch alone scores well above the threshold at the true scale (96 to 166 on a
# browser screenshot, 29 to 33 on a photograph), so candidates can be ranked
# from it without re-folding the full image.
SCALE_STEP = 1.004          # 0.4% grid, inside the measured tolerance
SCALE_SPREAD = 0.35         # out to about +/-35% of the supplied scale
PATCH = 1024                # central patch side, in pixels
DEFAULT_BUDGET_S = 18.0     # API Gateway caps a synchronous request at 29s


def centre_patch(Y, size=PATCH):
    h, w = Y.shape
    size = min(size, h, w)
    cy, cx, half = h // 2, w // 2, size // 2
    return Y[cy - half:cy + half, cx - half:cx + half]


def _fold_at(Y, f):
    if min(Y.shape) * f < TILE:
        return None
    try:
        acc, _ = fold(resize_bilinear(Y, f) if abs(f - 1.0) > 1e-9 else Y)
        return acc
    except ValueError:
        return None


def _scale_ladder():
    """Scale factors ordered by distance from 1.0, so the likeliest land first."""
    out, step = [1.0], SCALE_STEP
    while step - 1.0 <= SCALE_SPREAD:
        out.append(step)
        out.append(1.0 / step)
        step *= SCALE_STEP
    return out


def scan_scales(patch, spectra, scales, deadline):
    """Score each scale in order until the deadline passes.

    Returns (best_factor, best_score, steps_done).
    """
    best_f, best_score, steps = None, -1e9, 0
    for f in scales:
        if time.time() > deadline:
            break
        steps += 1
        acc = _fold_at(patch, f)
        if acc is None:
            continue
        score = float(psr_all(acc, spectra).max())
        if score > best_score:
            best_f, best_score = f, score
    return best_f, best_score, steps


def search_scale(patch, spectra, budget_s, started):
    """In-process scale search, nearest-first until the budget runs out.

    Returns (factor, accumulator, scales_scanned, workers_failed). The
    accumulator is the patch fold at the winning scale, which is what the
    candidates are ranked on.
    """
    f, _, steps = scan_scales(patch, spectra, _scale_ladder(), started + budget_s)
    return f, (_fold_at(patch, f) if f is not None else None), steps, 0


# Fan-out. The scale search is split across concurrent invocations of the worker
# function. Worker i scores ladder steps i, i+N, i+2N, ... so every worker starts
# with the likeliest scales, and wall time stays roughly flat as the ladder or
# the candidate set grows: add workers rather than time. Workers receive only the
# central patch and the seeds, never the full image or access to the table.
SEARCH_FN = os.environ.get("WM_SEARCH_FN")
SEARCH_WORKERS = int(os.environ.get("WM_SEARCH_WORKERS", "16"))
RETURN_MARGIN_S = 2.0       # left for workers to reply and for the final ranking

_lambda = None


def _lambda_client():
    global _lambda
    if _lambda is None:
        from botocore.config import Config
        _lambda = boto3.client("lambda", config=Config(
            max_pool_connections=SEARCH_WORKERS + 4,
            read_timeout=60, retries={"max_attempts": 0}))
    return _lambda


def _invoke_worker(payload):
    """Invoke one worker. A failed worker loses its slice but not the request."""
    try:
        out = _lambda_client().invoke(FunctionName=SEARCH_FN,
                                      Payload=json.dumps(payload).encode())
        body = json.loads(out["Payload"].read() or b"{}")
        if out.get("FunctionError") or "steps" not in body:
            print("scale search worker failed", out.get("FunctionError"), str(body)[:300])
            return None
        return body
    except Exception as e:
        print("scale search worker invoke failed", repr(e))
        return None


def search_scale_fanout(patch_u8, seeds, budget_s, started):
    """Scale search fanned out across worker invocations.

    Returns (factor, accumulator, scales_scanned, workers_failed).
    """
    ladder = _scale_ladder()
    n = max(1, min(SEARCH_WORKERS, len(ladder)))
    worker_budget = max(1.0, budget_s - (time.time() - started) - RETURN_MARGIN_S)
    base = {"height": patch_u8.shape[0], "width": patch_u8.shape[1],
            "patch_b64": base64.b64encode(np.ascontiguousarray(patch_u8).tobytes()).decode(),
            "seeds": seeds, "budget_s": worker_budget}
    with ThreadPoolExecutor(max_workers=n) as pool:
        replies = list(pool.map(_invoke_worker,
                                [{**base, "scales": ladder[i::n]} for i in range(n)]))
    scanned = sum(r["steps"] for r in replies if r)
    failed = sum(1 for r in replies if r is None)
    found = [r for r in replies if r and r.get("scale") is not None]
    if not found:
        return None, None, scanned, failed
    f = float(max(found, key=lambda r: r["score"])["scale"])
    return f, _fold_at(patch_u8.astype(np.float64), f), scanned, failed


def search_worker(event, context):
    """Entry point of the scale search worker function.

    Scores one slice of the scale ladder against every candidate seed and
    returns the best scale found within the budget.
    """
    started = time.time()
    h, w = int(event["height"]), int(event["width"])
    raw = base64.b64decode(event["patch_b64"])
    patch = np.frombuffer(raw[: h * w], np.uint8).astype(np.float64).reshape(h, w)
    spectra = pattern_spectra([pattern_for_seed(s) for s in event["seeds"]])
    f, score, steps = scan_scales(patch, spectra, [float(x) for x in event["scales"]],
                                  started + float(event["budget_s"]))
    return {"scale": f, "score": score, "steps": steps}


def candidates(limit, playtesting_id=None):
    """Playtesting: seeds for one playtest session (GSI query, newest first) when
    playtesting_id is given, otherwise every session (upstream behaviour)."""
    if not playtesting_id:
        return candidates_all(limit)
    from boto3.dynamodb.conditions import Key
    table = _ddb_resource().Table(TABLE)
    items, kwargs = [], {"IndexName": SESSION_INDEX,
                         "KeyConditionExpression": Key("playtestingID").eq(playtesting_id),
                         "ScanIndexForward": False}
    while len(items) < MAX_SCAN_ITEMS:
        out = table.query(**kwargs)
        items.extend(out.get("Items", []))
        key = out.get("LastEvaluatedKey")
        if not key:
            break
        kwargs["ExclusiveStartKey"] = key
    recs = [i for i in items if i.get("seed")]
    recs.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    return recs[:limit]


def candidates_all(limit):
    """Seeds to correlate against, most recently issued first.

    A single scan page is not enough. DynamoDB returns items in hash order, not
    insertion order, and caps a page at the requested Limit, so as soon as the
    table grows past that limit an arbitrary subset is returned and recent
    sessions silently drop out of the candidate set. A frame from a missing
    session then scores at noise level and is reported as unidentified, which
    looks exactly like a watermark that failed to embed.

    So page through the table and rank newest first: a leak is far more likely
    to come from a recent session, and `limit` then bounds the correlation work
    rather than arbitrarily deciding which sessions are identifiable at all.
    """
    table = _ddb_resource().Table(TABLE)
    items, kwargs = [], {}
    while len(items) < MAX_SCAN_ITEMS:
        out = table.scan(**kwargs)
        items.extend(out.get("Items", []))
        key = out.get("LastEvaluatedKey")
        if not key:
            break
        kwargs["ExclusiveStartKey"] = key
    recs = [i for i in items if i.get("seed")]
    # Playtesting: our seed records use createdAt.
    recs.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    return recs[:limit]


def rank(acc, recs, spectra):
    """Rank candidates by their best PSR over the 8 orientations.

    spectra[i] must belong to recs[i].
    """
    best = np.max([psr_all(a, spectra) for a in orientations(acc)], axis=0)
    # Playtesting: report our seed record's fields. The seed itself is never returned.
    results = [{
        "psr": round(float(score), 2),
        "playtesterName": r.get("playtesterName", "?"),
        "playtestingID": r.get("playtestingID", "?"),
        "sessionName": r.get("sessionName", ""),
        "game": r.get("game", ""),
        "studio": r.get("studio", ""),
        "streamSessionArn": r.get("streamSessionArn", ""),
        "location": r.get("location", ""),
        "createdAt": r.get("createdAt", ""),
        "isAdmin": bool(r.get("isAdmin", False)),
    } for r, score in zip(recs, best)]
    results.sort(key=lambda x: -x["psr"])
    return results


def handler(event, context):
    started = time.time()
    if not TABLE:
        return {"error": "WM_TABLE is not configured"}
    w = int(event["width"]); h = int(event["height"])
    if w <= 0 or h <= 0 or w * h > MAX_LUMA_BYTES:
        return {"error": f"image dimensions {w}x{h} are out of range"}
    # Playtesting: the luma plane is normally in S3, because it is far larger
    # than a synchronous Lambda payload allows.
    if event.get("s3_bucket") and event.get("s3_key"):
        obj = _s3_client().get_object(Bucket=event["s3_bucket"], Key=event["s3_key"])
        if int(obj.get("ContentLength", 0)) > MAX_LUMA_BYTES:
            return {"error": "luma object is too large"}
        raw = obj["Body"].read()
    else:
        raw = base64.b64decode(event["luma_b64"])
    if len(raw) < w * h:
        return {"error": f"luma too short: {len(raw)} < {w*h}"}
    U8 = np.frombuffer(raw[: w * h], np.uint8).reshape(h, w)
    Y = U8.astype(np.float64)
    threshold = float(event.get("threshold", DEFAULT_THRESHOLD))

    recs = candidates(int(event.get("limit", DEFAULT_LIMIT)), event.get("playtestingID"))
    if not recs:
        # Playtesting: say which case it is, so the analyzer can explain it.
        return {"error": "no_candidates",
                "message": ("No watermarked streams have been recorded for this playtest session."
                            if event.get("playtestingID")
                            else "No watermarked streams have been recorded yet.")}
    spectra = pattern_spectra([pattern_for_seed(r["seed"]) for r in recs])

    # Fast path: the capture is already on the embed grid. This is the normal
    # case for a live capture or a correctly cropped frame, and it is the only
    # work done unless it comes up empty.
    scale_used, scanned, searched, failed = 1.0, 0, False, 0
    results = []
    try:
        acc, tiles = fold(Y)
        results = rank(acc, recs, spectra)
    except ValueError as e:
        if not event.get("search_scale"):
            return {"error": str(e)}
        acc, tiles = None, 0

    hit = bool(results) and results[0]["psr"] >= threshold

    # Only if that found nothing do we pay for the scale search, which handles
    # captures where the stream is a sub-rectangle at an unknown scale.
    if not hit and event.get("search_scale"):
        searched = True
        budget = float(event.get("budget_s", DEFAULT_BUDGET_S))
        patch = centre_patch(U8)
        if SEARCH_FN:
            factor, acc2, scanned, failed = search_scale_fanout(
                patch, [r["seed"] for r in recs], budget, started)
        else:
            factor, acc2, scanned, failed = search_scale(
                patch.astype(np.float64), spectra, budget, started)
        if acc2 is not None:
            alt = rank(acc2, recs, spectra)
            if not results or alt[0]["psr"] > results[0]["psr"]:
                results, scale_used = alt, factor
                tiles = (int(round(h * factor)) // TILE) * (int(round(w * factor)) // TILE)

    if not results:
        return {"error": "image too small to hold a watermark tile"}

    top = results[0]
    second = results[1]["psr"] if len(results) > 1 else 0.0
    return {
        "image": {"width": w, "height": h, "tiles_folded": tiles,
                  "scale_used": round(scale_used, 3)},
        "threshold": threshold,
        "candidates_checked": len(results),
        "results": results[:10],
        "identified": top if top["psr"] >= threshold else None,
        "separation": round(top["psr"] - second, 2),
        "scale_searched": searched,
        "scales_scanned": scanned,
        "scales_total": len(_scale_ladder()) if searched else 0,
        "search_workers_failed": failed,
        "search_seconds": round(time.time() - started, 1),
    }
