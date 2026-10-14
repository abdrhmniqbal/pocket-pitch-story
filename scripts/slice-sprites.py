#!/usr/bin/env python3
"""Slice AI-generated chibi sprite sheets into transparent per-player PNGs.

Input (public/sprites/):
  media-generation-spritesheet-home-*.webp  (4 players in a row, red jersey)
  media-generation-spritesheet-away-*.webp  (4 players in a row, pink jersey)
  media-generation-spritesheet-gk-*.webp    (2 goalkeepers side by side, yellow)

Output (public/sprites/sliced/):
  home-0.png .. home-3.png
  away-0.png .. away-3.png
  gk-0.png .. gk-1.png

Processing per sheet:
  1. Split into N equal vertical strips.
  2. Chroma-key out the solid #2d5a27 green background (euclidean
     tolerance ~30 in RGB) -> transparent.
  3. Autocrop each strip to its content bounding box (+ padding).
  4. Save as RGBA PNG.

Usage:
  python3 scripts/slice-sprites.py [--tolerance 30] [--padding 8]
"""
from __future__ import annotations

import argparse
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "public", "sprites")
OUT_DIR = os.path.join(SRC_DIR, "sliced")

KEY = (0x2D, 0x5A, 0x27)  # #2d5a27

SHEETS = (
    ("home", "media-generation-spritesheet-home-", 4),
    ("away", "media-generation-spritesheet-away-", 4),
    ("gk", "media-generation-spritesheet-gk-", 2),
)


def find_sheet(prefix: str) -> str:
    cands = sorted(glob.glob(os.path.join(SRC_DIR, prefix + "*.webp")))
    if not cands:
        raise FileNotFoundError(f"No sheet matching {prefix}*.webp in {SRC_DIR}")
    return cands[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tolerance", type=float, default=30.0)
    ap.add_argument("--padding", type=int, default=8)
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow is required (pip install pillow).", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    tol2 = args.tolerance * args.tolerance
    pad = args.padding

    for name, prefix, count in SHEETS:
        src = find_sheet(prefix)
        im = Image.open(src).convert("RGB")
        w, h = im.size
        strip_w = w / count
        print(f"{name}: {os.path.basename(src)} {w}x{h} -> {count} strips", flush=True)
        for i in range(count):
            x0 = int(round(i * strip_w))
            x1 = int(round((i + 1) * strip_w))
            strip = im.crop((x0, 0, x1, h)).convert("RGBA")
            data = strip.load()
            sw, sh = strip.size
            minx, miny, maxx, maxy = sw, sh, -1, -1
            for y in range(sh):
                for x in range(sw):
                    r, g, b, _a = data[x, y]
                    dr, dg, db = r - KEY[0], g - KEY[1], b - KEY[2]
                    if dr * dr + dg * dg + db * db <= tol2:
                        data[x, y] = (0, 0, 0, 0)
                    else:
                        if x < minx:
                            minx = x
                        if x > maxx:
                            maxx = x
                        if y < miny:
                            miny = y
                        if y > maxy:
                            maxy = y
            if maxx < 0:
                print(f"  WARN: {name}-{i} fully keyed out, skipping crop", flush=True)
                cropped = strip
            else:
                minx = max(0, minx - pad)
                miny = max(0, miny - pad)
                maxx = min(sw - 1, maxx + pad)
                maxy = min(sh - 1, maxy + pad)
                cropped = strip.crop((minx, miny, maxx + 1, maxy + 1))
            out = os.path.join(OUT_DIR, f"{name}-{i}.png")
            cropped.save(out, "PNG")
            print(f"  wrote {os.path.relpath(out, ROOT)} {cropped.size[0]}x{cropped.size[1]}", flush=True)
    print("done.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
