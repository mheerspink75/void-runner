/**
 * cdp.mjs — Minimal Chrome DevTools Protocol client. No npm dependencies.
 *
 * Uses Node's built-in global WebSocket and fetch (Node 22+), so there is
 * nothing to install and no lockfile to drift. The game itself still needs no
 * Node at runtime; this is test-time only.
 *
 * Used by tools/browser_smoke.mjs. Deliberately small: launch a browser, open a
 * tab, evaluate expressions in the page, collect console output, screenshot,
 * tear down.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Candidate Chrome/Chromium binaries, in preference order. */
const CHROME_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
};

export function findChrome() {
  if (process.env.CHROME_PATH) {
    // An explicit override that does not exist is a configuration error worth
    // reporting, not something to silently fall back from.
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }
  for (const p of CHROME_CANDIDATES[process.platform] || []) {
    if (existsSync(p)) return p;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if something is already listening on the port. */
async function portInUse(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Launch a headless browser with a CDP port and return a handle.
 *
 * The browser gets its own throwaway profile so an existing Chrome is never
 * touched — no shared session, no tabs, no cookies.
 */
export async function launchBrowser({
  ports = [9222, 9333, 9411, 9555, 9711],
  timeoutMs = 30000,
  extraArgs = [],
} = {}) {
  const bin = findChrome();
  if (!bin) {
    return { ok: false, reason: "no Chrome/Chromium binary found (set CHROME_PATH)" };
  }

  for (const port of ports) {
    // A browser already on this port would answer /json/version, and we would
    // then be driving someone else's browser while orphaning our own child.
    if (await portInUse(port)) continue;

    const profile = mkdtempSync(join(tmpdir(), "void-smoke-"));
    const args = [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-defaults",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--window-size=1280,720",
      // Software GL. Chrome prefers a real GPU when present and falls back to
      // SwiftShader otherwise, so CI runners without one still get WebGL.
      "--enable-unsafe-swiftshader",
      ...extraArgs,
      "about:blank",
    ];

    let child;
    let spawnError = null;
    try {
      child = spawn(bin, args, { stdio: "ignore", detached: false });
      // spawn() does not throw for a missing or unlaunchable binary; it emits
      // 'error' asynchronously. Without this the failure surfaces as an
      // unhandled 'error' event and kills the process, which is a crash rather
      // than the clean "no browser here" skip the caller expects.
      child.on("error", (e) => {
        spawnError = e;
      });
    } catch (e) {
      rmSync(profile, { recursive: true, force: true });
      return { ok: false, reason: `could not spawn ${bin}: ${e.message}` };
    }

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      if (spawnError) break;
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const version = await r.json();
          return {
            ok: true,
            bin,
            port,
            base,
            version,
            async kill() {
              try {
                child.kill();
              } catch {
                /* already gone */
              }
              // Wait for exit so Chrome releases its profile lock, then remove
              // the directory. Both steps are best-effort: a leftover temp
              // profile must never turn a passing test into a failing one.
              for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
              try {
                rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
              } catch {
                /* temp dir will be collected by the OS */
              }
            },
          };
        }
      } catch {
        /* not up yet */
      }
    }

    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (spawnError) {
      return { ok: false, reason: `could not launch ${bin}: ${spawnError.message}` };
    }
  }
  const tried = ports.join(", ");
  return { ok: false, reason: `could not start a browser on any port (${tried})` };
}

/** Open a tab. Modern Chrome requires PUT for /json/new. */
export async function newTab(base, url = "about:blank") {
  const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`/json/new returned HTTP ${r.status}`);
  return r.json();
}

export async function closeTab(base, id) {
  try {
    await fetch(`${base}/json/close/${id}`);
  } catch {
    /* best effort */
  }
}

/** A flat CDP session against a single page target. */
export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.console = [];
    this.errors = [];
    this.failures = [];
    ws.addEventListener("message", (ev) => this._onMessage(ev.data));
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    });
    return new Session(ws);
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const h of this.handlers.get(msg.method) || []) h(msg.params);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }

  /**
   * Evaluate a function body in the page and return its value.
   * The body is wrapped in an IIFE, so `return` works as expected.
   */
  async eval(body) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "page threw");
    }
    return r.result.value;
  }

  /**
   * Record console output, uncaught exceptions and network failures.
   * `errors` is what the smoke test asserts on.
   */
  captureDiagnostics() {
    const push = (level, text) => {
      this.console.push({ level, text });
      if (level === "error") this.errors.push(text);
    };
    this.on("Runtime.consoleAPICalled", (p) => {
      push(
        p.type,
        (p.args || [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type)
          .join(" ")
      );
    });
    this.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails;
      push("error", d.exception?.description || d.text || "uncaught exception");
    });
    this.on("Log.entryAdded", (p) => {
      // `network` covers the 404s that break a module graph import.
      if (p.entry.level === "error" || p.entry.source === "network") {
        push("error", `${p.entry.source}: ${p.entry.text}`);
      } else {
        push(p.entry.level, p.entry.text);
      }
    });
  }

  async screenshot() {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(r.data, "base64");
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export { sleep };
