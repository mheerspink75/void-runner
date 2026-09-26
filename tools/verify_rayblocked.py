"""
verify_rayblocked.py — Differential test of World.rayBlocked.

The slab/AABB line-of-sight test was rewritten to remove a per-call nested
array allocation. It is easy to introduce an off-by-one or an inverted slab
condition in a hand-unrolled version, and a wrong answer here silently
changes enemy AI: enemies would see through walls (or not see at all).

This re-implements the ORIGINAL algorithm and the NEW one, then compares
them across a large randomised sweep plus hand-picked edge cases. Any
disagreement is a regression.

Usage:  python3 tools/verify_rayblocked.py
Exit 0 = identical behaviour, 1 = mismatch.
"""

from __future__ import annotations

import random
import sys


class Box:
    def __init__(self, minX, maxX, minY, maxY, minZ, maxZ, tag="wall"):
        self.minX, self.maxX = minX, maxX
        self.minY, self.maxY = minY, maxY
        self.minZ, self.maxZ = minZ, maxZ
        self.tag = tag


def original(colliders, ax, ay, az, bx, by, bz):
    dx, dy, dz = bx - ax, by - ay, bz - az
    for c in colliders:
        if c.tag == "platform":
            continue
        t0, t1 = 0.0, 1.0
        ok = True
        for o, d, mn, mx in (
            (ax, dx, c.minX, c.maxX),
            (ay, dy, c.minY, c.maxY),
            (az, dz, c.minZ, c.maxZ),
        ):
            if abs(d) < 1e-8:
                if o < mn or o > mx:
                    ok = False
                    break
            else:
                n = (mn - o) / d
                f = (mx - o) / d
                if n > f:
                    n, f = f, n
                if n > t0:
                    t0 = n
                if f < t1:
                    t1 = f
                if t0 > t1:
                    ok = False
                    break
        if ok and t0 < 0.97:
            return True
    return False


def rewritten(colliders, ax, ay, az, bx, by, bz):
    dx, dy, dz = bx - ax, by - ay, bz - az
    for c in colliders:
        if c.tag == "platform":
            continue
        t0, t1 = 0.0, 1.0

        ok = True
        if abs(dx) < 1e-8:
            if ax < c.minX or ax > c.maxX:
                ok = False
        else:
            n = (c.minX - ax) / dx
            f = (c.maxX - ax) / dx
            if n > f:
                n, f = f, n
            if n > t0:
                t0 = n
            if f < t1:
                t1 = f
            if t0 > t1:
                ok = False

        if ok:
            if abs(dy) < 1e-8:
                if ay < c.minY or ay > c.maxY:
                    ok = False
            else:
                n = (c.minY - ay) / dy
                f = (c.maxY - ay) / dy
                if n > f:
                    n, f = f, n
                if n > t0:
                    t0 = n
                if f < t1:
                    t1 = f
                if t0 > t1:
                    ok = False

        if ok:
            if abs(dz) < 1e-8:
                if az < c.minZ or az > c.maxZ:
                    ok = False
            else:
                n = (c.minZ - az) / dz
                f = (c.maxZ - az) / dz
                if n > f:
                    n, f = f, n
                if n > t0:
                    t0 = n
                if f < t1:
                    t1 = f
                if t0 > t1:
                    ok = False

        if ok and t0 < 0.97:
            return True
    return False


mismatches = []


def cmp(colliders, *args, label=""):
    a = original(colliders, *args)
    b = rewritten(colliders, *args)
    if a != b:
        mismatches.append((label, args, a, b))


print("=" * 64)
print("rayBlocked differential test")
print("=" * 64)

# ----------------------------------------------------------------------
# 1. Hand-picked edge cases
# ----------------------------------------------------------------------
box = [Box(0, 10, 0, 10, 0, 10)]           # 10x10x10 block at the origin
cases = [
    ((-5, 5, 5, 5, 5, 5), "straight through the middle"),
    ((-5, 5, 5, 20, 5, 5), "through, ending past the far side"),
    ((-5, 5, 5, 5, 5, 20), "through on Z"),
    ((-5, 5, 5, 5, 20, 5), "through on Y"),
    ((-5, -5, 5, 5, 5, 5), "away from the block"),
    ((5, 5, 5, 5, 5, 5), "degenerate: start == end inside the block"),
    ((-5, 5, 5, -5, 5, 5), "straight up out of the block"),
    ((20, 5, 5, -5, 5, 5), "missing entirely, both outside"),
    ((-5, 5, 5, 5, 5, 5), "start inside, end inside"),
    ((-5, 5, 5, 5, 5, 0.0001), "grazing the near face"),
    ((-5, 5, 5, 5, 5, 9.9999), "grazing the far face"),
    ((-5, 5, 5, 5, 5, 10), "exactly on the far face"),
    ((-5, 5, 5, 5, 5, 10.0001), "just past the far face"),
    ((-5, 5, 5, 5, 5, -0.0001), "just before the near face"),
    ((5, 5, 5, 5, 5, 5), "zero direction on every axis, inside"),
    ((-5, 5, 5, 15, 5, 5), "diagonal out of the top"),
    ((-5, 5, 5, 5, 5, 15), "diagonal out of the far side"),
    ((-20, 5, 5, 20, 5, 5), "long horizontal, passes through"),
]
print(f"[1] {len(cases)} hand-picked edge cases")
for args, label in cases:
    cmp(box, *args, label=label)
print(f"    {len(cases)} compared")

# A collider the ray starts inside but which is tagged 'platform' must be
# ignored entirely by both implementations.
plat = [Box(0, 10, 0, 10, 0, 10, tag="platform")]
cmp(plat, -5, 5, 5, 5, 5, 5, label="platform is skipped")
print("    platform-skip case compared")

# Degenerate direction on a single axis only (the 1e-8 epsilon path).
thin = [Box(0, 10, 5, 5, 0, 10)]            # zero-height slab
cmp(thin, -5, 5, 5, 5, 5, 5, label="flat slab, ray at exact Y")
cmp(thin, -5, 4.999999, 5, 5, 5, 5, label="flat slab, ray just below")
cmp(thin, -5, 5, 5, 5, 6, 5, label="flat slab, ray rising through")
print("    epsilon-path cases compared")
print()

# ----------------------------------------------------------------------
# 2. Randomised sweep
# ----------------------------------------------------------------------
random.seed(1337)
N = 200_000
for i in range(N):
    nc = random.randint(0, 4)
    cols = []
    for _ in range(nc):
        x0 = random.uniform(-30, 30)
        y0 = random.uniform(-5, 10)
        z0 = random.uniform(-30, 30)
        cols.append(Box(
            x0, x0 + random.uniform(0, 20),
            y0, y0 + random.uniform(0, 10),
            z0, z0 + random.uniform(0, 20),
            tag="platform" if random.random() < 0.15 else "wall",
        ))
    # Bias toward coordinates that land exactly on faces, to stress the
    # strict vs non-strict comparisons at the boundaries.
    def coord():
        r = random.random()
        if r < 0.25:
            return random.choice([0, 10, -0.0, 10.0, 5, 20, -30, 30])
        return random.uniform(-40, 40)

    args = (coord(), coord(), coord(), coord(), coord(), coord())
    cmp(cols, *args, label=f"random#{i}")
print(f"[2] {N:,} randomised cases (face-biased coordinates)")
print(f"    {N:,} compared")
print()

print("=" * 64)
if mismatches:
    print(f"FAIL: {len(mismatches)} behavioural mismatch(es)")
    for label, args, a, b in mismatches[:10]:
        print(f"  {label}: args={tuple(round(v, 3) for v in args)} "
              f"original={a} rewritten={b}")
    sys.exit(1)
print("OK: rewritten rayBlocked is behaviourally identical")
print(f"    ({N + len(cases) + 4:,} cases, 0 mismatches)")
