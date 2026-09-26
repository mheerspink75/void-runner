/**
 * input.js — Keyboard, mouse and pointer-lock management.
 *
 * Exposes a simple polled API:
 *   input.down(code)      → is key currently held
 *   input.pressed(code)   → was key pressed this frame (auto-cleared)
 *   input.mouseDX/Y       → accumulated look delta this frame
 *   input.firing           → is the fire button held
 *   input.firePressed      → was fire pressed this frame
 *   input.endFrame()       → clear per-frame state
 */

import { KEYS } from './config.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.firing = false;
    this.firePressed = false;
    this.wheelDelta = 0;

    this.locked = false;
    this.sensitivity = 0.0021;

    /** @type {Set<(locked:boolean)=>void>} */
    this.lockListeners = new Set();

    this._bind();
  }

  // ------------------------------------------------------------------
  // Event wiring
  // ------------------------------------------------------------------
  _bind() {
    // ---- keyboard ----
    window.addEventListener('keydown', (e) => {
      // Prevent page scroll / browser shortcuts while playing
      if (this.locked || e.code === 'Escape') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.justReleased.add(e.code);
    });

    // Safety: release all keys when the tab loses focus so the player
    // does not keep running after alt-tabbing.
    window.addEventListener('blur', () => this.releaseAll());

    // ---- mouse buttons ----
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.firing = true; this.firePressed = true; }
      if (e.button === 2) { this.justPressed.add('MouseRight'); this.firing = false; }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // ---- look ----
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });

    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheelDelta += Math.sign(e.deltaY);
    }, { passive: true });

    // ---- pointer lock ----
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.firing = false;
        this.releaseAll();
      }
      this._emitLock();
    });

    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this._emitLock();
    });
  }

  _emitLock() {
    for (const fn of this.lockListeners) fn(this.locked);
  }

  /** Subscribe to pointer-lock state changes. Returns an unsubscribe fn. */
  onLockChange(fn) {
    this.lockListeners.add(fn);
    return () => this.lockListeners.delete(fn);
  }

  // ------------------------------------------------------------------
  // Pointer lock control
  // ------------------------------------------------------------------
  requestLock() {
    if (this.locked) return;
    if (!this.canvas.requestPointerLock) return;

    // Pointer lock requires a secure context and a valid top-level document.
    // Embedded frames, headless runners and non-HTTPS origins reject it, and
    // some browsers surface that as an unhandled promise rejection. Swallow
    // every failure path so the game simply stays unlocked and playable.
    const fallback = () => {
      try {
        const p = this.canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => { this.locked = false; });
      } catch (_) {
        this.locked = false;
      }
    };

    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.then === 'function') {
        p.then(() => {}, fallback);
      }
    } catch (_) {
      fallback();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  releaseAll() {
    this.keys.clear();
    this.firing = false;
    this.mouseDX = this.mouseDY = 0;
  }

  // ------------------------------------------------------------------
  // Polled queries
  // ------------------------------------------------------------------
  down(code) { return this.keys.has(code); }

  pressed(code) { return this.justPressed.has(code); }

  released(code) { return this.justReleased.has(code); }

  /** True if any key bound to the action is held. */
  anyDown(list) {
    for (const c of list) if (this.keys.has(c)) return true;
    return false;
  }

  /** True if any key bound to the action was pressed this frame. */
  anyPressed(list) {
    for (const c of list) if (this.justPressed.has(c)) return true;
    return false;
  }

  setSensitivity(s) { this.sensitivity = s; }

  /** Consume accumulated look delta (radians). */
  consumeLook() {
    const dx = this.mouseDX * this.sensitivity;
    const dy = this.mouseDY * this.sensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  consumeFirePress() {
    const f = this.firePressed;
    this.firePressed = false;
    return f;
  }

  consumeWheel() {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  /** Clear per-frame state. Call at the end of every frame. */
  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
  }

  // Convenience bindings used by the player controller ---------------
  get moveForward() { return this.anyDown(KEYS.forward); }
  get moveBack()    { return this.anyDown(KEYS.back); }
  get moveLeft()    { return this.anyDown(KEYS.left); }
  get moveRight()   { return this.anyDown(KEYS.right); }
  get jumpHeld()    { return this.anyDown(KEYS.jump); }
  get sprintHeld()  { return this.anyDown(KEYS.sprint); }
  get crouchHeld()  { return this.anyDown(KEYS.crouch); }
  get reloadPressed(){ return this.anyPressed(KEYS.reload); }
  get jumpPressed() { return this.anyPressed(KEYS.jump); }
}
