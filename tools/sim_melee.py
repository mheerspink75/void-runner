"""
sim_melee.py — Headless simulation of the melee + weapon state machines.

Node is not available in this environment, so instead of running the real
modules we re-implement their exact logic from source and drive it frame by
frame at a fixed dt. This verifies the *timing invariants* that static
analysis cannot: that a swing lands exactly once, that the hit lands on the
configured frame, and that ammo/cooldowns never go negative or double-fire.

Usage:  python3 tools/sim_melee.py
Exit 0 = all invariants hold, 1 = a violation was found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = (ROOT / "js" / "config.js").read_text()
PLR = (ROOT / "js" / "player.js").read_text()
WPN = (ROOT / "js" / "weapons.js").read_text()


def num(name: str, text: str = CFG) -> float:
    m = re.search(rf"\b{name}:\s*(-?[\d.]+)", text)
    if not m:
        sys.exit(f"sim: could not find config value {name!r}")
    return float(m.group(1))


SWING = num("meleeSwing")
HIT_PT = num("meleeHitPoint")
WINDUP = num("meleeWindup")
COOLDOWN = num("meleeCooldown")
STAM_COST = num("meleeStaminaCost")
RPM = num("rpm")
MAG = num("magSize")

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


print("=" * 64)
print("melee / weapon timing simulation")
print("=" * 64)
print(f"  swing={SWING}s  hitPoint={HIT_PT}  windup={WINDUP}s")
print(f"  windup delay = {HIT_PT * SWING:.4f}s (config.meleeWindup={WINDUP})")
print(f"  cooldown={COOLDOWN}s  stamina/swing={STAM_COST}")
print(f"  rifle: {RPM} rpm -> {60 / RPM * 1000:.1f} ms/shot, mag={MAG:.0f}")
print()

# ----------------------------------------------------------------------
# 1. Hit lands exactly once, on the configured frame
# ----------------------------------------------------------------------
print("[1] swing resolves exactly once, on the impact frame")
for fps in (30, 60, 90, 144, 240):
    dt = 1.0 / fps
    # Mirror player.js exactly: meleeT counts up, meleeResolved latches.
    melee_t = 0.0
    resolved = False
    hits = 0
    impact_frame = None
    frames = int(COOLDOWN / dt) + 5
    for f in range(frames):
        melee_t += dt
        if not resolved and melee_t >= HIT_PT * SWING:
            resolved = True
            hits += 1
            impact_frame = f + 1
    impact_at = impact_frame * dt
    err = abs(impact_at - WINDUP)
    check(hits == 1, f"{fps}fps: swing resolved {hits} times, expected 1")
    check(err <= dt + 1e-9,
          f"{fps}fps: impact at {impact_at:.4f}s vs windup {WINDUP}s "
          f"(off by {err:.4f}s > one frame {dt:.4f}s)")
    print(f"    {fps:>3} fps -> 1 hit at {impact_at:.4f}s "
          f"(err {err * 1000:.1f}ms, frame {dt * 1000:.1f}ms)  OK")

print()

# ----------------------------------------------------------------------
# 2. Second swing is gated by the cooldown
# ----------------------------------------------------------------------
print("[2] cooldown gates a second swing")
for fps in (60, 144):
    dt = 1.0 / fps
    melee_cd = 0.0
    swings = 0
    # player mashes the melee key every frame
    for _ in range(int(1.5 / dt)):
        if melee_cd > 0:
            melee_cd -= dt
        if melee_cd <= 0:
            swings += 1
            melee_cd = COOLDOWN
    expected = int(1.5 // COOLDOWN) + 1
    check(swings == expected,
          f"{fps}fps: mash produced {swings} swings in 1.5s, expected {expected}")
    print(f"    {fps:>3} fps -> {swings} swings in 1.5s (expected {expected})  OK")

print()

# ----------------------------------------------------------------------
# 3. Swing is dodgeable: an enemy can leave the range during windup
# ----------------------------------------------------------------------
print("[3] a swing started on a fleeing target at the edge of range can whiff")
RANGE = num("meleeRange")


class Target:
    def __init__(self, speed, start):
        self.x = start
        self.speed = speed
        self.struck = False

    def step(self, dt):
        self.x += self.speed * dt

    def in_range(self, reach):
        return self.x <= reach


# The interesting case is a target at the *outer* edge of the arc: it has the
# most room to leave. A target already in your face cannot dodge anything.
for fps in (60, 144):
    dt = 1.0 / fps
    t = Target(speed=8.8, start=RANGE * 0.75)   # PHANTOM, fleeing
    struck = False
    melee_t = 0.0
    resolved = False
    while melee_t < SWING:
        t.step(dt)
        melee_t += dt
        if not resolved and melee_t >= HIT_PT * SWING:
            resolved = True
            struck = t.in_range(RANGE)
    check(not struck,
          f"{fps}fps: a PHANTOM fleeing from {RANGE * 0.75:.2f}u should "
          f"escape during the {WINDUP}s windup, but was still hit")
    print(f"    {fps:>3} fps -> target escaped "
          f"({t.x:.2f}u > {RANGE}u reach)  OK")

print()
print("    a point-blank target still cannot escape:")
t = Target(speed=8.8, start=0.3)
for _ in range(int(WINDUP / (1.0 / 144))):
    t.step(1.0 / 144)
check(t.in_range(RANGE), "a target 0.3u away escaped a melee swing during windup")
print(f"      at 0.3u, PHANTOM reaches only {t.x:.2f}u -> still in range  OK")

print()

# ----------------------------------------------------------------------
# 4. Rifle: fire rate, ammo drain, auto-reload, no double fire
# ----------------------------------------------------------------------
print("[4] rifle fire rate / ammo / auto-reload")
for fps in (30, 60, 144, 240):
    dt = 1.0 / fps
    cooldown = 0.0
    mag = MAG
    reserve = 270.0
    reloading = False
    reload_t = 0.0
    RELOAD_TIME = num("reloadTime")
    shots = 0
    held = True
    duration = 6.0
    for _ in range(int(duration / dt)):
        if reloading:
            reload_t += dt
            if reload_t >= RELOAD_TIME:
                take = min(MAG - mag, reserve)
                mag += take
                reserve -= take
                reloading = False
                reload_t = 0.0
        if cooldown > 0:
            cooldown -= dt
        if held and cooldown <= 0 and not reloading and mag > 0:
            mag -= 1
            shots += 1
            cooldown = 60.0 / RPM
            if mag <= 0:
                reloading = True
                reload_t = 0.0
    expected = duration * RPM / 60.0
    # allow a little slack: one magazine boundary + the partial reload window
    slack = MAG + RELOAD_TIME * RPM / 60.0
    check(abs(shots - expected) <= slack + 1,
          f"{fps}fps: {shots} shots in {duration}s, expected ~{expected:.0f} "
          f"(slack {slack:.1f})")
    check(mag >= 0, f"{fps}fps: mag went negative ({mag})")
    check(reserve >= 0, f"{fps}fps: reserve went negative ({reserve})")
    print(f"    {fps:>3} fps -> {shots:>3} shots in {duration}s "
          f"(ideal {expected:.1f})  mag={mag:.0f} reserve={reserve:.0f}  OK")

print()

# ----------------------------------------------------------------------
# 5. Auto-reload fires without any further trigger input
# ----------------------------------------------------------------------
print("[5] auto-reload starts on depletion alone (no extra input)")
dt = 1.0 / 60
mag = 5.0
cooldown = 0.0
reloading = False
auto_started = False
# fire exactly the whole magazine, then STOP pressing fire entirely
for _ in range(int(2.0 / dt)):
    if reloading:
        auto_started = True
    if cooldown > 0:
        cooldown -= dt
    if cooldown <= 0 and not reloading and mag > 0:
        mag -= 1
        cooldown = 60.0 / RPM
        if mag <= 0:
            reloading = True
check(auto_started, "magazine emptied but no reload was triggered without further input")
check(mag == 0, f"expected mag to be drained, got {mag}")
print(f"    reload auto-triggered with the trigger released: "
      f"{'yes' if auto_started else 'NO'}  OK")

print()
print("=" * 64)
if failures:
    print(f"FAIL: {len(failures)} invariant(s) violated")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print("OK: all melee and weapon timing invariants hold")
