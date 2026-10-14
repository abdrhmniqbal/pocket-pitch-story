#!/usr/bin/env python3
"""Slice MODULAR chibi sprite part sheets into transparent per-part PNGs.

Input (public/sprites/parts/):
  media-generation-heads-set-*.webp   (4 heads in a row on magenta #ff00ff:
                                       0 short brown, 1 spiky black,
                                       2 long brown, 3 blonde w/ headband)
  media-generation-bodies-set-*.webp  (3 headless bodies in a row on magenta:
                                       0 home red/yellow, 1 away pink/blue,
                                       2 GK yellow/black)

Output (public/sprites/parts/sliced/):
  head-0.png .. head-3.png
  body-home.png, body-away.png, body-gk.png

Processing per sheet:
  1. Split into N equal vertical strips.
  2. Chroma-key out magenta #ff00ff (euclidean tolerance ~30 in RGB).
  3. Autocrop each strip to its content bounding box (+ padding).
  4. Save as RGBA PNG.

Usage:
  python3 scripts/slice-modular-parts.py [--tolerance 30] [--padding 8]
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTS_DIR = os.path.join(ROOT, "public", "sprites", "parts")
OUT_DIR = os.path.join(PARTS_DIR, "sliced")

KEY = (0xFF, 0x00, 0xFF)  # magenta chroma background

SHEETS = (
    # glob prefix, strip count, output names
    ("media-generation-heads-set-", 4, ["head-0", "head-1", "head-2", "head-3"]),
    ("media-generation-bodies-set-", 3, ["body-home", "body-away", "body-gk"]),
)


def find_sheet(prefix: str) -> str:
    cands = sorted(glob.glob(os.path.join(PARTS_DIR, prefix + "*.webp")))
    if not cands:
        raise FileNotFoundError(f"No sheet matching {prefix}*.webp in {PARTS_DIR}")
    return cands[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tolerance", type=float, default=30.0)
    ap.add_argument("--padding", type=int, default=8)
    ap.add_argument("--fringe-tolerance", type=float, default=80.0,
                    help="wider tolerance for a second key pass applied only to "
                         "opaque pixels adjacent to transparency (WebP edge fringe)")
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow is required (pip install pillow).", file=sys.stderr)
        return 1
    try:
        import numpy as np
    except ImportError:
        print("ERROR: numpy is required (pip install numpy).", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    tol2 = args.tolerance * args.tolerance
    pad = args.padding
    key = np.array(KEY, dtype=np.int16)

    for prefix, count, names in SHEETS:
        src = find_sheet(prefix)
        im = Image.open(src).convert("RGB")
        w, h = im.size
        arr = np.asarray(im).astype(np.int16)
        strip_w = w / count
        # Gap-seeking splits: artwork can bleed across the naive equal-split
        # lines, so move each interior boundary to the emptiest column
        # (fewest non-keyed pixels) within +/-20% of a strip width.
        # A column is "background" if within base tolerance of magenta.
        _d = arr - key
        _bg = (_d[:, :, 0] ** 2 + _d[:, :, 1] ** 2 + _d[:, :, 2] ** 2) <= tol2
        _fr2 = args.fringe_tolerance * args.fringe_tolerance
        _bg_wide = (_d[:, :, 0] ** 2 + _d[:, :, 1] ** 2 + _d[:, :, 2] ** 2) <= _fr2
        # Score each column by content in a +/-1 neighbourhood under the WIDE
        # tolerance, so splits avoid WebP smear columns clinging to artwork.
        col_content = (~_bg_wide).astype(np.int32)
        col_content = col_content + np.roll(col_content, 1, axis=0) + np.roll(col_content, -1, axis=0)
        col_content = col_content.sum(axis=0)
        bounds = [0]
        for b in range(1, count):
            exp = int(round(b * strip_w))
            lo = max(0, int(exp - strip_w * 0.2))
            hi = min(w - 1, int(exp + strip_w * 0.2))
            seg = col_content[lo:hi + 1]
            best = lo + int(seg.argmin())
            if seg.min() > 0:
                print(f"  WARN: no clean gap near x={exp}, using emptiest col x={best} "
                      f"(content={int(seg.min())}px)", flush=True)
                best = exp
            bounds.append(best)
        bounds.append(w)
        print(f"{prefix.rstrip('-')}: {os.path.basename(src)} {w}x{h} -> {count} strips", flush=True)
        print(f"  split columns: {bounds}", flush=True)
        for i, name in enumerate(names):
            x0, x1 = bounds[i], bounds[i + 1]
            strip = arr[:, x0:x1, :]
            d = strip - key
            dist2 = d[:, :, 0] ** 2 + d[:, :, 1] ** 2 + d[:, :, 2] ** 2
            alpha = np.where(dist2 <= tol2, 0, 255).astype(np.uint8)
            # Fringe pass: WebP compression leaves near-magenta edge pixels
            # just outside the base tolerance. Key them too, but ONLY where
            # adjacent to already-transparent pixels so interior pinks
            # (e.g. the away kit) are never eaten.
            fringe2 = args.fringe_tolerance * args.fringe_tolerance
            fringe = (dist2 <= fringe2) & (alpha == 255)
            if fringe.any():
                from PIL import Image as _I
                from PIL.ImageFilter import MaxFilter as _Max
                t = np.array(_I.fromarray((alpha == 0).astype(np.uint8) * 255).filter(_Max(3))) > 0
                alpha[fringe & t] = 0
            rgba = np.dstack([strip.astype(np.uint8), alpha])
            mask = alpha > 0
            if not mask.any():
                print(f"  WARN: {name} fully keyed out, saving empty strip", flush=True)
                out_im = Image.fromarray(rgba, "RGBA")
            else:
                ys, xs = np.nonzero(mask)
                minx = max(0, int(xs.min()) - pad)
                miny = max(0, int(ys.min()) - pad)
                maxx = min(strip.shape[1] - 1, int(xs.max()) + pad)
                maxy = min(strip.shape[0] - 1, int(ys.max()) + pad)
                out_im = Image.fromarray(rgba, "RGBA").crop((minx, miny, maxx + 1, maxy + 1))
            out = os.path.join(OUT_DIR, f"{name}.png")
            out_im.save(out, "PNG")
            print(f"  wrote {os.path.relpath(out, ROOT)} {out_im.size[0]}x{out_im.size[1]}", flush=True)
    print("done.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
