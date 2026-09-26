#!/usr/bin/env python3
"""
validate.py — Static sanity checks for the VOID RUNNER source tree.

Runs without Node. Catches the class of mistakes that are easy to make when
editing many ES modules by hand:

  1. Brace / bracket / paren balance per file.
  2. Unresolved relative imports (file does not exist).
  3. Bare module specifiers (e.g. `from 'three'`) that will fail in a browser
     without an import map.
  4. Identifiers used as `this.X` but never assigned in the constructor or
     declared as a class field — the most common source of runtime
     `undefined` crashes in this codebase.
  5. Duplicate `const`/`let` declarations in the same scope (top level and
     per-function), which is a hard SyntaxError in JS.
  6. Bare reads of instance fields that are only ever assigned as `this.X`
     inside the same class — i.e. a missing `this.`. This is the "wave is not
     defined" class of ReferenceError, and it is invisible to a syntax check.

Usage:  python3 tools/validate.py [root]
Exit code 0 = clean, 1 = problems found.
"""

from __future__ import annotations

import os
import re
import sys
from collections import defaultdict

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")

# Files/dirs we never lint.
SKIP_DIRS = {".venv", "node_modules", ".git", "vendor", "tools"}

# Module specifiers that resolve to a CDN / are globals in a browser.
BARE_OK = set()

problems: list[str] = []
warnings: list[str] = []


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT)


def js_files() -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if f.endswith(".js"):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def strip_comments_and_strings(src: str) -> str:
    """Blank out comments and string/template contents, preserving offsets.

    We keep newlines so line numbers in later checks stay accurate.
    """
    out = list(src)
    i, n = 0, len(src)
    state = None  # None | 'line' | 'block' | "'" | '"' | '`'
    quote_re = re.compile(r"\\(.)", re.S)

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if state is None:
            if c == "/" and nxt == "/":
                state = "line"
                out[i] = out[i + 1] = " "
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                out[i] = out[i + 1] = " "
                i += 2
                continue
            if c in "'\"`":
                state = c
                out[i] = " "
                i += 1
                continue
            i += 1
            continue

        # inside a comment or string
        if state == "line":
            if c == "\n":
                state = None
            else:
                out[i] = " "
            i += 1
            continue

        if state == "block":
            if c == "*" and nxt == "/":
                out[i] = out[i + 1] = " "
                state = None
                i += 2
                continue
            if c != "\n":
                out[i] = " "
            i += 1
            continue

        # string or template literal
        if c == "\\":
            out[i] = " "
            if i + 1 < n and src[i + 1] != "\n":
                out[i + 1] = " "
            i += 2
            continue
        if c == state:
            out[i] = " "
            state = None
            i += 1
            continue
        if c != "\n":
            out[i] = " "
        i += 1

    return "".join(out)


# ----------------------------------------------------------------------
# 1. Bracket balance
# ----------------------------------------------------------------------
def check_balance(path: str, code: str) -> None:
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[tuple[str, int]] = []
    line = 1
    for ch in code:
        if ch == "\n":
            line += 1
        elif ch in "([{":
            stack.append((ch, line))
        elif ch in ")]}":
            if not stack:
                problems.append(f"{rel(path)}:{line}: unmatched closing '{ch}'")
                return
            open_ch, open_line = stack.pop()
            if open_ch != pairs[ch]:
                problems.append(
                    f"{rel(path)}:{line}: '{ch}' closes '{open_ch}' opened at line {open_line}"
                )
                return
    if stack:
        open_ch, open_line = stack[-1]
        problems.append(f"{rel(path)}:{open_line}: unclosed '{open_ch}'")


# ----------------------------------------------------------------------
# 2 & 3. Imports
# ----------------------------------------------------------------------
IMPORT_RE = re.compile(r"""(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]""")
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")


def check_imports(path: str, src: str) -> None:
    base = os.path.dirname(path)
    for m in list(IMPORT_RE.finditer(src)) + list(DYNAMIC_IMPORT_RE.finditer(src)):
        spec = m.group(1)
        line = src[: m.start()].count("\n") + 1
        if spec.startswith("http://") or spec.startswith("https://"):
            warnings.append(f"{rel(path)}:{line}: remote import '{spec}'")
            continue
        if spec in BARE_OK:
            continue
        if not spec.startswith("."):
            problems.append(
                f"{rel(path)}:{line}: bare specifier '{spec}' "
                f"(needs an import map or a relative path)"
            )
            continue
        target = os.path.normpath(os.path.join(base, spec))
        if not os.path.isfile(target):
            problems.append(f"{rel(path)}:{line}: unresolved import '{spec}'")


# ----------------------------------------------------------------------
# 4. this.X assigned?
# ----------------------------------------------------------------------
THIS_READ_RE = re.compile(r"\bthis\.([A-Za-z_$][\w$]*)")
# Assignments: this.x = ..., this.x += ..., this.x ??=, and class fields "x ="
THIS_WRITE_RE = re.compile(r"\bthis\.([A-Za-z_$][\w$]*)\s*(?:[+\-*/%&|^]?=|\?\?=|\?\.)")
# Object-literal-ish or external writes we should not flag:
#   this.foo.bar = ...  (handled by the regex above but foo is a real field)
KNOWN_EXTERNAL = {
    # written by Game / other modules onto these objects
    "onDamage", "onDeath", "onLand", "onStep", "onDash", "onMelee",
    "onFire", "onReloadStart", "onReloadEnd", "onAmmoChange", "onSwitch",
    "onEmptyClick", "onCharge", "onKill", "onWaveStart", "onWaveClear",
    "onVictory", "onCollect", "onShoot",
}


def check_this_fields(path: str, code: str) -> None:
    assigned: set[str] = set()
    for m in THIS_WRITE_RE.finditer(code):
        assigned.add(m.group(1))
    # Class field declarations:  ^\s{2,}(name)\s*=
    for m in re.finditer(r"(?m)^\s{2,}([A-Za-z_$][\w$]*)\s*=", code):
        assigned.add(m.group(1))
    # Bracket access: this['x']
    for m in re.finditer(r"\bthis\[['\"]([A-Za-z_$][\w$]*)['\"]\]", code):
        assigned.add(m.group(1))
    # Class methods and getters: `name(...) {` / `get name() {`
    for m in re.finditer(r"(?m)^\s{2,}(?:static\s+|get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(", code):
        assigned.add(m.group(1))
    for m in re.finditer(r"(?m)^\s{2,}(?:static\s+)?(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(", code):
        assigned.add(m.group(1))

    read: dict[str, int] = {}
    for m in THIS_READ_RE.finditer(code):
        read.setdefault(m.group(1), code[: m.start()].count("\n") + 1)

    missing = {
        k: v for k, v in read.items()
        if k not in assigned and k not in KNOWN_EXTERNAL
    }
    for name, line in sorted(missing.items(), key=lambda kv: kv[1]):
        warnings.append(
            f"{rel(path)}:{line}: 'this.{name}' read but never assigned in this file"
        )


# ----------------------------------------------------------------------
# 5b. Methods called on `this` that are never defined
# ----------------------------------------------------------------------
# Conservative: only flag snake_case / camelCase names that look like our own
# API (start with _ or are plain identifiers) and are not inherited.
def check_missing_methods(path: str, code: str) -> None:
    defined: set[str] = set()
    for m in re.finditer(r"(?m)^\s{2,}(?:static\s+|get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(", code):
        defined.add(m.group(1))
    for m in THIS_WRITE_RE.finditer(code):
        defined.add(m.group(1))

    called: dict[str, int] = {}
    for m in re.finditer(r"\bthis\.([A-Za-z_$][\w$]*)\s*\(", code):
        called.setdefault(m.group(1), code[: m.start()].count("\n") + 1)

    for name, line in sorted(called.items(), key=lambda kv: kv[1]):
        if name in defined or name in KNOWN_EXTERNAL:
            continue
        warnings.append(
            f"{rel(path)}:{line}: this.{name}() called but not defined in this class"
        )


# ----------------------------------------------------------------------
# 5. Duplicate lexical declarations in the same scope
# ----------------------------------------------------------------------
def check_duplicate_decls(path: str, code: str) -> None:
    # Top-level (column 0 indentation) const/let only — that is where a
    # duplicate is a guaranteed SyntaxError and cheap to detect.
    seen: dict[str, int] = {}
    for m in re.finditer(r"(?m)^(?:const|let)\s+([A-Za-z_$][\w$]*)", code):
        name, line = m.group(1), code[: m.start()].count("\n") + 1
        if name in seen:
            problems.append(
                f"{rel(path)}:{line}: duplicate top-level declaration "
                f"'{name}' (first at line {seen[name]})"
            )
        else:
            seen[name] = line

    # Duplicate params in one function signature.
    for m in re.finditer(r"function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)", code):
        params = [p.strip().split("=")[0].strip() for p in m.group(2).split(",") if p.strip()]
        dupes = {p for p in params if params.count(p) > 1}
        for d in sorted(dupes):
            line = code[: m.start()].count("\n") + 1
            problems.append(f"{rel(path)}:{line}: duplicate parameter '{d}' in {m.group(1)}()")


# Module-level names that are legitimately in scope without `this.`
MODULE_NAMES = {"CONFIG", "KEYS", "THREE", "audio", "clamp", "rand", "randInt",
                "pick", "damp", "lerp", "sign", "pulse", "ringPoint",
                "weightedPick", "fmt", "makeCanvas", "angleDelta",
                "ENEMY_TYPES", "buildModel", "audio", "window", "document",
                "console", "Math", "JSON", "Object", "Array", "Set", "Map",
                "Promise", "Number", "String", "Boolean", "Infinity", "NaN",
                "undefined", "requestAnimationFrame", "performance", "Float32Array",
                "Uint8Array", "Int32Array", "Symbol", "Error", "isRegexp"}


def _strip_js_noise(code: str) -> str:
    """Blank out comments and string/template literals, preserving offsets.

    Replacing with same-length filler keeps every index valid so reported
    line numbers still line up with the real file.
    """
    out = list(code)
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c == "/" and i + 1 < n and code[i + 1] == "/":
            while i < n and code[i] != "\n":
                out[i] = " "
                i += 1
        elif c == "/" and i + 1 < n and code[i + 1] == "*":
            while i < n and not (code[i] == "*" and i + 1 < n and code[i + 1] == "/"):
                if code[i] != "\n":
                    out[i] = " "
                i += 1
            for _ in range(2):
                if i < n:
                    out[i] = " "
                    i += 1
        elif c in "\"'`":
            quote = c
            out[i] = " "
            i += 1
            while i < n and code[i] != quote:
                if code[i] == "\\":
                    out[i] = " "
                    i += 1
                if i < n:
                    if code[i] != "\n":
                        out[i] = " "
                    i += 1
            if i < n:
                out[i] = " "
                i += 1
        else:
            i += 1
    return "".join(out)


# An identifier read: not preceded by `.` (member access), and not part of a
# longer word. The lookbehind also rejects `this.x` because of the `s.`.
_BARE_READ = r"(?<![\w.$]){name}\b"


def check_bare_field_reads(path: str, code: str) -> None:
    """Flag `foo` used bare when the class only ever writes `this.foo`.

    This catches the "wave is not defined" class of ReferenceError, which a
    pure syntax check cannot see: the file parses fine, and the failure only
    happens at runtime, every frame, from inside requestAnimationFrame.

    Per class body we collect the field names written via `this.`, subtract
    everything that is genuinely in scope (module names, locals, parameters,
    methods, the class name itself), then flag any remaining bare read.
    """
    code = _strip_js_noise(code)
    # Everything declared at module scope (functions, consts, classes,
    # imports) is legitimately in scope inside any class in the same file.
    module_decls: set[str] = set()
    for mm in re.finditer(
        r"(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", code
    ):
        module_decls.add(mm.group(1))
    for mm in re.finditer(
        r"(?m)^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)", code
    ):
        module_decls.add(mm.group(1))
    for mm in re.finditer(
        r"(?m)^\s*import\s+[^;]*?([A-Za-z_$][\w$]*)\s*(?:,|from|$)", code
    ):
        module_decls.add(mm.group(1))

    cls_re = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")
    for m in cls_re.finditer(code):
        name = m.group(1)
        start = m.end()
        end = code.find("\n}", start)
        body = code[start:end if end != -1 else len(code)]

        # Fields written as this.foo, and methods defined on the class.
        fields = set(THIS_WRITE_RE.findall(body))
        methods = set(
            mm.group(1)
            for mm in re.finditer(
                r"(?m)^\s{2,}(?:static\s+|get\s+|set\s+|async\s+)*"
                r"([A-Za-z_$][\w$]*)\s*\(", body
            )
        )
        if not fields:
            continue

        # Names genuinely in scope inside this class body. Note: `fields` is
        # deliberately NOT in scope here — an instance field can only ever be
        # reached through `this.`, which is precisely what we are testing.
        in_scope: set[str] = set(MODULE_NAMES) | methods | {name} | module_decls
        # A name that is also a module-level declaration was flagged elsewhere
        # in this file; keep it in scope so we do not double-report.
        for mm in re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)", body):
            in_scope.add(mm.group(1))
        # Function/method parameters, incl. destructured and defaulted.
        for mm in re.finditer(r"\(([^()]*)\)\s*\{", body):
            for p in mm.group(1).split(","):
                p = p.strip().split("=")[0].strip().lstrip(".")
                for part in re.split(r"[\s:\[\]{}]+", p):
                    if part:
                        in_scope.add(part)
        # catch (e) and for (const x of ...) binding names.
        for mm in re.finditer(r"\bcatch\s*\(\s*([A-Za-z_$][\w$]*)", body):
            in_scope.add(mm.group(1))

        suspects = fields - in_scope
        if not suspects:
            continue

        for s in sorted(suspects):
            for mm in re.finditer(_BARE_READ.format(name=re.escape(s)), body):
                tail = body[mm.end():mm.end() + 16]
                # `foo:` is an object/class key or a label, not a read.
                # `foo =` is a declaration or assignment.
                if re.match(r"\s*[:=]", tail):
                    continue
                line = code[: start + mm.start()].count("\n") + 1
                problems.append(
                    f"{rel(path)}:{line}: class {name}: bare '{s}' read — "
                    f"did you mean 'this.{s}'? ('{s}' is only ever assigned "
                    f"as this.{s}, so this throws ReferenceError at runtime)"
                )
                break


# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------
def main() -> int:
    files = js_files()
    if not files:
        print("no .js files found", file=sys.stderr)
        return 1

    for path in files:
        with open(path, "r", encoding="utf-8") as fh:
            src = fh.read()
        code = strip_comments_and_strings(src)

        check_balance(path, code)
        check_imports(path, src)
        check_this_fields(path, code)
        check_missing_methods(path, code)
        check_duplicate_decls(path, code)
        check_bare_field_reads(path, code)

    print(f"checked {len(files)} files under {ROOT}\n")

    if warnings:
        print(f"--- {len(warnings)} warning(s) ---")
        for w in warnings:
            print(f"  warn  {w}")
        print()

    if problems:
        print(f"--- {len(problems)} problem(s) ---")
        for p in problems:
            print(f"  ERR   {p}")
        return 1

    print("OK: no structural problems found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
