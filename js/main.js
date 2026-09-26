/**
 * main.js — Game bootstrap, scene setup, state machine and the main loop.
 *
 * States: menu → playing ⇄ paused → gameover / victory
 */

import * as THREE from '../vendor/three.module.js';
import { CONFIG, KEYS } from './config.js';
import { clamp, rand, fmt } from './utils.js';
import { Input } from './input.js';
import { audio } from './audio.js';
import { makeEnvironment } from './env.js';
import { PostFX } from './postfx.js';
import { ProjectileManager } from './projectiles.js';
import { PlayerProjectileManager } from './playerprojectiles.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Effects } from './effects.js';
import { Weapons } from './weapons.js';
import { EnemyManager, ENEMY_TYPES } from './enemies.js';
import { PickupManager } from './pickups.js';
import { WaveDirector } from './waves.js';
import { HUD } from './hud.js';
import { LightPool } from './lightpool.js';

class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.state = 'menu';
    this.elapsed = 0;
    this.rafId = null;
    this.lastTime = 0;

    // ---- build stamp ----
    // Shown on the menu and in the console. If a reload does not change this
    // number, the browser is serving cached ES modules and the code on disk
    // is not what is running. That has been a recurring, very confusing
    // failure mode here, so it is worth surfacing explicitly.
    const stamp = document.getElementById('build-stamp');
    if (stamp) stamp.textContent = `build ${CONFIG.build}`;
    console.info(`[void-runner] build ${CONFIG.build} — ` +
      `anim config: ${CONFIG.anim ? 'loaded' : 'MISSING (using fallback defaults)'}`);

    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.damageDealt = 0;

    this._initRenderer();
    this._initScene();
    this._initSystems();
    this._initUI();

    // Start rendering straight away, while the loading overlay is still up.
    // The first frame compiles every shader, which costs hundreds of
    // milliseconds. Previously the loop did not begin until the start button
    // was clicked, so that entire compile landed inside the click handler and
    // froze the UI for 3+ seconds. Doing it here moves the cost into the
    // loading screen, where the player is already waiting.
    this._loadingOverlayPending = true;
    // Seed the clock before the first iteration, otherwise the initial frame
    // computes dt against a `lastTime` of 0 and clamps to the maximum step.
    this.lastTime = performance.now();
    this._loop();
  }

  // ==================================================================
  // Setup
  // ==================================================================
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    window.addEventListener('resize', () => this._onResize());
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      82, window.innerWidth / window.innerHeight, 0.08, 500
    );
    this.scene.add(this.camera);

    // Procedural environment map. Without this, every metal surface in the
    // game renders near-black because metals reflect the environment only.
    this.envMap = makeEnvironment(this.renderer);
    this.scene.environment = this.envMap;
  }

  _initSystems() {
    this.input = new Input(this.canvas);
    this.input.setSensitivity(CONFIG.look.sensitivity);
    this.hud = new HUD();

    this.world = new World(this.scene);
    this.world.followTarget = this.camera.position;

    // ---- dynamic light pool ----
    // Every transient light (one per live enemy, one per live pickup, muzzle
    // flashes, impacts, portals) is drawn from this fixed pool instead of
    // being created and destroyed. three.js caches compiled programs under a
    // key that includes the scene's light count, so adding or removing a light
    // forces a full shader recompile — measured at ~200-260ms per change
    // here, and it fired repeatedly during normal play. With a fixed pool the
    // count is constant and the program cache stays warm. See lightpool.js.
    const staticPoints = this.world.dynamicLightBudget ?? 0;
    this.lightPool = new LightPool(this.scene, staticPoints);

    this.player = new Player(this.camera, this.world, audio);
    this.effects = new Effects(this.scene, this.camera, this.lightPool);
    this.projectiles = new ProjectileManager(
      this.scene, this.world, this.player, audio, this.effects
    );
    this.weapons = new Weapons(
      this.renderer, this.camera, this.world, this.player, this.effects, audio
    );
    this.weapons.vmScene.environment = this.envMap;

    this.enemies = new EnemyManager(
      this.scene, this.world, this.player, audio, this.effects, this.projectiles,
      this.lightPool
    );
    // Player-owned ballistics (grenades). Separate from `this.projectiles`,
    // which is the enemy pool.
    this.playerShots = new PlayerProjectileManager(
      this.scene, this.world, this.player, this.effects, this.enemies, audio,
      this.lightPool
    );
    this.pickups = new PickupManager(
      this.scene, this.world, this.player, audio, this.effects, this.lightPool
    );
    this.waves = new WaveDirector(this.enemies, audio);

    // ---- post-processing ----
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    this.postfx.setQuality('high');
    // The viewmodel renders as a pass inside the chain so it gets bloom/grade
    this.postfx.setViewmodel(this.weapons.vmScene, this.weapons.vmCamera);

    this._wireEvents();
  }

  _wireEvents() {
    // ---- player ----
    this.player.onDamage = (amount, remaining) => {
      this.hud.damageFlash();
      this.postfx.pulseDamage(0.85);
      this.postfx.addShake(0.55);
      // Light hit-stop sells the impact of taking damage
      this.postfx.addHitstop(Math.min(0.07, amount * 0.0022));
      this.stats.damageTaken += amount;
      this.effects.popup(
        new THREE.Vector3(
          this.player.position.x,
          this.player.position.y + 1.9,
          this.player.position.z
        ),
        `-${Math.round(amount)}`, 'incoming'
      );
      this._updateHUD();
    };

    this.player.onDeath = () => this._gameOver();

    // Dash: FOV kick is handled by the player; shake sells the burst
    this.player.onDash = () => {
      this.postfx.addShake(0.28);
      // Punch the radial blur outward — this is the main "dash" read.
      this.postfx.addRadialBlur(0.9);
      this.stats.dashes++;
      audio.uiClick();
    };

    // Melee is a two-phase event: `onMelee` fires the instant the swing
    // starts (audio + anticipation), `onMeleeHit` fires on the impact frame
    // and is where damage and hit feedback belong. Resolving the swing in
    // main keeps the player module free of enemy-manager references.
    this.player.onMelee = () => {
      audio.impact(this.player.position.x, 0.3, this.player.position.z, false);
    };
    this.player.onMeleeHit = () => {
      this._resolveMelee();
    };

    this.player.onStep = (sprinting, crouching) => {
      // Footstep thump — reuse a low sine blip
      audio.impact(this.player.position.x, 0.2, this.player.position.z, false);
    };

    this.player.onLand = (force) => {
      if (force > 0.08) {
        audio.impact(this.player.position.x, 0.1, this.player.position.z);
        // Hard landings kick a little blur + shake, scaled by impact.
        const k = Math.min(force / 0.35, 1);
        this.postfx.addShake(k * 0.3);
        this.postfx.addRadialBlur(k * 0.35);
      }
    };

    // ---- weapons ----
    this.weapons.onFire = (info = {}) => {
      this.hud.crosshairKick();
      // Light recoil shake; a confirmed hit adds a punch on top.
      this.postfx.addShake(0.12);
      if (info.hit) {
        this.hud.hitmark(!!info.killed);
        this.postfx.addShake(info.killed ? 0.4 : 0.15);
        // Hit-stop scales with the outcome: a kill freezes noticeably longer
        this.postfx.addHitstop(info.killed ? 0.075 : 0.03);
        if (info.headshot) this.stats.headshots++;
      }
      this._updateHUD();
    };
    this.weapons.onEmptyClick = () => this._updateHUD();
    this.weapons.onReloadStart = () => this.hud.setReloading(true);
    this.weapons.onReloadEnd = (ok) => {
      this.hud.setReloading(false);
      if (ok) this._updateHUD();
    };
    this.weapons.onAmmoChange = () => this._updateHUD();
    this.weapons.onSwitch = (def) => {
      this.hud.setWeapon(def.name);
      this.hud.setSlot(this.weapons.slotIndex, this.weapons.weaponNames);
    };
    // Ballistic weapons hand their round to the player projectile pool here,
    // keeping Weapons free of scene/collision ownership.
    this.weapons.onProjectile = (origin, dir, pdef) => {
      this.playerShots.spawn(origin, dir, pdef);
    };

    // ---- enemies ----
    this.enemies.onKill = (e) => {
      this._onEnemyKilled(e);
    };

    // ---- waves ----
    this.waves.onWaveStart = (n, count) => {
      this.hud.setWave(n);
      this.hud.waveBanner(n, CONFIG.waves.total, `HOSTILES INBOUND · ${count} SIGNATURES`);
      // Music tension ramps as the wave gets harder
      audio.setTension(clamp(n / CONFIG.waves.total, 0, 1));
      // Attrition insurance: a small top-up of every weapon each wave. Small
      // enough that scavenged pickups still matter, large enough that a bad
      // stretch cannot spiral into an unwinnable run.
      const added = this.weapons.resupplyForWave();
      if (added > 0) {
        this.hud.killfeed(`RESUPPLY  +${added} ROUNDS`, false);
      }
      this._updateHUD();
    };
    this.waves.onWaveClear = (n) => {
      this.score += CONFIG.scoring.waveClearBonus * n;
      this.hud.killfeed(`WAVE ${n} CLEARED  +${fmt(CONFIG.scoring.waveClearBonus * n)}`, true);
      this._updateHUD();
    };
    this.waves.onVictory = () => this._victory();

    // ---- pickups ----
    this.pickups.onCollect = (kind, value) => {
      if (kind === 'ammo') {
        // Return the count actually taken: PickupManager._collect treats 0 as
        // "player is full" and leaves the crate on the ground.
        return this.weapons.addAmmo(1);
      }
      if (kind === 'health') {
        this.postfx.pulseHeal(0.8);
      } else if (kind === 'overdrive') {
        // Drive the weapon buff; powerMultiplier reads this each shot.
        this.weapons.activateOverdrive(value);
        this.postfx.pulseHeal(0.6);
      }
      this._updateHUD();
      return 1;   // consumed
    };

    // ---- pointer lock ----
    // If the browser refuses pointer lock (embedded frame, headless, insecure
    // origin) the game must stay playable with click-drag look instead of
    // dropping straight into the pause menu.
    this._everLocked = false;
    this.input.onLockChange((locked) => {
      if (locked) this._everLocked = true;
      if (!locked && this.state === 'playing' && this._everLocked) this._pause();
    });
  }

  _initUI() {
    const $ = (id) => document.getElementById(id);
    this.ui = {
      menu: $('menu'),
      pause: $('pause'),
      gameover: $('gameover'),
      victory: $('victory'),
      loading: $('loading'),
      btnStart: $('btn-start'),
      btnResume: $('btn-resume'),
      btnQuit: $('btn-quit'),
      btnRetry: $('btn-retry'),
      btnMenu: $('btn-menu'),
      btnAgain: $('btn-again'),
      btnSound: $('btn-sound'),
      btnQuality: $('btn-quality'),
      resScore: $('res-score'),
      resWave: $('res-wave'),
      resKills: $('res-kills'),
      vicScore: $('vic-score'),
      vicWave: $('vic-wave'),
      vicAcc: $('vic-acc'),
    };

    this.ui.btnStart.addEventListener('click', () => this._start());
    this.ui.btnResume.addEventListener('click', () => this._resume());
    this.ui.btnQuit.addEventListener('click', () => this._toMenu());
    this.ui.btnRetry.addEventListener('click', () => this._start());
    this.ui.btnAgain.addEventListener('click', () => this._start());
    this.ui.btnMenu.addEventListener('click', () => this._toMenu());
    this.ui.btnSound.addEventListener('click', () => {
      const m = audio.toggleMute();
      this.ui.btnSound.textContent = `SOUND: ${m ? 'OFF' : 'ON'}`;
    });

    // Quality: AUTO follows the framerate, the other options pin it.
    this.qualityMode = 'auto';
    this.ui.btnQuality.addEventListener('click', () => {
      const order = ['auto', 'low', 'medium', 'high'];
      const next = order[(order.indexOf(this.qualityMode) + 1) % order.length];
      this.qualityMode = next;
      this.ui.btnQuality.textContent = `QUALITY: ${next.toUpperCase()}`;
      if (next !== 'auto') {
        this.postfx.setQuality(next);
        this.renderer.setPixelRatio(
          next === 'low' ? 1 : Math.min(window.devicePixelRatio, 2)
        );
        this.postfx.setSize(window.innerWidth, window.innerHeight);
      }
    });

    // Clicking the canvas while playing (but unlocked) re-locks
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') {
        const m = audio.toggleMute();
        this.ui.btnSound.textContent = `SOUND: ${m ? 'OFF' : 'ON'}`;
      }
      if (e.code === 'Escape') {
        if (this.state === 'playing') this._pause();
        else if (this.state === 'paused') this._resume();
      }
    });
  }

  // ==================================================================
  // State transitions
  // ==================================================================
  _start() {
    audio.init();
    audio.resume();
    audio.uiClick();
    audio.startMusic();

    this._resetRun();

    this.state = 'playing';
    this.ui.menu.classList.add('hidden');
    this.ui.pause.classList.add('hidden');
    this.ui.gameover.classList.add('hidden');
    this.ui.victory.classList.add('hidden');
    this.hud.show();
    this.hud.clearBanner();
    // Slot row reflects the (reset) equipped weapon.
    this.hud.setSlot(this.weapons.slotIndex, this.weapons.weaponNames);
    this.hud.setWeapon(this.weapons.def.name);
    // _gameOver hides these; a fresh run must bring them back
    this.weapons.setVisible(true);
    this.postfx.setViewmodelVisible(true);

    this.input.requestLock();
    this.lastTime = performance.now();
    // The loop is already running (started at boot behind the loading
    // overlay), so there is nothing to kick off here.
  }

  _resetRun() {
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.damageDealt = 0;
    this.elapsed = 0;

    // Run statistics surfaced on the end screens.
    this.stats = {
      headshots: 0,
      bestCombo: 0,
      killsByType: {},
      dashes: 0,
      meleeKills: 0,
      damageTaken: 0,
      distance: 0,
    };

    this.player.reset();
    this.weapons.reset();
    this.enemies.clear();
    this.projectiles.clear();
    this.playerShots.clear();
    this.pickups.clear();
    this.effects.clear();
    this.lightPool.clear();
    this.waves.reset();
    this.waves.start();

    this._updateHUD();
  }

  _pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.exitLock();
    this.ui.pause.classList.remove('hidden');
    audio.suspend();
  }

  _resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.pause.classList.add('hidden');
    audio.resume();
    this.input.requestLock();
    this.lastTime = performance.now();
  }

  _toMenu() {
    this.state = 'menu';
    this.input.exitLock();
    this.ui.pause.classList.add('hidden');
    this.ui.gameover.classList.add('hidden');
    this.ui.victory.classList.add('hidden');
    this.ui.menu.classList.remove('hidden');
    this.hud.hide();
    this.waves.reset();
    this.enemies.clear();
    this.projectiles.clear();
    this.playerShots.clear();
    this.pickups.clear();
    this.effects.clear();
    audio.stopMusic();
  }

  // ==================================================================
  // Melee
  // ==================================================================
  /**
   * Resolve a melee swing against everything inside the player's cone.
   * Damage scales with overdrive, knockback pushes enemies away, and a kill
   * gives a longer hit-stop than a plain connect.
   */
  _resolveMelee() {
    const P = CONFIG.player;
    const targets = this.player.meleeTargets(this.enemies.enemies);
    audio.impact(this.player.position.x, 0.3, this.player.position.z, false);
    this.postfx.addShake(0.2);

    if (!targets.length) {
      // Whiff still costs stamina, so the swing has a real downside
      return;
    }

    // Overdrive makes melee hit meaningfully harder
    const dmg = P.meleeDamage * this.weapons.powerMultiplier;
    let killedAny = false;
    const dir = this.player.getLookDir(new THREE.Vector3());

    for (const { enemy } of targets) {
      const hitPoint = enemy.position.clone();
      hitPoint.y += enemy.def.height * 0.55;

      const wasKilled = enemy.takeDamage(dmg, dir, false, hitPoint, this.effects);
      this.effects.popup(hitPoint, String(Math.round(dmg)), wasKilled ? 'crit' : '');

      // Knockback away from the player. `knockback` also cancels a windup,
      // so a well-timed swing interrupts a charging enemy.
      const away = enemy.position.clone().sub(this.player.position);
      away.y = 0;
      if (away.lengthSq() > 0.0001) {
        away.normalize();
        enemy.knockback(away.x, away.z, P.meleeKnockback);
      }

      this.hud.hitmark(wasKilled);
      killedAny = killedAny || wasKilled;
      if (wasKilled) this.stats.meleeKills++;
    }

    this.postfx.addShake(0.5);
    this.postfx.addHitstop(killedAny ? 0.1 : 0.05);
    audio.enemyShoot(
      this.player.position.x, this.player.position.y + 1.4, this.player.position.z
    );
  }

  /**
   * Populate the secondary stat rows on an end screen.
   * @param {'res'|'vic'} prefix element id prefix in index.html
   */
  _fillResults(prefix, st) {
    const get = (k) => document.getElementById(`${prefix}-${k}`);
    const set = (k, v) => {
      const el = get(k);
      if (el) el.textContent = v;
    };
    set('combo', st.bestCombo);
    set('headshots', st.headshots);
    set('dashes', st.dashes);
    set('time', this._formatTime(this.elapsed));
  }

  _formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  _gameOver() {
    if (this.state === 'gameover') return;
    this.state = 'gameover';
    this.input.exitLock();
    this.weapons.setVisible(false);
    this.postfx.setViewmodelVisible(false);
    audio.playerDeath();
    audio.stopMusic();
    this.hud.hide();

    this.ui.resScore.textContent = fmt(this.score);
    this.ui.resWave.textContent = this.waves.wave;
    this.ui.resKills.textContent = this.enemies.killCount;
    this._fillResults('res', this.stats);
    this.ui.gameover.classList.remove('hidden');
  }

  _victory() {
    if (this.state === 'victory') return;
    this.state = 'victory';
    this.input.exitLock();
    audio.victory();
    audio.stopMusic();
    this.hud.hide();

    const acc = this.weapons.shotsFired
      ? Math.round((this.weapons.shotsHit / this.weapons.shotsFired) * 100)
      : 0;
    this.ui.vicScore.textContent = fmt(this.score);
    this.ui.vicWave.textContent = `${this.waves.wave} / ${CONFIG.waves.total}`;
    this.ui.vicAcc.textContent = acc + '%';
    this._fillResults('vic', this.stats);
    this.ui.victory.classList.remove('hidden');
  }

  // ==================================================================
  // Scoring
  // ==================================================================
  _onEnemyKilled(e) {
    this.comboTimer = CONFIG.scoring.comboWindow;
    this.combo = Math.min(this.combo + 1, CONFIG.scoring.comboMax);
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
    this.stats.killsByType[e.kind] = (this.stats.killsByType[e.kind] || 0) + 1;

    const mult = 1 + (this.combo - 1) * CONFIG.scoring.killMultiplierStep;
    let gained = Math.round(e.def.score * mult);
    this.score += gained;

    // Drops
    this.pickups.rollDrop(
      e.position.x,
      0.6,
      e.position.z,
      e.def.dropChance
    );

    // Feed
    const crit = this.weapons.headshots > 0 && Math.random() < 0.3;
    this.hud.killfeed(
      `${e.def.name} ELIMINATED  +${gained}${this.combo > 1 ? `  x${this.combo}` : ''}`,
      crit
    );

    this.hud.setScore(this.score);
  }

  // ==================================================================
  // HUD sync
  // ==================================================================
  _updateHUD() {
    this.hud.setScore(this.score);
    this.hud.setHealth(this.player.health, CONFIG.player.maxHealth);
    this.hud.setEnemies(this.enemies.aliveCount);
    const a = this.weapons.current;
    this.hud.setAmmo(a.mag, this.weapons.def.magSize, a.reserve);
    this.hud.setWeapon(this.weapons.name);
  }

  // ==================================================================
  // Main loop
  // ==================================================================
  _loop() {
    this.rafId = requestAnimationFrame(() => this._loop());

    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp to avoid tunnelling on tab-switch / long frames
    dt = clamp(dt, 0, 0.05);
    // Only in-game time advances the run clock. The loop now also runs while
    // the menu is up, so without this the elapsed time would drift for as long
    // as the player sat on the title screen.
    if (this.state === 'playing') this.elapsed += dt;

    if (this.state === 'playing') {
      // Hit-stop: skip simulation for a few ms after a heavy hit so impacts
      // land with weight. The frame still renders, so it reads as a punch
      // rather than a dropped frame. postfx.update() always runs on real
      // time, so the freeze decays even though sim time is paused.
      if (this.postfx.hitstop <= 0) this._update(dt);
      this.postfx.update(dt);
    } else if (this.state === 'gameover' || this.state === 'victory') {
      // Keep the world rendering but frozen-ish
      this.world.update(dt, this.elapsed);
      this.effects.update(dt);
      this.player._applyCamera(dt);
      this.postfx.update(dt);
    } else {
      this.postfx.update(dt);
    }

    this._render();
    this._trackPerformance(dt);
    this.input.endFrame();

    // Dismiss the loading overlay on the first frame that has actually been
    // drawn — i.e. after shader compilation has finished — so the canvas is
    // never revealed while still blank.
    if (this._loadingOverlayPending) {
      this._loadingOverlayPending = false;
      this.ui.loading.classList.add('done');
      setTimeout(() => this.ui.loading.remove(), 600);
    }
  }

  /**
   * Adaptive quality. Samples a rolling average frame time and steps the
   * post-processing tier down (then back up) so the game stays responsive on
   * weak GPUs instead of dropping to a slideshow. Only ever changes when the
   * average has been stable for a while, to avoid oscillating.
   */
  _trackPerformance(dt) {
    // Only auto-tune when the player has not pinned a quality level.
    if (this.state !== 'playing' || this.qualityMode !== 'auto') return;

    // Exponential moving average of frame time.
    this._frameAvg = this._frameAvg === undefined
      ? dt
      : this._frameAvg * 0.94 + dt * 0.06;

    this._perfTimer = (this._perfTimer || 0) + dt;
    if (this._perfTimer < 2.5) return;
    this._perfTimer = 0;

    const fps = 1 / Math.max(this._frameAvg, 1e-4);
    const tier = this.postfx.quality;

    if (fps < 42 && tier === 'high') {
      this.postfx.setQuality('medium');
      this._frameAvg = 1 / 60;   // reset so the next tier decision is fresh
    } else if (fps < 34 && tier === 'medium') {
      this.postfx.setQuality('low');
      this.renderer.setPixelRatio(1);
      this.postfx.setSize(window.innerWidth, window.innerHeight);
      this._frameAvg = 1 / 60;
    } else if (fps > 58 && tier === 'low') {
      this.postfx.setQuality('medium');
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.postfx.setSize(window.innerWidth, window.innerHeight);
      this._frameAvg = 1 / 60;
    } else if (fps > 57 && tier === 'medium') {
      this.postfx.setQuality('high');
      this._frameAvg = 1 / 60;
    }
  }

  /**
   * Feed the world's contact-shadow pool from live enemies and pickups.
   * Slots are handed out enemies-first, then pickups, so a full pool drops
   * pickups rather than characters.
   */
  _updateContactShadows() {
    const enemies = this.enemies.enemies;
    const items = this.pickups.items;
    const ne = enemies.length;

    // Pre-allocated scratch records: this runs every frame, so it must not
    // allocate. `n` tracks how many are filled; the getter reports null past
    // that so unused slots are hidden.
    this._shadowScratch ??= Array.from({ length: 40 }, () => ({
      x: 0, y: 0, z: 0, radius: 1, strength: 0,
    }));
    const buf = this._shadowScratch;
    let n = 0;

    for (let i = 0; i < ne && n < buf.length; i++) {
      const e = enemies[i];
      if (e.dead) continue;              // corpses do not cast
      const s = buf[n];
      s.x = e.position.x;
      s.y = e.position.y;                // height above its footing
      s.z = e.position.z;
      s.radius = e.def.radius * 2.5;
      s.strength = 0.8;
      n++;
    }
    for (let i = 0; i < items.length && n < buf.length; i++) {
      const it = items[i];
      const s = buf[n];
      s.x = it.group.position.x;
      s.y = Math.max(0, it.group.position.y - 0.55);
      s.z = it.group.position.z;
      s.radius = 1.1;
      s.strength = 0.6;
      n++;
    }

    this.world.updateContactShadows((i) => (i < n ? buf[i] : null));
  }

  _update(dt) {
    const input = this.input;

    // ---- systems ----
    this.world.update(dt, this.elapsed);
    this.player.update(dt, input);
    this.weapons.update(dt, input, this.player);
    this.enemies.update(dt);
    this.projectiles.update(dt);
    this.playerShots.update(dt);
    this.pickups.update(dt);
    this.waves.update(dt);
    this.effects.update(dt);
    this.hud.update(dt);
    // Ground everything with a soft blob shadow. Runs after the systems above
    // so positions are current. Reuses one scratch object per slot — this is
    // called every frame and must not allocate.
    this._updateContactShadows();
    // Advance light release fades after every system has had a chance to
    // acquire or release a slot this frame.
    this.lightPool.update(dt);

    // ---- firing ----
    // `tryFire(enemies, triggerHeld)`. Charge weapons (railgun) need to know
    // the trigger is still down: holding builds charge, releasing fires.
    const charging = this.weapons.charging;
    if (input.firing) {
      const isCharge = this.weapons.def.isCharge;
      if (isCharge || this.weapons.def.auto) {
        this.weapons.tryFire(this.enemies.enemies, true);
      } else if (input.consumeFirePress()) {
        this.weapons.tryFire(this.enemies.enemies, false);
      } else {
        input.consumeFirePress();
      }
    } else {
      // Releasing the trigger fires a held charge. Only the charge weapon may
      // be called here — for normal weapons tryFire would ignore the flag and
      // fire an unwanted shot.
      if (charging) this.weapons.tryFire(this.enemies.enemies, false);
      input.consumeFirePress();
    }

    // ---- combo decay ----
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    // ---- audio listener ----
    audio.setListener(
      this.player.eyePosition,
      this.player.getForward()
    );

    // ---- continuous HUD ----
    this.hud.setHealth(this.player.health, CONFIG.player.maxHealth);
    this.hud.setStamina(this.player.stamina, CONFIG.player.maxStamina);
    this.hud.setEnemies(this.enemies.aliveCount);

    // Ability cooldowns: 1 = ready, 0 = just used.
    const dashK = 1 - Math.max(0, this.player.dashCd) / CONFIG.player.dashCooldown;
    const meleeK = 1 - Math.max(0, this.player.meleeCd) / CONFIG.player.meleeCooldown;
    this.hud.setAbilities(dashK, meleeK);

    // Overdrive timer
    this.hud.setOverdrive(this.weapons.overdrive, CONFIG.pickups.overdriveDuration);

    // Railgun charge
    this.hud.setCharge(this.weapons.charge);

    // Low health drives a constant red pulse in the grade pass
    const hpFrac = this.player.health / CONFIG.player.maxHealth;
    this.postfx.setLowHealth(hpFrac < 0.35 ? 1 - hpFrac / 0.35 : 0);

    // Radial blur follows movement speed, with a hard spike during a dash.
    this.postfx.setSpeedBlur(
      this.player.speed / CONFIG.player.sprintSpeed
    );
    if (this.player.dashT > 0) {
      this.postfx.addRadialBlur(dt * 2.6);
    }

    this.hud.setAmmo(
      this.weapons.current.mag,
      this.weapons.def.magSize,
      this.weapons.current.reserve
    );
    this.hud.setReloading(this.weapons.reloading);

    // ---- crosshair target detection ----
    // Throttled: a line-of-sight test per enemy every frame is wasted work
    // when the crosshair colour only needs to track what is under the reticle.
    this._crosshairT = (this._crosshairT || 0) - dt;
    if (this._crosshairT <= 0) {
      this._crosshairT = 0.05;
      this._updateCrosshairTarget();
    }

    // ---- minimap ----
    // Canvas 2D redraw of ~20 markers does not need 60 Hz.
    this._minimapT = (this._minimapT || 0) - dt;
    if (this._minimapT <= 0) {
      this._minimapT = 1 / 30;
      this.hud.drawMinimap(
        this.player.position,
        this.player.yaw,
        this.enemies.enemies,
        this.pickups.items,
        this.world
      );
    }
  }

  /** Cheap ray test to colour the crosshair when aiming at an enemy. */
  _updateCrosshairTarget() {
    if (this.enemies.enemies.length === 0) {
      if (this._hadTarget) { this.hud.crosshairOnTarget(false); this._hadTarget = false; }
      return;
    }
    const origin = this.player.eyePosition.clone();
    const dir = this.player.getLookDir(new THREE.Vector3());
    let nearest = null, nearestD = 60;

    for (const e of this.enemies.enemies) {
      if (e.dead || e.pendingSpawn) continue;
      const d = e.position.distanceTo(this.player.position);
      if (d > nearestD) continue;
      if (this.world.rayBlocked(
        origin.x, origin.y, origin.z,
        e.position.x, e.position.y + 1, e.position.z
      )) continue;
      nearestD = d;
      nearest = e;
    }

    const has = !!nearest;
    if (has !== this._hadTarget) {
      this.hud.crosshairOnTarget(has);
      this._hadTarget = has;
    }
  }

  _render() {
    // Everything goes through the composer so bloom + the grade pass actually
    // apply. The viewmodel is a pass inside the chain (see ViewmodelPass), not
    // a separate overlay draw, so it receives the same treatment as the world.
    this.postfx.render();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // The listener is registered in `_initRenderer`, which runs *before*
    // `_initScene` creates the camera and `_initSystems` creates the PostFX
    // chain. A resize (or a spurious early event) can therefore land before
    // those exist, so guard every member instead of assuming a booted game.
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.renderer) this.renderer.setSize(w, h);
    if (this.postfx) this.postfx.setSize(w, h);
  }
}

// ======================================================================
// Boot
// ======================================================================
const game = new Game();
window.__game = game;   // handy for debugging in the console
