#!/usr/bin/env python3
"""
serve.py — Development static server for VOID RUNNER.

`python3 -m http.server` sends no cache-control headers at all, so the
browser is free to reuse previously fetched ES modules. That produces a
failure mode that is genuinely hard to debug: you edit weapons.js, reload,
and the browser runs your NEW weapons.js against the OLD config.js, so you
get a confusing `Cannot read properties of undefined` on a config key that
plainly exists in the file on disk. This has happened more than once in
this project and cost real debugging time both times.

This server sends `Cache-Control: no-store` on every response, so a reload
always picks up the current tree and the modules can never be out of sync
with each other.

Usage:
    python3 tools/serve.py [port]     # default 8080

ES modules will not load over file://, so a server is required. The game
itself needs no build step — Three.js is vendored in ./vendor.
"""

from __future__ import annotations

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """Static handler that forbids caching of any kind."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # Never let a stale bundle linger after an edit.
        self.send_header("ETag", "")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Quieter than the default: only surface non-200 responses, which are
        # the ones that actually matter while iterating.
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith("4") or status.startswith("5"):
            sys.stderr.write(f"  ! {status} {args[0] if args else ''}\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with Server(("127.0.0.1", PORT), handler) as httpd:
        print()
        print("  VOID RUNNER  (dev server, caching disabled)")
        print("  " + "-" * 40)
        print(f"  http://localhost:{PORT}")
        print("  Ctrl+C to stop.")
        print()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.\n")
            sys.exit(0)


if __name__ == "__main__":
    main()
