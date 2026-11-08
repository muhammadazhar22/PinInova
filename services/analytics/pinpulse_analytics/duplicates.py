"""Near-duplicate image clusters (SPEC-021, cause C evidence).

policy: PA-03 (PERSIST_IMAGE_HASHES=false) - perceptual hashes are computed transiently from the image bytes in
the request and never stored here; the caller persists only cluster membership. Hashes are returned only when
the caller explicitly asks (`return_hashes`).

pHash (imagehash, 64-bit DCT hash) -> pairwise Hamming distance vectorised in blocks with numpy popcount ->
union-find connected components at distance <= threshold.
"""
from __future__ import annotations

import base64
import binascii
import io

import imagehash
import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # decompression-bomb guard


class DuplicatesError(ValueError):
    pass


def phash_from_base64(data: str, pin_id: str) -> int:
    s = data.strip()
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    try:
        raw = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError) as e:
        raise DuplicatesError(f"pin {pin_id}: image_base64 is not valid base64") from e
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.load()
            h = imagehash.phash(im)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as e:
        raise DuplicatesError(f"pin {pin_id}: image could not be decoded ({type(e).__name__})") from e
    finally:
        del raw
    return int(str(h), 16)


def hamming_pairs(hashes: np.ndarray, threshold: int, block: int = 512) -> list[tuple[int, int]]:
    """All pairs (i < j) with popcount(h_i XOR h_j) <= threshold, computed block-wise (n = 5,000 -> 12.5M pairs)."""
    h = hashes.astype(np.uint64)
    n = len(h)
    out: list[tuple[int, int]] = []
    for s in range(0, n, block):
        blk = h[s:s + block]
        d = np.bitwise_count(blk[:, None] ^ h[None, :])
        ii, jj = np.nonzero(d <= threshold)
        gi = ii + s
        keep = jj > gi
        out.extend(zip(gi[keep].tolist(), jj[keep].tolist()))
    return out


class _UF:
    def __init__(self, n: int) -> None:
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def find_duplicates(items: list[tuple[str, str | None, str | None]], threshold: int = 8,
                    return_hashes: bool = False) -> dict:
    """items: (pin_id, image_base64 | None, phash_hex | None).

    duplicate_rate = (Pins in clusters - number of clusters) / Pins with a hash, i.e. the share of Pins that are
    near-copies of another Pin in the set (a set of 10 identical images has rate 0.9).
    """
    ids: list[str] = []
    vals: list[int] = []
    for pin_id, img, ph in items:
        if ph is not None:
            vals.append(int(ph, 16))
        elif img is not None:
            vals.append(phash_from_base64(img, pin_id))
        else:
            continue
        ids.append(pin_id)
    if not ids:
        return {"clusters": [], "duplicate_rate": 0.0, "hashes": {} if return_hashes else None}
    arr = np.array(vals, dtype=np.uint64)
    uf = _UF(len(ids))
    for i, j in hamming_pairs(arr, threshold):
        uf.union(i, j)
    groups: dict[int, list[int]] = {}
    for i in range(len(ids)):
        groups.setdefault(uf.find(i), []).append(i)
    clusters = sorted(([ids[i] for i in g] for g in groups.values() if len(g) >= 2), key=lambda c: (-len(c), c[0]))
    redundant = sum(len(c) - 1 for c in clusters)
    hashes = {ids[i]: f"{vals[i]:016x}" for i in range(len(ids))} if return_hashes else None
    return {"clusters": clusters, "duplicate_rate": redundant / len(ids), "hashes": hashes}
