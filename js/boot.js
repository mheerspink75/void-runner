/**
 * boot.js — Entry point. Installs failure reporting before anything else can
 * fail, then loads the game.
 *
 * This file deliberately has *no imports*. A static import would have to be
 * fetched and evaluated before a single line here runs, so a broken or missing
 * module would take down the page with nothing installed to catch it. The game
 * is pulled in with a dynamic import() instead, which gives us a real
 * try/catch around module evaluation — that is what turns "the loading spinner
 * never goes away and the console says something cryptic" into an on-screen
 * explanation.
 *
 * The other thing worth catching early is WebGL itself. three.js throws from
 * the WebGLRenderer constructor when it cannot get a context, and that happens
 * deep inside Game's constructor. Probing for a context first lets us say
 * "this browser/ GPU can't run the game" instead of relaying a Three.js
 * internal error.
 */

(() => {
  'use strict';

  const MAX_DETAIL_CHARS = 2000;
  let installed = false;

  // ---------------------------------------------------------------------
  // Fatal overlay
  // ---------------------------------------------------------------------

  /**
   * Show a full-screen failure panel.
   *
   * @param {string} title    short headline, e.g. "WebGL unavailable"
   * @param {string} message  what went wrong, in plain words
   * @param {string} [detail] stack trace or raw error text
   */
  function showFatal(title, message, detail) {
    // Keep the console authoritative: this is a mirror, not a replacement.
    console.error(`[void-runner] ${title}: ${message}`, detail || '');

    // The panel is declared in index.html and hidden until something goes
    // wrong, so that a failure here is the only thing that ever reveals it.
    let panel = document.getElementById('fatal');
    if (!panel) {
      // Should not happen, and smoke.py asserts the id exists — but throwing
      // from inside the error reporter is the one failure mode that cannot be
      // reported, so degrade to a bare console error instead.
      console.error(`[void-runner] ${title}: ${message}`, detail || '');
      return;
    }
    panel.classList.remove('hidden');

    // Don't stack panels if several errors arrive in a row.
    panel.textContent = '';

    const box = document.createElement('div');
    box.className = 'fatal-box';

    const h = document.createElement('h2');
    h.className = 'fatal-title';
    h.textContent = title;
    box.appendChild(h);

    const p = document.createElement('p');
    p.className = 'fatal-message';
    p.textContent = message;
    box.appendChild(p);

    if (detail) {
      const pre = document.createElement('pre');
      pre.className = 'fatal-detail';
      pre.textContent = detail.length > MAX_DETAIL_CHARS
        ? detail.slice(0, MAX_DETAIL_CHARS) + '\n… truncated, see the console'
        : detail;
      box.appendChild(pre);

      // Selecting the trace is the difference between a usable bug report and
      // "it broke". The stylesheet sets user-select:none globally to keep the
      // HUD from being selected mid-firefight.
      pre.addEventListener('click', () => {
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        range.selectNodeContents(pre);
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }

    const row = document.createElement('div');
    row.className = 'fatal-actions';

    const reload = document.createElement('button');
    reload.className = 'cta';
    reload.textContent = 'RELOAD';
    reload.addEventListener('click', () => window.location.reload());
    row.appendChild(reload);

    // If we got here from a mid-game error the loop may well still be alive,
    // so offer a way back rather than trapping the player on this screen.
    const dismiss = document.createElement('button');
    dismiss.className = 'ghost';
    dismiss.textContent = 'DISMISS';
    dismiss.addEventListener('click', () => panel.remove());
    row.appendChild(dismiss);

    box.appendChild(row);
    panel.appendChild(box);
  }

  /** Best-effort human-readable text for anything that reaches a handler. */
  function describe(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try {
      return String(err);
    } catch {
      return 'Unprintable error object';
    }
  }

  function stackOf(err) {
    if (err instanceof Error && err.stack) return err.stack;
    if (err && typeof err === 'object' && typeof err.stack === 'string') {
      return err.stack;
    }
    return '';
  }

  // ---------------------------------------------------------------------
  // Global handlers
  // ---------------------------------------------------------------------

  function installHandlers() {
    if (installed) return;
    installed = true;

    window.addEventListener('error', (e) => {
      // A failure to load a resource (a module, a font) also lands here with
      // no message. Those are worth naming, because "cannot read property of
      // undefined" downstream is almost always a stale or missing module.
      if (e.target && e.target !== window && e.target.tagName) {
        const url = e.target.src || e.target.href;
        if (url) {
          showFatal(
            'Failed to load resource',
            `The browser could not fetch ${url}. If you are running a local ` +
            `copy, serve the folder over HTTP (./serve.sh) rather than opening ` +
            `index.html directly — ES modules do not load over file://. A stale ` +
            `module cache produces the same symptom.`,
            url
          );
          return;
        }
      }
      showFatal(
        'Runtime error',
        describe(e.error || e.message),
        stackOf(e.error)
      );
    });

    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      showFatal(
        'Unhandled promise rejection',
        describe(reason),
        stackOf(reason)
      );
    });
  }

  // ---------------------------------------------------------------------
  // WebGL probe
  // ---------------------------------------------------------------------

  /**
   * @returns {string|null} null if a context is available, else the reason
   */
  function checkWebGL() {
    let canvas;
    try {
      canvas = document.createElement('canvas');
    } catch (e) {
      return 'Could not create a canvas element.';
    }
    if (!canvas.getContext) {
      return 'This browser does not implement canvas.getContext at all.';
    }
    let gl = null;
    try {
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    } catch (e) {
      return 'Creating a WebGL context threw: ' + describe(e);
    }
    if (!gl) {
      return 'The browser refused a WebGL context. Hardware acceleration is ' +
        'probably disabled, or the GPU is on a blocklist.';
    }
    // Release the probe context immediately; browsers cap how many are live.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return null;
  }

  // ---------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------

  installHandlers();

  const webglProblem = checkWebGL();
  if (webglProblem) {
    showFatal('WebGL unavailable', webglProblem +
      ' This game renders with WebGL and cannot fall back to another mode.');
    return;
  }

  // Dynamic import: everything above is synchronous and dependency-free, so a
  // failure anywhere in main.js's own import graph still gets reported here
  // rather than vanishing into the console.
  import('./main.js').catch((err) => {
    showFatal(
      'Failed to start the game',
      describe(err) +
      ' — this is usually a stale module cache. Run ./serve.sh (it sends ' +
      'Cache-Control: no-store), then hard-reload, or clear site data in ' +
      'DevTools → Application → Storage.',
      stackOf(err)
    );
  });
})();
