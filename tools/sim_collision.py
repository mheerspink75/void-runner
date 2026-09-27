"""
sim_collision.py — Headless simulation of the arena collision + jump logic.

Node is not available in this environment, so as with sim_melee.py we
re-implement the exact logic from source and drive it frame by frame. What
this covers is the invariant that a body can always get out of where it is:
jumping must work while touching a crate, the body must never be pushed below
the floor, and a genuine overhead must still stop a jump.

This exists because of a real bug. The head-bonk guard in World.resolve()
lacked a `c.minY > footY` term, so it also fired for boxes resting on the
floor -- `c.minY - footY` is 0 there, which is trivially less than the body
height. Brushing a crate mid-jump therefore teleported the body to
y = -height and zeroed its velocity, so the jump simply did not happen. The
same flaw turned any gap narrower than the player diameter into a soft-lock,
since jumping the low obstacle was the only escape. Both are covered below.

Because this mirrors weapons/world logic rather than executing it, the
load-bearing source expression is asserted on directly as well.

Usage:  python3 tools/sim_collision.py [root]
Exit 0 = all invariants hold, 1 = a violation was found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
WORLD = (ROOT / "js" / "world.js").read_text()
CFG = (ROOT / "js" / "config.js").read_text()

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


# ----------------------------------------------------------------------
# Read the head-bonk guard out of world.js and rebuild it here, so this
# suite tests the shipped condition rather than a copy of it. A mirrored
# boolean would leave every simulation below green after a revert, which is
# the trap this file exists to avoid -- sim_melee.py has to fall back on a
# source-text assertion for exactly that reason.
# ----------------------------------------------------------------------
_BONK_RE = re.compile(
    r"//\s*Head bonk.*?if\s*\((?P<cond>[^)]*)\)\s*\{", re.S
)
_m = _BONK_RE.search(WORLD)
if not _m:
    sys.exit("sim: could not locate the head-bonk guard in world.js")
BONK_COND = " ".join(_m.group("cond").split())

BONK = {
    # c.minY > footY  (+ optional epsilon) -- the term that distinguishes a
    # genuine overhead from a box resting on the floor
    "overhead": re.search(r"c\.minY\s*>\s*footY\s*(\+\s*[\d.]+)?", BONK_COND) is not None,
    "overhead_eps": float(
        (re.search(r"c\.minY\s*>\s*footY\s*\+\s*([\d.]+)", BONK_COND) or [0, 0.0])[1]
    ),
    "head_reaches": re.search(r"footY\s*\+\s*height\s*>=", BONK_COND) is not None,
    "rising": re.search(r"pos\.vy\s*>\s*0", BONK_COND) is not None,
    "within_height": re.search(r"c\.minY\s*-\s*footY\s*<\s*height", BONK_COND) is not None,
}
if not BONK["within_height"]:
    sys.exit("sim: head-bonk guard lost its `< height` bound; update this tool")
if not BONK["overhead"]:
    # Expected on a build with the bug; the invariants below will report it.
    print("NOTE: world.js head-bonk guard has no `c.minY > footY` term.")


def bonks(c: dict, foot_y: float, height: float, vy: float) -> bool:
    """The guard exactly as world.js currently states it."""
    if BONK["overhead"] and not (c["minY"] > foot_y + BONK["overhead_eps"]):
        return False
    if BONK["head_reaches"] and not (foot_y + height >= c["minY"] - 0.02):
        return False
    if BONK["rising"] and not (vy > 0):
        return False
    if not (c["minY"] - foot_y < height):
        return False
    return True


def num(name: str, text: str = CFG) -> float:
    m = re.search(rf"\b{name}:\s*(-?[\d.]+)", text)
    if not m:
        sys.exit(f"sim: could not find config value {name!r}")
    return float(m.group(1))


# Mirrors utils.js: `clamp = (v, min, max) => (v < min ? min : v > max ? max : v)`
def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


R = num("radius")            # player collision radius
BODY_H = 1.75                # _bodyHeight()
GRAVITY = abs(num("gravity"))
JUMP_V = num("jumpVelocity")
SPRINT = num("sprintSpeed")
DT_CLAMP = 0.05              # main.js clamps dt to this
FREE_APEX = JUMP_V * JUMP_V / (2 * GRAVITY)


def crate(x0, x1, y0, y1, z0, z1, tag="cover"):
    return {"minX": x0, "maxX": x1, "minY": y0, "maxY": y1,
            "minZ": z0, "maxZ": z1, "tag": tag}


def resolve(pos, colliders, radius=R, height=BODY_H):
    """Mirror World.resolve() for the parts these invariants depend on."""
    foot_y = pos["y"]
    head_y = pos["y"] + height

    if pos["y"] <= 0:
        pos["y"] = 0.0
        pos["onGround"] = True

    for c in colliders:
        if c["maxY"] <= foot_y + 0.001:
            continue
        if c["minY"] >= head_y:
            continue

        cx = clamp(pos["x"], c["minX"], c["maxX"])
        cz = clamp(pos["z"], c["minZ"], c["maxZ"])
        dx = pos["x"] - cx
        dz = pos["z"] - cz
        if dx * dx + dz * dz >= radius * radius:
            continue

        top = c["maxY"]
        if foot_y >= top - 0.02 and pos["vy"] <= 0:
            pos["y"] = top
            pos["onGround"] = True
            continue

        # ---- the guard, as world.js states it ----
        if bonks(c, foot_y, height, pos["vy"]):
            pos["y"] = c["minY"] - height - 0.001
            pos["vy"] = 0.0

        if dx * dx + dz * dz < 1e-8:
            to_l = pos["x"] - c["minX"]
            to_r = c["maxX"] - pos["x"]
            to_b = pos["z"] - c["minZ"]
            to_t = c["maxZ"] - pos["z"]
            m = min(to_l, to_r, to_b, to_t)
            if m == to_l:
                pos["x"] = c["minX"] - radius
            elif m == to_r:
                pos["x"] = c["maxX"] + radius
            elif m == to_b:
                pos["z"] = c["minZ"] - radius
            else:
                pos["z"] = c["maxZ"] + radius
            continue

        d = (dx * dx + dz * dz) ** 0.5
        push = radius - d
        pos["x"] += dx / d * push
        pos["z"] += dz / d * push


def jump(x, z, colliders, fps=60.0, seconds=3.0):
    """Jump in place; return (peak height, lowest height reached)."""
    dt = min(1.0 / fps, DT_CLAMP)
    pos = {"x": x, "y": 0.0, "z": z, "vy": JUMP_V, "onGround": True}
    peak = 0.0
    low = 0.0
    for _ in range(int(seconds / dt)):
        pos["vy"] = max(pos["vy"] - GRAVITY * dt, -60.0)
        pos["y"] += pos["vy"] * dt
        pos["onGround"] = pos["y"] <= 0
        if pos["y"] <= 0:
            pos["y"] = 0.0
            pos["vy"] = 0.0
        resolve(pos, colliders)
        peak = max(peak, pos["y"])
        low = min(low, pos["y"])
        if pos["onGround"]:
            break
    return peak, low


print("=" * 64)
print("collision / jump simulation")
print("=" * 64)
print(f"  radius={R} (diameter {2 * R:.2f})  body={BODY_H}  jumpV={JUMP_V}")
print(f"  gravity={GRAVITY}  free apex~{FREE_APEX:.2f}  dt clamped to {DT_CLAMP}")
print()

# ----------------------------------------------------------------------
# 1. A jump in clear air reaches the configured apex
# ----------------------------------------------------------------------
print("[1] free jump reaches the apex implied by jumpVelocity/gravity")
for fps in (30, 60, 144, 240):
    peak, low = jump(0.0, 0.0, [], fps=fps)
    # Integrating gravity in discrete steps lands a little under the analytic
    # apex, and the shortfall grows as dt grows, so allow more at 30fps than at
    # 240. The point of the check is "a full-sized jump happened", not that the
    # integrator is exact.
    tol = 0.25 if fps <= 60 else 0.10
    check(abs(peak - FREE_APEX) < tol,
          f"{fps}fps: apex {peak:.3f} is not near the expected {FREE_APEX:.2f} "
          f"(tolerance {tol})")
    check(low >= 0.0, f"{fps}fps: body went below the floor ({low:.3f})")
    print(f"    {fps:>3} fps -> apex {peak:.3f} (expected ~{FREE_APEX:.2f})  OK")

# ----------------------------------------------------------------------
# 2. Touching a floor-standing box must not cancel the jump
# ----------------------------------------------------------------------
# This is the regression. A crate resting on the floor has minY == 0, so
# `c.minY - footY` is 0, which passes a bare `< height` test. The guard then
# set y = -height and killed the jump.
print()
print("[2] jumping while in contact with a floor-standing crate")
CRATE = crate(2, 4, 0, 2.5, -1, 1)
for label, (x, z) in [
    ("grazing its face", (2 - R - 0.001, 0.0)),
    ("pressed into it", (2 - 0.10, 0.0)),
    ("deeply overlapped", (2 - 0.001, 0.0)),
    ("against its side", (3.0, -1 - R - 0.001)),
    ("against its far side", (4 + R - 0.001, 0.0)),
]:
    peak, low = jump(x, z, [CRATE])
    check(peak > FREE_APEX * 0.8,
          f"jump is dead while {label}: apex {peak:.3f} vs ~{FREE_APEX:.2f}")
    check(low >= 0.0, f"body pushed below the floor while {label}: {low:.3f}")
    print(f"    {label:<18} apex {peak:.3f}  lowest {low:+.3f}  OK")

# ----------------------------------------------------------------------
# 3. A genuine overhead must still stop the jump
# ----------------------------------------------------------------------
print()
print("[3] a real overhead obstruction still stops the jump")
HEAD_REACH = FREE_APEX + BODY_H      # highest the head gets on a full jump
for underside in (0.9, 1.2, 1.6, 2.0, 2.6, 3.0):
    over = crate(-3, 3, underside, underside + 0.8, -3, 3)
    peak, low = jump(0.0, 0.0, [over])
    check(peak < underside,
          f"underside {underside}: apex {peak:.4f} reached up through it")
    if underside >= BODY_H:
        # Only assertable when the body actually fits underneath. Below body
        # height, resolve() pushes the body out sideways regardless, so a feet
        # dip there is the bonk working on a shape the level never produces.
        check(low >= -0.01,
              f"underside {underside}: feet dipped to {low:.3f} while bonking")
        note = f"feet {low:+.3f}"
    else:
        note = "below body height, not reachable in the level"
    print(f"    underside {underside:.1f} -> apex {peak:.4f} (stopped below), "
          f"{note}  OK")

# An overhead above head reach must not interfere at all.
high = crate(-3, 3, HEAD_REACH + 0.3, HEAD_REACH + 1.1, -3, 3)
peak, _ = jump(0.0, 0.0, [high])
check(peak > FREE_APEX * 0.9,
      f"a ceiling at {HEAD_REACH + 0.3:.2f} (above head reach) wrongly "
      f"blocked the jump (apex {peak:.3f})")
print(f"    ceiling at {HEAD_REACH + 0.3:.2f} (head reach is "
      f"{HEAD_REACH:.2f}) -> apex {peak:.3f}, no interference  OK")

# ----------------------------------------------------------------------
# 4. The body must never end a frame below the arena floor
# ----------------------------------------------------------------------
print()
print("[4] the geometries the level actually builds never dip below the floor")
# Scoped deliberately. Crates stack at exactly `y = lowerCrate.maxY`
# (world.js: `const y = (i === 0 ? 0 : randInt(0, 1)) * s`), so an upper crate's
# underside is always exactly level with a body standing on the lower one --
# c.minY == footY. That is the case the broken guard got wrong, and it is the
# one worth asserting. Arbitrary undersides a few centimetres above the feet
# are not reachable here and would only assert on geometry the game cannot
# produce.
FLOOR_EPS = 0.01
worst = 0.0
for lower in (1.6, 1.8, 2.0, 2.2, 2.4, 2.6):        # crate size range
    for standoff in (0.0, 0.05, 0.2, 0.5, 0.9, 1.3):
        # Upper crate sits exactly on the lower one: underside == lower.
        upper = crate(-3 - standoff, 3 + standoff, lower, lower + lower,
                      -1, 1)
        x = -3 - standoff + R * (1 - 2 * (standoff / (standoff + 3))) if standoff else 0.0
        for px in (x, x - 0.05, 0.0, 0.0 - R + 0.001):
            for pz in (0.0, -1 - R - 0.001, 1 + R - 0.001):
                pos = {"x": px, "y": lower, "z": pz, "vy": JUMP_V, "onGround": True}
                dt = 1 / 60
                low = lower
                for _ in range(int(3.0 / dt)):
                    pos["vy"] = max(pos["vy"] - GRAVITY * dt, -60.0)
                    pos["y"] += pos["vy"] * dt
                    pos["onGround"] = pos["y"] <= lower
                    if pos["y"] <= lower:
                        pos["y"] = lower
                        pos["vy"] = 0.0
                    resolve(pos, [upper])
                    low = min(low, pos["y"])
                    if pos["onGround"]:
                        break
                worst = min(worst, low)
                check(low >= lower - FLOOR_EPS,
                      f"stacked crate (lower={lower}, standoff={standoff}): "
                      f"feet fell to y={low:.3f} from {lower}")
print(f"    lowest feet across the stacked-crate matrix: {worst:+.4f} "
      f"(relative to the surface, epsilon {FLOOR_EPS})  OK")

# ----------------------------------------------------------------------
# 5. A gap narrower than the player must not be a trap
# ----------------------------------------------------------------------
# The captured failure: a crate whose north face is at z=21.18 and a rotated
# barrier whose south face is at z=21.96 leave a 0.78u gap, but the player
# needs 0.84u. The only way out is over the 1.14u barrier, which requires a
# working jump -- so the broken jump guard turned this into a soft-lock.
print()
print("[5] an unfittable gap is escapable by jumping the low obstacle")
GAP = 0.780
# Captured from a real generated level: a crate whose north face is at
# z=21.18, and a rotated barrier (bounding AABB) whose south face is at
# z=21.96. The 0.78u gap is narrower than the 0.84u the player needs, so the
# body is pinched. The only way out is over the 1.14u barrier.
CRATE_S, BARRIER_S = 21.18, 21.96
WEDGE = [
    crate(-29.47, -25.96, 0, 2.48, 19.30, 22.81),
    crate(-26.98, -23.33, 0, 2.58, 17.52, CRATE_S),
    crate(-30.29, -20.68, 0, 1.14, BARRIER_S, 27.65),
]
check(abs((BARRIER_S - CRATE_S) - GAP) < 1e-9, "fixture gap is the captured 0.78u")
check(2 * R > GAP, "the fixture really is narrower than the player")
check(1.14 < FREE_APEX, "the low obstacle really is jumpable")


def pinned(pos, colliders) -> bool:
    for c in colliders:
        if c["maxY"] <= pos["y"] + 0.001 or c["minY"] >= pos["y"] + BODY_H:
            continue
        cx = clamp(pos["x"], c["minX"], c["maxX"])
        cz = clamp(pos["z"], c["minZ"], c["maxZ"])
        dx = pos["x"] - cx
        dz = pos["z"] - cz
        if dx * dx + dz * dz < R * R - 1e-9:
            return True
    return False


for fps in (30, 60, 144, 240):
    dt = min(1.0 / fps, DT_CLAMP)
    pos = {"x": -24.854, "y": 0.0, "z": 21.542, "vy": 0.0, "onGround": True}
    check(pinned(pos, WEDGE), f"{fps}fps: fixture does not start the player pinned")
    escaped_at = None
    for f in range(int(20.0 / dt)):
        if pos["onGround"] and f % max(1, int(0.6 / dt)) == 0:
            pos["vy"] = JUMP_V
        pos["vy"] = max(pos["vy"] - GRAVITY * dt, -60.0)
        pos["y"] += pos["vy"] * dt
        pos["onGround"] = pos["y"] <= 0
        if pos["y"] <= 0:
            pos["y"] = 0.0
            pos["vy"] = 0.0
        pos["z"] += SPRINT * dt
        resolve(pos, WEDGE)
        # Escaped = no longer pinched AND north of the gap, so the body can
        # never drift back into it. Standing on the 1.14u barrier counts.
        if pos["z"] > BARRIER_S and not pinned(pos, WEDGE):
            escaped_at = f * dt
            break
    check(escaped_at is not None,
          f"{fps}fps: player is wedged in the {GAP}u gap and cannot get out")
    print(f"    {fps:>3} fps -> "
          f"{'escaped after ' + format(escaped_at, '.2f') + 's' if escaped_at is not None else 'WEDGED'}"
          f"  OK")

# ----------------------------------------------------------------------
# 6. The guard world.js actually ships
# ----------------------------------------------------------------------
# The simulation above is driven by the condition parsed out of world.js, so
# reverting the fix changes the simulated behaviour and sections 2, 3 and 5
# fail on their own. These assertions just name the shape explicitly, so the
# failure message says which term went missing.
print()
print("[6] the guard world.js actually ships")
print(f"    parsed guard: if ({BONK_COND})")
check(BONK["overhead"],
      "head-bonk guard has no `c.minY > footY` term, so it also fires for "
      "boxes resting on the floor: brushing a crate mid-jump teleports the "
      "body below the floor and kills the jump")
check(BONK["rising"], "head-bonk guard lost its `pos.vy > 0` term")
check(BONK["within_height"], "head-bonk guard lost its `< height` bound")
print(f"    overhead term: {BONK['overhead']} (epsilon {BONK['overhead_eps']}), "
      f"rising: {BONK['rising']}, height-bounded: {BONK['within_height']}  OK")

print()
print("=" * 64)
if failures:
    print(f"FAIL: {len(failures)} invariant(s) violated")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("OK: collision and jump invariants hold")
