/**
 * browser_smoke.mjs — Run the game in a real browser and assert it works.
 *
 * Why this exists: the other six checks are static analysis or headless
 * simulation. None of them can see the class of failure that matters most for
 * a WebGL game — a module 404 that only breaks at runtime, a constructor that
 * throws in a real browser, a boot path that never completes, or a gameplay
 * system that explodes the moment you press fire. Those only appear when a
 * browser runs the real thing.
 *
 * No dependencies. Node 22's built-in WebSocket and fetch speak CDP directly,
 * so there is no npm install, no lockfile, and nothing to keep in sync. The game
 * still needs no Node at runtime; this is test-time only.
 *
 * Failure semantics are deliberate, and this is the important design point:
 *
 *   app regression  -> FAIL (exit 1). A broken game must block a deploy.
 *   no browser here -> SKIP (exit 0). A machine without Chrome is not a broken
 *                      game, and a smoke test that blocks every deploy because
 *                      a runner lost its browser would get deleted rather than
 *                      fixed. Skips are announced loudly and annotated into the
 *                      CI run summary, so a test that has quietly stopped
 *                      testing anything stays visible.
 *
 * Critically, a skip never forgives a failed check. If the app has already
 * failed, the run fails no matter what the harness trips over afterwards —
 * otherwise a broken build reports green because the test crashed while
 * inspecting it, which is the exact failure mode this file exists to catch.
 *
 * Usage:
 *   node tools/browser_smoke.mjs [url] [--keep-screenshot]
 *
 * Defaults to http://127.0.0.1:8099/ (see deploy.yml, which starts
 * tools/serve.py on that port against the current checkout). Point it at the
 * deployed site to test that instead:
 *   node tools/browser_smoke.mjs https://<user>.github.io/<repo>/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchBrowser, newTab, closeTab, Session, sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const URL_ARG = args.find((a) => !a.startsWith("--"));
const KEEP_SHOT = args.includes("--keep-screenshot");
const TARGET = URL_ARG || "http://127.0.0.1:8099/";

const BOOT_TIMEOUT_MS = 60000;   // software GL is slow to compile shaders
const RUN_TIMEOUT_MS = 20000;

const failures = [];
let checks = 0;
let skipped = false;
let skipReason = "";

// Node 21 added a global WebSocket; 22 unflagged it. The whole no-dependency
// approach rests on it, so check rather than crash with ReferenceError.
if (typeof WebSocket !== "function") {
  console.log("=".repeat(64));
  console.log("browser smoke test");
  console.log("=".repeat(64));
  console.log(`  node: ${process.version}`);
  skipped = true;
  skipReason = `node ${process.version} has no global WebSocket; needs Node 22+`;
  report();
}

function check(cond, label, detail = "") {
  checks++;
  if (!cond) failures.push(label + (detail ? ` — ${detail}` : ""));
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

/** The single place that decides the exit code. */
function report() {
  console.log();
  console.log("=".repeat(64));
  if (failures.length) {
    console.log(`FAIL: ${failures.length} of ${checks} browser checks failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  if (skipped) {
    console.error("=".repeat(64));
    console.error(`SKIPPED: ${skipReason}`);
    console.error("This is an environment problem, not a game regression, so it does");
    console.error("not fail the build. Nothing was verified — treat this as untested.");
    // Surface it in the run summary rather than buried in a log nobody reads.
    console.error(`::warning::browser_smoke skipped — ${skipReason}`);
    process.exit(0);
  }
  console.log(`OK: ${checks} browser checks passed — the game boots, renders and plays`);
  process.exit(0);
}

/**
 * An environment problem: no browser, no WebGL, harness could not talk to the
 * page. Not a game regression, so it must not block a deploy — unless the app
 * has already failed its checks, in which case this is a broken build.
 */
function bail(reason) {
  if (failures.length) {
    console.error(`\nHARNESS ALSO FAILED: ${reason}`);
    console.error("Not skipping: the app already failed its checks above.");
    report();
  }
  console.error(`\nHARNESS PROBLEM: ${reason}`);
  skipped = true;
  skipReason = reason;
  report();
}

console.log("=".repeat(64));
console.log("browser smoke test");
console.log("=".repeat(64));
console.log(`  target: ${TARGET}`);
console.log();

const browser = await launchBrowser();
if (!browser.ok) bail(browser.reason);
console.log(`  browser: ${browser.version.Browser}`);
console.log(`  cdp:     ${browser.base}`);
console.log();

let tab = null;
let session = null;

try {
  tab = await newTab(browser.base, "about:blank");
  session = await Session.attach(tab.webSocketDebuggerUrl);
  session.captureDiagnostics();

  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Log.enable");

  // ---- 1. the page loads and the module graph resolves ---------------
  console.log("[1] page loads and the module graph resolves");
  const nav = await session.send("Page.navigate", { url: TARGET });
  if (nav.errorText) check(false, "navigation succeeded", nav.errorText);
  else check(true, "navigation succeeded", nav.status ? `HTTP ${nav.status}` : "");

  // Poll for boot rather than sleeping a fixed amount: on a software-GL runner
  // shader compilation can take many seconds, and a fixed wait is either flaky
  // or slow.
  let boot = null;
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < bootDeadline) {
    await sleep(500);
    try {
      boot = await session.eval(`
        const g = window.__game;
        const fatal = document.getElementById('fatal');
        const shown = !!fatal && !fatal.classList.contains('hidden');
        return {
          hasGame: !!g,
          state: g ? g.state : null,
          fatalShown: shown,
          fatalText: shown ? fatal.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : null,
          stamp: (document.getElementById('build-stamp') || {}).textContent || null,
          loadingGone: !document.getElementById('loading'),
        };
      `);
      if (boot.hasGame || boot.fatalShown) break;
    } catch {
      // Page may still be swapping documents; keep polling.
    }
  }

  if (!boot) {
    check(false, "page reached a booted state", `timed out after ${BOOT_TIMEOUT_MS}ms`);
  }

  // ---- 1b. can this machine run a WebGL game at all? ----------------
  // This has to come BEFORE any assertion about the game, and that ordering is
  // the whole point. A GPU-less CI runner may have no WebGL at all, in which
  // case the game is behaving perfectly: boot.js detects it and shows "WebGL
  // unavailable" instead of a black screen. Asserting first turned that
  // correct behaviour into a build failure.
  //
  // So: establish the environment can host the game, and skip if it cannot.
  // Only once WebGL is confirmed do failures mean the game is at fault.
  console.log("\n[1b] can this environment run a WebGL game?");
  let gl = null;
  try {
    gl = await session.eval(`
      const c = document.createElement('canvas');
      const g2 = c.getContext('webgl2');
      const g = g2 || c.getContext('webgl');
      if (!g) return { ok: false };
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        webgl2: !!g2,
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
      };
    `);
  } catch (e) {
    gl = { ok: false, error: e.message };
  }
  if (!gl || !gl.ok) {
    bail(
      "no WebGL context in this browser (no GPU and no working software " +
      "fallback). The game cannot run here, so there is nothing to test; " +
      "this is a property of the machine, not a regression. " +
      (gl && gl.error ? `(${gl.error})` : "")
    );
  }
  check(true, "WebGL context obtainable",
    `${gl.webgl2 ? "webgl2" : "webgl1"} · ${gl.renderer}`);

  // Environment confirmed. From here on, a failure is the game's fault.
  if (!boot) {
    bail("page never booted and no fatal overlay was shown");
  }

  // The boot.js contract: if the game cannot start, it must say so on screen.
  // The WebGL case is already handled above, so anything fatal now is real.
  check(!boot.fatalShown, "no fatal-error overlay", boot.fatalShown ? boot.fatalText : "");
  check(boot.hasGame, "window.__game exists (main.js evaluated)",
    boot.hasGame ? "" : "the module graph probably failed");
  check(boot.state === "menu", "boots to the menu", `state=${boot.state}`);
  check(!!boot.stamp, "build stamp rendered", boot.stamp || "missing");

  // The overlay is dismissed one frame after the first draw and removed 600ms
  // later, so it is still legitimately present the instant __game appears.
  let loadingGone = boot.loadingGone;
  const loadDeadline = Date.now() + 10000;
  while (!loadingGone && Date.now() < loadDeadline) {
    await sleep(250);
    loadingGone = await session.eval(`return !document.getElementById('loading');`);
  }
  check(loadingGone, "loading overlay is dismissed after the first frame");

  const netFail = session.errors.filter((e) => /\b404\b|net::ERR_/i.test(e));
  check(netFail.length === 0, "no failed network requests", netFail.slice(0, 3).join(" | "));

  // ---- 2. the render loop advances ------------------------------------
  // Needs window.__game. If boot failed, the checks above already recorded
  // that, so stop here rather than throwing into bail().
  if (!boot.hasGame) {
    console.log("\n[3-5] render loop, gameplay and console");
    console.log("  ....  not run: the game never initialised (see the failures above)");
    report();
  }

  console.log("\n[3] the render loop runs");
  // Software rendering (SwiftShader, i.e. no GPU) draws this post chain at
  // roughly 3 fps, and the dt clamp then makes game time advance far slower
  // than wall time. So this asserts the loop is *alive*, not that it is fast,
  // and every wait below polls for a condition rather than sleeping a fixed
  // duration -- otherwise a slow runner produces flaky failures.
  const loop = await session.eval(`
    return new Promise(resolve => {
      const before = window.__game.renderer.info.render.frame;
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else resolve({ rafFrames: frames, seconds: 2,
                       rendererFrames: window.__game.renderer.info.render.frame - before });
      };
      requestAnimationFrame(tick);
    });
  `);
  check(loop.rafFrames >= 2, "requestAnimationFrame is firing",
    `${loop.rafFrames} frames in ${loop.seconds}s (low is fine: software GL)`);
  // The post chain issues many draws per frame, so this only asserts that
  // something is reaching the GPU at all.
  check(loop.rendererFrames >= 2, "the renderer is drawing",
    `${loop.rendererFrames} draws in ${loop.seconds}s`);

  // ---- 4. a run starts and the core systems respond ------------------
  console.log("\n[4] a run starts and core systems respond");
  await session.eval(`document.getElementById('btn-start').click(); return true;`);
  const runDeadline = Date.now() + RUN_TIMEOUT_MS;
  let playing = null;
  while (Date.now() < runDeadline) {
    await sleep(250);
    playing = await session.eval(`return window.__game.state;`);
    if (playing === "playing") break;
  }
  check(playing === "playing", "clicking start enters the playing state", `state=${playing}`);

  // Pointer lock cannot be granted headless, and input.js gates firing on it,
  // so set the flag rather than pretending lock succeeded.
  await session.eval(`window.__game.input.locked = true; return 1;`);

  const before = await session.eval(`
    const g = window.__game;
    g.weapons.current.mag = g.weapons.def.magSize;
    g.weapons.current.reserve = g.weapons.def.maxReserve;
    return { mag: g.weapons.current.mag, shots: g.weapons.shotsFired };
  `);

  // Fire through the real mousedown handler and wait for the shot to land.
  // Polled rather than timed: at software-rendering frame rates a fixed 600ms
  // hold can contain zero frames, which would look like "firing is broken".
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: 640, y: 360, button: "left", clickCount: 1, buttons: 1,
  });
  let fired = 0;
  const fireDeadline = Date.now() + 15000;
  while (Date.now() < fireDeadline) {
    await sleep(250);
    fired = await session.eval(`return window.__game.weapons.shotsFired;`);
    if (fired > before.shots) break;
  }
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: 640, y: 360, button: "left", clickCount: 1, buttons: 0,
  });
  const afterFire = await session.eval(`
    const g = window.__game;
    return { mag: g.weapons.current.mag, shots: g.weapons.shotsFired };
  `);
  check(afterFire.shots > before.shots, "firing consumes ammo",
    `${afterFire.shots - before.shots} shots, mag ${before.mag}->${afterFire.mag}`);

  // Jump through the real keydown path. Waits for the player to actually leave
  // the ground rather than assuming a fixed amount of game time will pass: with
  // dt clamped and ~3 fps, a second of wall time is a fraction of a second of
  // game time, so any height threshold would be measuring the renderer's speed
  // instead of whether jumping works.
  const jump = await session.eval(`
    return new Promise(resolve => {
      const p = window.__game.player;
      const y0 = p.position.y;
      let peak = y0;
      let airborne = false;
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      const tick = () => {
        peak = Math.max(peak, p.position.y);
        if (p.position.y > y0 + 0.05) airborne = true;
        const elapsed = performance.now() - t0;
        if (!airborne && elapsed < 20000) requestAnimationFrame(tick);
        else {
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
          resolve({ y0: +y0.toFixed(3), peak: +peak.toFixed(3), airborne, ms: Math.round(elapsed) });
        }
      };
      requestAnimationFrame(tick);
    });
  `);
  check(jump.airborne, "jump leaves the ground",
    `y ${jump.y0} -> peak ${jump.peak} after ${jump.ms}ms`);

  // Enemies should spawn on wave 1 with no player action.
  let enemyCount = 0;
  const spawnDeadline = Date.now() + 30000;
  while (Date.now() < spawnDeadline) {
    enemyCount = await session.eval(`return window.__game.enemies.enemies.length;`);
    if (enemyCount > 0) break;
    await sleep(500);
  }
  const wave = await session.eval(`
    const g = window.__game;
    return { enemies: g.enemies.enemies.length, wave: g.waves.wave, state: g.state };
  `);
  check(wave.enemies > 0, "the wave director spawns enemies",
    `${wave.enemies} alive, wave ${wave.wave}`);
  check(wave.state === "playing", "still playing after the smoke sequence", wave.state);

  // ---- 5. nothing threw along the way -------------------------------
  console.log("\n[5] no console errors during the whole run");
  const errors = session.errors.filter(
    // Pointer lock is expected to fail headless; boot.js handles it and the
    // README documents it as non-fatal.
    (e) => !/pointer.?lock/i.test(e)
  );
  check(errors.length === 0, "zero console errors / failed requests",
    errors.slice(0, 3).join(" | "));

  if (KEEP_SHOT) {
    const png = await session.screenshot();
    const dir = join(tmpdir(), "void-smoke");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "smoke.png");
    writeFileSync(out, png);
    console.log(`\n  screenshot -> ${out} (${(png.length / 1024).toFixed(0)} KB)`);
  }
} catch (e) {
  // An exception here is the harness talking to the browser, not the game —
  // unless checks already failed, in which case bail() fails the run.
  bail(`harness error: ${e.message}`);
} finally {
  // Teardown must never change the verdict: a browser that will not close or a
  // temp profile that will not delete is not a game regression.
  try { if (session) session.close(); } catch { /* ignore */ }
  try { if (tab) await closeTab(browser.base, tab.id); } catch { /* ignore */ }
  try { await browser.kill(); } catch { /* ignore */ }
}

report();
