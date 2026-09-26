#!/usr/bin/env python3
"""
api_check.py — Cross-module API consistency check.

The static validator catches syntax and import problems, but it cannot tell
that `main.js` calls `hud.setCharge()` when `hud.js` only defines
`setBuffs()`. Those are runtime `TypeError`s that only show up in a browser.

This walks the source, collects:
  * methods defined on each class (and on the exported singleton objects)
  * every `<obj>.<method>(` call site in other modules

and reports calls whose target method is never defined anywhere.

Usage:  python3 tools/api_check.py [root]
"""

from __future__ import annotations

import os
import re
import sys
from collections import defaultdict

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
SKIP_DIRS = {".venv", "node_modules", ".git", "vendor", "tools"}

# Instance names created in main.js / other modules -> the class they hold.
# Derived from `new Foo(...)` assignments, so it stays accurate as code moves.
NEW_RE = re.compile(r"\bthis\.([A-Za-z_$][\w$]*)\s*=\s*new\s+((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)")

problems: list[str] = []


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def js_files() -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        out += [os.path.join(dirpath, f) for f in filenames if f.endswith(".js")]
    return sorted(out)


def strip(src: str) -> str:
    """Remove comments and string bodies (same approach as validate.py)."""
    out = list(src)
    i, n, state = 0, len(src), None
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if state is None:
            if c == "/" and nxt == "/":
                state, out[i], out[i + 1] = "line", " ", " "
                i += 2
                continue
            if c == "/" and nxt == "*":
                state, out[i], out[i + 1] = "block", " ", " "
                i += 2
                continue
            if c in "'\"`":
                state, out[i] = c, " "
                i += 1
                continue
            i += 1
            continue
        if state == "line":
            out[i] = "\n" if c == "\n" else " "
            if c == "\n":
                state = None
            i += 1
            continue
        if state == "block":
            if c == "*" and nxt == "/":
                out[i] = out[i + 1] = " "
                state = None
                i += 2
                continue
            out[i] = "\n" if c == "\n" else " "
            i += 1
            continue
        if c == "\\":
            out[i] = " "
            if i + 1 < n and src[i + 1] != "\n":
                out[i + 1] = " "
            i += 2
            continue
        if c == state:
            out[i], state = " ", None
            i += 1
            continue
        out[i] = "\n" if c == "\n" else " "
        i += 1
    return "".join(out)


# Methods deliberately provided by a base class or assigned from elsewhere.
INHERITED = {
    # Three.js base classes
    "renderToScreen", "setSize", "dispose", "clone", "copy", "toJSON",
    # our own cross-object callbacks assigned as fields
    "onDamage", "onDeath", "onLand", "onStep", "onDash", "onMelee",
    "onFire", "onReloadStart", "onReloadEnd", "onAmmoChange", "onSwitch",
    "onEmptyClick", "onCharge", "onKill", "onWaveStart", "onWaveClear",
    "onVictory", "onCollect", "onShoot",
}

# Instance properties that hold a foreign (library / browser API) object.
# Their methods are not ours to verify, and their class names are meaningless
# (`THREE.Scene`, `AC`, ...), so skip them entirely.
FOREIGN_OWNERS = {
    "ctx",            # AudioContext
    "scene",          # THREE.Scene
    "camera",         # THREE.Camera
    "renderer",       # THREE.WebGLRenderer
    "composer",       # EffectComposer
    "bloom",          # UnrealBloomPass
    "grade",          # ShaderPass
    "output",         # OutputPass
    "vmPass",         # custom Pass
    "renderPass",     # RenderPass
    "raycaster",      # THREE.Raycaster
    "this",           # never
}

# Any field whose value is a THREE math object (Vector3, Euler, Color, ...).
# `new THREE.Vector3()` gives the naive regex the class name "THREE", which is
# meaningless, so treat all THREE.* constructions as foreign.
THREE_CLASSES = re.compile(r"^THREE\.")

# Built-in containers: their methods are standard JS, not ours.
BUILTIN_CLASSES = {"Set", "Map", "Array", "WeakMap", "WeakSet"}


def collect_methods() -> dict[str, set[str]]:
    """className -> {method names}"""
    methods: dict[str, set[str]] = defaultdict(set)

    # Track which class we are inside by brace depth.
    for path in js_files():
        with open(path, encoding="utf-8") as fh:
            code = strip(fh.read())

        cls_re = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")
        meth_re = re.compile(r"^\s{2,}(?:static\s+|get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(", re.M)

        # Simple approach: for each class, take the slice of code from the
        # class declaration to the matching close brace at column 0.
        for m in cls_re.finditer(code):
            name = m.group(1)
            start = m.end()
            # Class bodies in this codebase end with "\n}" at col 0.
            end = code.find("\n}", start)
            body = code[start: end if end != -1 else len(code)]
            for mm in meth_re.finditer(body):
                methods[name].add(mm.group(1))

        # Plain object singletons (e.g. `export const audio = new AudioEngine()`)
        # are covered by the class scan; also add module-level function
        # exports so `import { foo }` call sites resolve.
        for mm in re.finditer(
            r"^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", code, re.M
        ):
            methods["<module>"].add(mm.group(1))
        for mm in re.finditer(
            r"^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)", code, re.M
        ):
            methods["<module>"].add(mm.group(1))

    return methods


def main() -> int:
    files = js_files()
    methods = collect_methods()
    all_methods: set[str] = set()
    for s in methods.values():
        all_methods |= s
    all_methods |= INHERITED

    # Map instance property -> class, across the whole tree.
    # A property assigned a plain array/Set literal is a built-in container:
    # record that so its .push()/.add() calls are not checked against a class.
    inst_class: dict[str, str] = {}
    ARRAY_FIELD_RE = re.compile(r"\bthis\.([A-Za-z_$][\w$]*)\s*=\s*(\[\]|new Set\(|new Map\()")
    for path in files:
        with open(path, encoding="utf-8") as fh:
            code = strip(fh.read())
        for m in ARRAY_FIELD_RE.finditer(code):
            inst_class[m.group(1)] = "<builtin>"
        for m in NEW_RE.finditer(code):
            name, cls = m.group(1), m.group(2)
            if inst_class.get(name) == "<builtin>":
                continue
            # Skip foreign objects and namespace constructors.
            if name in FOREIGN_OWNERS:
                continue
            if THREE_CLASSES.match(cls) or cls in BUILTIN_CLASSES:
                continue
            if cls in {"AC", "AudioContext"}:
                continue
            inst_class[name] = cls

    checked = 0
    for path in files:
        with open(path, encoding="utf-8") as fh:
            code = strip(fh.read())

        for m in re.finditer(r"\bthis\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(", code):
            obj, meth = m.group(1), m.group(2)
            line = code[: m.start()].count("\n") + 1
            if obj in FOREIGN_OWNERS:
                continue
            cls = inst_class.get(obj)

            if cls is None or cls == "<builtin>":
                # Unknown object (DOM element) or a built-in container
                # (Array/Set/Map) — their methods are standard JS.
                continue
            if meth in methods.get(cls, set()) or meth in all_methods:
                checked += 1
                continue
            problems.append(
                f"{rel(path)}:{line}: this.{obj}.{meth}() — "
                f"'{cls}' has no method '{meth}'"
            )

    print(f"checked {checked} verified call sites across {len(files)} files\n")
    if problems:
        print(f"--- {len(problems)} problem(s) ---")
        for p in sorted(set(problems)):
            print(f"  ERR   {p}")
        return 1
    print("OK: every cross-module call resolves to a defined method.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
