# VOID RUNNER

A 3D first-person shooter that runs in the browser. Built with **Three.js** (vendored locally — no build step, no CDN, works fully offline).

Survive escalating waves of enemies in a neon-lit arena, using a pulse rifle, a scatter cannon, a charge-and-pierce arc lance, and a lobbed proximity grenade.

---

## Quick start

```bash
git clone https://github.com/mheerspink75/void-runner.git
cd void-runner
./serve.sh
```

Then open **http://localhost:8080**

> A local HTTP server is required — ES modules will not load over `file://`.
>
> **Use `./serve.sh`, not `python3 -m http.server`.** The bundled server
> (`tools/serve.py`) sends `Cache-Control: no-store` on every response. A
> plain `http.server` sends no cache headers at all, so the browser can end up
> running a freshly-edited module against a stale copy of another one. The
> symptom is a baffling `Cannot read properties of undefined` on a config key
> that plainly exists in the file on disk. Any static server works as a
> fallback, but prefer the bundled one.

---

## Controls

| Key | Action |
|---|---|
| `W` `A` `S` `D` | Move |
| `Mouse` | Look |
| `Left click` | Fire |
| `R` | Reload |
| `Space` | Jump |
| `Shift` | Sprint (drains stamina) |
| `Q` | **Dash** — short burst with invulnerability frames |
| `F` | **Melee** — knockback swing that interrupts enemy attacks |
| `Ctrl` / `C` | Crouch |
| `1` `2` `3` `4` / scroll | Switch weapon |
| `M` | Mute audio |
| `Esc` | Pause |

---

## Features

**Movement** — acceleration-based ground movement, air control, sprint with a stamina bar, crouch, coyote-time jumping, head bob, and a circular collision system resolved against world geometry (you can stand on crates and the central platform).

**Combat** — hitscan raycasting with per-shot spread cones, bloom while firing, movement and crouch modifiers, headshot multipliers, recoil that kicks both the camera and the viewmodel, tracers, impact sparks, decals, and floating damage numbers.

**Four weapons**
- **Pulse Rifle** — 900 RPM, 36-round mag, tight accuracy, 2.6× headshot multiplier, fully automatic.
- **Scatter Cannon** — 9 pellets per shot, 10-round mag, heavy spread and recoil, much higher close-range damage.
- **Arc Lance** — hold fire to charge (0.9 s), then release for a piercing beam that passes through every enemy in the lane. Partially charged shots are weak and single-target.
- **Arc Lobber** — lobs a proximity grenade on a physical arc (26 u/s, gravity, two bounces), so it clears cover instead of being blocked by it. Detonates on contact or after a 2 s fuse, whichever comes first, so a bad throw is never wasted. 135 direct / 120 in a 6.5-unit blast that falls off to 25% at the edge and knocks enemies back. No headshot bonus — it is an area tool, not a sniper.

**Enemies** — four archetypes with distinct models, stats, and AI:
- **HUSK** — baseline chaser.
- **PHANTOM** — fast and erratic, strafes while closing in.
- **JUGGERNAUT** — slow tank with heavy damage.
- **SPITTER** — ranged attacker that kites the player, firing arcing projectiles, and backs off if you close in.

They path directly at you, use line-of-sight checks to decide whether to attack, telegraph attacks with a windup, avoid stacking on each other, and are blocked by world geometry. Spitters lead their shots — they aim at where you will be, not where you are.

**Spawn portals** — enemies materialise from a glowing ring and column rather than popping in at the screen edge. They are invulnerable and unhittable during the animation, so you can never shoot something you haven't seen yet.

**Waves** — 10 waves with an escalating spawn mix and per-wave health/speed scaling. Phantoms appear from wave 2, Spitters from wave 3, Juggernauts from wave 5. The director spends a difficulty *budget* rather than counting bodies, so tougher units progressively replace trash. A concurrent-enemy cap keeps things readable, and a break timer separates waves. Clearing a wave pays a bonus; killing enemies in quick succession builds a score multiplier.

**Abilities** — dash (`Q`) grants invulnerability frames, so a well-timed dodge actually works. Melee (`F`) deals damage, knocks enemies back, and cancels their attack windup, so it is a real defensive option and not just a damage bonus.

**Pickups** — health, ammo, stamina, and Overdrive (a temporary damage and fire-rate boost), weighted toward health when you're hurt. They bob, spin, magnet toward the player when close, and expire.

**Presentation** — HUD with health/stamina/ammo/charge bars, ability cooldown meters, an overdrive timer, a live minimap with a radar sweep, kill feed, wave banners, hit markers, damage vignettes, a death cam, and end screens with full run stats (best streak, headshots, dashes, time).

---

## Graphics

- **Post-processing chain** — bloom plus a combined grade pass (chromatic aberration, film grain, vignette, scanlines, split-toning, unsharp mask) and tone mapping. The viewmodel renders *inside* the chain, so the gun picks up bloom too.
- **Motion blur** — radial blur driven by movement speed with a hard spike on dash and heavy landings. This is what makes a dash read as a burst rather than a teleport.
- **Procedural PBR textures** — metal floor plating, ribbed walls, industrial crates, and brushed pillars. Each generates albedo, roughness, and a normal map from an fBm height field. No image assets.
- **Gradient skybox** with a star field, plus a distant skyline with lit window strips for depth.
- **Fake volumetric light shafts** under the corner beacons — additive cones that breathe with the lamp flicker, far cheaper than raymarched volumetrics.
- **Physically-plausible lighting** — key light with shadows, warm rim light, coloured accent pools, and a procedural PMREM environment map. Without that env map, every metal surface renders near-black because metals are lit almost entirely by reflections.
- **Additive billboard sprites** for muzzle flashes, impacts, and explosions.

**Audio** — every sound is **synthesized at runtime with the Web Audio API**. No audio files. Includes weapon reports, impacts, enemy growls, footsteps, pickups, and a layered adaptive soundtrack whose tension rises with the wave number. Positional sounds attenuate and pan with distance.

---

## Project structure

```
index.html          markup + HUD/menu DOM
css/style.css       HUD, menus, vignette, and animation styling
vendor/
  three.module.js   Three.js r160 (vendored)
js/
  boot.js           entry point: failure reporting + WebGL probe, then loads the game
  main.js           bootstrap, game state machine, main loop
  config.js         all tuning constants (weapons, enemies, waves, movement)
  utils.js          math helpers
  input.js          keyboard, mouse, pointer lock
  player.js         FPS controller: movement, stance, health, camera
  weapons.js        firing, recoil, reload, viewmodel rendering
  projectiles.js    enemy-fired projectile simulation (gravity arcs)
  playerprojectiles.js  player-launched ballistics (the Arc Lobber)
  enemies.js        enemy models, AI, and the spawn manager
  pickups.js        health/ammo/stamina/overdrive drops
  waves.js          wave director
  world.js          arena geometry, lights, and collision data
  effects.js        tracers, sparks, decals, explosions
  postfx.js         bloom + combined grade pass (CA, grain, vignette, scanlines)
  audio.js          procedural Web Audio synthesis
  hud.js            HUD binding and minimap rendering
  env.js            procedural environment map (PMREM)
  textures.js       canvas-generated textures
  lightpool.js      fixed pool of transient dynamic lights
```

> The vendored `three.module.js` and `vendor/postfx/*` files are stock Three.js
> r160 addons with their import specifiers rewritten to relative paths, so the
> project runs with no bundler and no import map.

### How it fits together

`index.html` loads **`js/boot.js`**, not `main.js`. `boot.js` has no imports of
its own — a static import would have to be fetched before a single line of it
ran, so a broken module would take the page down with nothing installed to
catch it. Instead it installs `window.onerror` and `unhandledrejection`
handlers, probes for a WebGL context, and only then pulls the game in with a
dynamic `import()`. That try/catch is what turns the two failure modes this
project actually hits — no WebGL, and a stale module cache — into an on-screen
explanation instead of a blank page and something cryptic in the console.

`main.js` owns the state machine (`menu → playing ⇄ paused → gameover / victory`) and drives everything from a single `requestAnimationFrame` loop. Systems are decoupled and communicate through callbacks:

- The **weapon viewmodel** renders in a separate scene and overlay pass, so it can never clip through world geometry.
- **Enemy hitboxes** are invisible capsule and sphere meshes carrying a back-reference to the enemy. Raycasts hit those, which means headshots are a real geometric hitbox rather than a damage-roll.
- **Collision** uses axis-aligned boxes stored in `world.colliders`. `resolve()` pushes bodies out along the shallowest axis, and `groundHeight()` determines walkable surfaces.
- The **environment map** is generated procedurally in `env.js` and pre-filtered with PMREM. This matters: without it, every `metalness` surface renders near-black, because metals are lit almost entirely by reflections.

### Tuning the game

Nearly all balance lives in `js/config.js` — weapon damage, fire rates, magazine sizes, enemy health and speed, wave counts and mix, pickup rates, and scoring. Change values there without touching any logic.

---

## Performance notes

Quality adapts automatically. The main loop samples a rolling average frame time and steps the post-processing tier down (and back up) so the game stays responsive on weak hardware. You can pin a tier manually with the **QUALITY** button on the main menu.

| Tier | Bloom | Grain / scanlines | Pixel ratio |
|---|---|---|---|
| High | on | on | up to 2× |
| Medium | reduced | reduced | up to 2× |
| Low | off | off | 1× |

Other measures:

- Effects are pooled and reused — no per-shot allocations.
- The hitscan path uses preallocated scratch vectors and a cached world target list, so firing does not allocate per pellet.
- Projectiles use a fixed-size pool and drop shots rather than growing unbounded.
- Crosshair line-of-sight tests run at 20 Hz; the minimap redraws at 30 Hz.
- `dt` is clamped to 50 ms so a tab-switch can't tunnel bodies through walls.
- A single 2048² shadow map covers the arena.

### Frame-rate independence

Fire rates are specified in RPM, so they have to mean the same thing at 30 fps
and at 240. The fire path *adds* the interval to the cooldown rather than
assigning it, which lets the sub-frame remainder from the previous shot carry
into the next one. Assigning instead rounds every shot up to a whole number of
frames, which made the pulse rifle measure 720 RPM at 60 fps and 900 at 90 —
and because the adaptive quality system lowers frame rate on weak hardware,
that quietly cost the weakest machines the most damage per second. Measured
spread across 30–240 fps is now 1.1%.

Accumulating is only safe because the cooldown countdown in `Weapons.update()`
is gated on `> 0`, so an idle cooldown parks in `(-dt, 0]` and the banked
early-fire credit can never exceed a single frame. `sim_melee.py` asserts both
halves of that, so if either is changed the suite goes red.

---

## Development

This project has no Node dependency, so it ships with five static checkers that run under plain `python3`. Run all five after any multi-file change:

```bash
python3 tools/validate.py .          # bracket balance, import resolution,
                                     # bare specifiers, undefined this.x,
                                     # duplicate declarations
python3 tools/api_check.py .         # every this.obj.method() call resolves
                                     # to a method actually defined
python3 tools/smoke.py               # getElementById ids exist in index.html,
                                     # classList names exist in style.css,
                                     # CONFIG/KEYS lookups, weapon slots
python3 tools/sim_melee.py           # headless timing simulation: melee
                                     # windup, fire rate, auto-reload,
                                     # frame-rate independence
python3 tools/verify_rayblocked.py   # differential test proving the
                                     # line-of-sight slab rewrite is
                                     # behaviourally identical to the original
```

All five exit non-zero on failure, and they **do** run in CI: `.github/workflows/deploy.yml` has a `check` job that runs all five on every push to `main` *and* on every pull request, so a broken import is caught before merge rather than after. The `deploy` job declares `needs: check` and is skipped for pull requests, so a PR can never publish and a failing check blocks the live site. They exist because this project is written and edited without a browser or a JS runtime available — between them they catch the bugs that would otherwise only appear as a runtime `TypeError` (a stale method call, a missing DOM id, a bare `from 'three'` specifier, a config key read as `undefined`).

`sim_melee.py` and `verify_rayblocked.py` are worth calling out: they are the checks that cover *behaviour* rather than *structure*. The timing simulation caught a melee windup so short that no enemy in the game could physically dodge it, and the differential test guards an unrolled ray/AABB rewrite that would otherwise be very easy to get subtly wrong. If you rewrite either of those code paths, run the matching script.

Two limits are worth being explicit about, because they bound what these tools can tell you:

- **The simulations model the code, they do not execute it.** `sim_melee.py` reimplements `weapons.js` frame by frame, so it cannot see an edit to the real file. That is why it also asserts on the *source text* of the invariants it depends on — a one-character revert from `cooldown +=` back to `cooldown =` is invisible to the model, so the guard checks the file directly.
- **They are static, so they cannot know intent.** `validate.py` resolves `this.x` per file, which means a class extending a vendored three.js base looks like it reads fields it never writes. Rather than hardcode an allowlist, it parses the vendored classes and treats their members as inherited — so the check stays honest across a three.js upgrade instead of accumulating false positives you learn to ignore.

---

## Troubleshooting

**A red panel saying something failed** — the game reports its own start-up
failures. `js/boot.js` catches a missing WebGL context, a module that will not
load, and any uncaught error afterwards, and shows what actually went wrong
with a copyable stack trace instead of leaving a blank page. The three you are
most likely to hit:

- **"WebGL unavailable"** — hardware acceleration is off, or the GPU is
  blocklisted. The game is WebGL-only and has no 2D fallback.
- **"Failed to load resource"** — a module could not be fetched. You probably
  opened `index.html` directly; ES modules need HTTP.
- **"Failed to start the game"** — almost always a stale module cache; the
  message says so and the build stamp below confirms it.

**`Cannot read properties of undefined (reading 'someConfigKey')`** — a stale
module cache. Confirm by looking at the build stamp under the start button: it
should read `build N`. If the number does not change after a reload, the
browser is serving cached modules. Fix with `./serve.sh` (sends `no-store`),
a hard reload, or clearing site data in DevTools → Application → Storage.

**Blank screen / no HUD** — you almost certainly opened `index.html` directly. ES modules require HTTP; start a server as shown above. If the red panel did *not* appear and you are serving over HTTP, check the browser console — that path means `boot.js` itself failed to parse.

**Pointer lock doesn't engage** — some browsers restrict it to secure contexts and top-level documents. The game stays playable without it (it just won't capture the mouse); click the canvas to retry. Serving over `localhost` or HTTPS fixes it.

**No sound** — browsers require a user gesture before audio can start. Click **ENTER THE VOID** first. Press `M` to toggle mute.

---

## Deployment

The site is fully static (no build step), so it deploys to **GitHub Pages** as-is. The workflow in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) runs the five static checks in a `check` job and only publishes the repo root once they pass, on every push to `main`:

1. Push the repo to GitHub.
2. In the repository settings, set **Pages → Build and deployment → Source: GitHub Actions**.
3. The game will be live at `https://mheerspink75.github.io/void-runner/` after the first workflow run.

---

## License

[MIT](LICENSE) © 2026 matt_heerspink. Three.js (in `vendor/`) is also MIT-licensed, © Three.js authors.
