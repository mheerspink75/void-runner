#!/usr/bin/env python3
"""
smoke.py — Headless integration checks for VOID RUNNER.

There is no Node in this environment and the browser CDP bridge has proven
unreliable, so this does the next most valuable thing: verify that the
*contracts between files* actually line up. Each of these is a bug class
that otherwise only shows up as a runtime TypeError in the browser.

  1. every getElementById('x') in JS has a matching id="x" in index.html
  2. every classList.toggle/add/remove('x') in JS has a .x rule in style.css
  3. every CONFIG.section read in JS exists in config.js
  4. every KEYS.action read in JS exists in the KEYS map
  5. every weapon id in weapons.slots exists in CONFIG.weapons
  6. waves.mix covers every enemy archetype

Usage:  python3 tools/smoke.py [root]
Exit 0 = clean.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
SKIP_DIRS = {".venv", "node_modules", ".git", "vendor", "tools"}

problems: list[str] = []


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def js_files() -> list[str]:
    out = []
    for d, dn, fn in os.walk(ROOT):
        dn[:] = [x for x in dn if x not in SKIP_DIRS]
        out += [os.path.join(d, f) for f in fn if f.endswith(".js")]
    return sorted(out)


def read(p: str) -> str:
    with open(p, encoding="utf-8") as fh:
        return fh.read()


# ----------------------------------------------------------------------
def check_dom_ids() -> None:
    html = read(os.path.join(ROOT, "index.html"))
    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    pat = re.compile(r"""getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""")
    for path in js_files():
        src = read(path)
        for m in pat.finditer(src):
            name = m.group(1)
            line = src[: m.start()].count("\n") + 1
            if name not in html_ids:
                problems.append(
                    f"{rel(path)}:{line}: getElementById('{name}') "
                    f"but index.html has no id='{name}'"
                )


def check_css_classes() -> None:
    css = read(os.path.join(ROOT, "css", "style.css"))
    css_classes = set(re.findall(r"\.([A-Za-z_][\w-]*)", css))
    pat = re.compile(r"""classList\.(?:add|remove|toggle)\(\s*['"]([A-Za-z0-9_-]+)['"]""")
    for path in js_files():
        src = read(path)
        for m in pat.finditer(src):
            name = m.group(1)
            line = src[: m.start()].count("\n") + 1
            if name == "hidden":
                continue
            if name not in css_classes:
                problems.append(
                    f"{rel(path)}:{line}: classList uses '{name}' "
                    f"but style.css defines no .{name}"
                )


def config_body() -> str:
    src = read(os.path.join(ROOT, "js", "config.js"))
    m = re.search(r"export const CONFIG = \{(.*?)\n\};", src, re.S)
    if not m:
        problems.append("config.js: could not locate CONFIG object")
        return ""
    return m.group(1)


def check_config_sections() -> None:
    body = config_body()
    if not body:
        return
    sections = set(re.findall(r"(?m)^  ([A-Za-z_$][\w$]*):", body))
    for path in js_files():
        if path.endswith("config.js"):
            continue
        src = read(path)
        for m in re.finditer(r"\bCONFIG\.([A-Za-z_$][\w$]*)", src):
            name = m.group(1)
            line = src[: m.start()].count("\n") + 1
            if name not in sections:
                problems.append(
                    f"{rel(path)}:{line}: CONFIG.{name} — no such section in config.js"
                )


def check_keys() -> None:
    src_all = read(os.path.join(ROOT, "js", "config.js"))
    m = re.search(r"export const KEYS = \{(.*?)\n\};", src_all, re.S)
    if not m:
        problems.append("config.js: could not locate KEYS map")
        return
    keys = set(re.findall(r"(?m)^  ([A-Za-z_$][\w$]*):", m.group(1)))
    for path in js_files():
        if path.endswith("config.js"):
            continue
        src = read(path)
        for mm in re.finditer(r"\bKEYS\.([A-Za-z_$][\w$]*)", src):
            name = mm.group(1)
            line = src[: mm.start()].count("\n") + 1
            if name not in keys:
                problems.append(f"{rel(path)}:{line}: KEYS.{name} — not defined in KEYS")


def section_ids(body: str, name: str) -> set[str]:
    m = re.search(rf"\n  {name}: \{{(.*?)\n  \}},", body, re.S)
    if not m:
        return set()
    return set(re.findall(r"(?m)^    ([A-Za-z_$][\w$]*):", m.group(1)))


def check_weapon_slots() -> None:
    body = config_body()
    if not body:
        return
    weapons = section_ids(body, "weapons")
    if not weapons:
        problems.append("config.js: no weapon ids parsed from CONFIG.weapons")
        return
    wp = os.path.join(ROOT, "js", "weapons.js")
    if not os.path.isfile(wp):
        return
    src = read(wp)
    for m in re.finditer(r"this\.slots\s*=\s*\[([^\]]*)\]", src):
        for sid in re.findall(r"['\"]([A-Za-z_$][\w$]*)['\"]", m.group(1)):
            if sid not in weapons:
                problems.append(
                    f"weapons.js: slots includes '{sid}' but CONFIG.weapons has no '{sid}'"
                )


def check_wave_mix() -> None:
    body = config_body()
    if not body:
        return
    enemies = section_ids(body, "enemies")
    if not enemies:
        problems.append("config.js: no enemy ids parsed from CONFIG.enemies")
        return
    wm = re.search(r"mix: \{(.*?)\}", body, re.S)
    mixed = set(re.findall(r"([A-Za-z_$][\w$]*):", wm.group(1))) if wm else set()
    missing = enemies - mixed
    if missing:
        problems.append(f"config.js: waves.mix missing archetypes: {sorted(missing)}")


def main() -> int:
    check_dom_ids()
    check_css_classes()
    check_config_sections()
    check_keys()
    check_weapon_slots()
    check_wave_mix()

    if problems:
        print(f"--- {len(problems)} problem(s) ---")
        for p in sorted(set(problems)):
            print(f"  ERR   {p}")
        return 1
    print("OK: DOM ids, CSS classes, CONFIG/KEYS lookups, weapons and mixes all line up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
