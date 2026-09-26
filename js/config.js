/**
 * config.js — Central tuning values for VOID RUNNER.
 * Every gameplay number lives here so balance changes are one-file edits.
 */

export const CONFIG = {
  // Bumped whenever a module's shape changes. Surfaced in the HUD and on the
  // console so a browser holding a stale mix of cached ES modules is obvious
  // at a glance instead of surfacing as a baffling `undefined` key error.
  build: 9,
  world: {
    size: 120,            // arena is size x size, centered on origin
    wallHeight: 14,
    halfSize: 60,
    gravity: -26,         // units / s^2
  },

  player: {
    eyeHeight: 1.7,
    crouchEyeHeight: 0.95,
    radius: 0.42,
    walkSpeed: 9.5,
    sprintSpeed: 16.5,
    crouchSpeed: 4.4,
    airControl: 0.34,
    accel: 62,
    friction: 9.5,
    jumpVelocity: 9.6,
    maxHealth: 100,
    maxStamina: 100,
    staminaDrain: 22,
    staminaRegen: 17,
    staminaMinToSprint: 12,
    invulnTime: 0.4,
    coyoteTime: 0.12,

    // ---- Dash (Q) ----
    dashCost: 28,
    dashCooldown: 0.85,
    dashSpeed: 44,
    dashDuration: 0.17,
    dashIFrames: 0.24,
    dashFovKick: 12,

    // ---- Melee (F) ----
    meleeDamage: 55,
    meleeRange: 3.0,
    meleeArc: Math.PI * 0.55,   // half-angle of the swing cone
    meleeCooldown: 0.6,
    meleeStaminaCost: 14,
    meleeKnockback: 10,
    // Swing timing. `meleeHitPoint` is a fraction of the swing, not a raw
    // second count, so the two can never drift out of sync. The hit lands at
    // `meleeHitPoint * meleeSwing` after the swing starts.
    //
    // The windup is deliberately long enough to matter: at 0.14s a PHANTOM
    // (8.8 u/s) covers ~1.2u, so a swing started on a fleeing enemy at the
    // edge of range genuinely whiffs. This is what stops melee from being a
    // strictly-better close-range alternative to a 900 rpm hitscan gun — you
    // commit before you know whether you will connect.
    meleeSwing: 0.32,           // total duration of the swing animation
    meleeHitPoint: 0.44,        // normalized swing time when the hit lands
    meleeWindup: 0.14,          // seconds of anticipation before the hit
  },

  look: {
    sensitivity: 0.0021,
    pitchLimit: Math.PI / 2 - 0.02,
    // FOV widens with speed for a sense of momentum
    fovBase: 82,
    fovSprintBoost: 10,
    fovDashKick: 14,
  },

  weapons: {
    rifle: {
      id: 'rifle',
      name: 'PULSE RIFLE',
      damage: 26,
      headshotMul: 2.6,
      rpm: 900,                       // rounds per minute
      auto: true,
      magSize: 36,
      reserve: 270,
      maxReserve: 480,
      reloadTime: 1.45,
      spread: 0.0038,                 // radians, hip-fire
      spreadMoving: 0.014,
      range: 240,
      recoil: 0.0105,
      recoilRecover: 0.075,
      pierce: 0,
      muzzleColor: 0x9ff8ff,
      tracerColor: 0x7ff4ff,
      slot: 0,
    },
    scatter: {
      id: 'scatter',
      name: 'SCATTER CANNON',
      damage: 15,                     // per pellet
      headshotMul: 1.7,
      rpm: 84,
      auto: false,
      magSize: 10,
      reserve: 72,
      maxReserve: 120,
      reloadTime: 2.15,
      pellets: 9,
      spread: 0.062,
      spreadMoving: 0.072,
      range: 55,
      recoil: 0.045,
      recoilRecover: 0.14,
      muzzleColor: 0xffd27a,
      tracerColor: 0xffb347,
      slot: 1,
    },
    // ---- Third weapon: charge-and-pierce railgun ----
    railgun: {
      id: 'railgun',
      name: 'ARC LANCE',
      damage: 195,
      headshotMul: 1.9,
      rpm: 52,
      auto: false,
      magSize: 5,
      reserve: 34,
      maxReserve: 56,
      reloadTime: 2.5,
      chargeTime: 0.9,              // hold fire to charge
      spread: 0.0,
      spreadMoving: 0.004,
      range: 420,
      recoil: 0.08,
      recoilRecover: 0.16,
      pierce: 99,                   // passes through every enemy in the lane
      muzzleColor: 0xc9a6ff,
      tracerColor: 0xd7b4ff,
      slot: 2,
      isCharge: true,
    },
    // ---- Fourth weapon: lobbed proximity grenade ----
    // Deliberately not a hitscan weapon. `projectile` switches the fire path
    // from a raycast to a physical throw, which is what makes it a different
    // tool rather than a slower gun: it arcs over cover and needs lead, so it
    // rewards aiming at a cluster's feet rather than at the nearest target.
    grenade: {
      id: 'grenade',
      name: 'ARC LOBBER',
      damage: 135,                 // direct hit; splash falls off from here
      headshotMul: 1.0,             // no bonus — this is an AoE tool, not a sniper
      rpm: 96,
      auto: false,
      magSize: 4,
      reserve: 20,
      maxReserve: 40,
      reloadTime: 2.0,
      spread: 0.02,
      spreadMoving: 0.03,
      range: 60,
      recoil: 0.05,
      recoilRecover: 0.14,
      pierce: 0,
      muzzleColor: 0x7cff9b,
      tracerColor: 0x8dffb0,
      slot: 3,
      projectile: {
        speed: 26,
        radius: 0.18,
        color: 0x7cff9b,
        gravity: -20,
        life: 2.6,
        bounces: 2,
        // Detonates on contact with a surface, or when it has been alive for
        // `fuse` seconds — whichever happens first. The fuse guarantees the
        // grenade still blows even in open air, so a badly-thrown one is
        // never wasted.
        fuse: 2.0,
        blastRadius: 6.5,
        blastDamage: 120,
        // Fraction of blastDamage still applied at the outer edge.
        falloff: 0.25,
        knockback: 16,
      },
    },
  },

  enemies: {
    grunt: {
      id: 'grunt',
      name: 'HUSK',
      health: 78,
      speed: 4.6,
      damage: 10,
      attackRange: 2.0,
      attackCooldown: 1.15,
      score: 100,
      radius: 0.55,
      height: 1.85,
      color: 0x5b7a4a,
      emissive: 0x9dff5e,
      dropChance: 0.32,
      cost: 1,
    },
    brute: {
      id: 'brute',
      name: 'JUGGERNAUT',
      health: 300,
      speed: 3.3,
      damage: 24,
      attackRange: 2.4,
      attackCooldown: 1.7,
      score: 320,
      radius: 0.95,
      height: 2.6,
      color: 0x7a2f3a,
      emissive: 0xff5a3c,
      dropChance: 1.0,
      cost: 5,
    },
    stalker: {
      id: 'stalker',
      name: 'PHANTOM',
      health: 48,
      speed: 8.8,
      damage: 8,
      attackRange: 1.85,
      attackCooldown: 0.7,
      score: 175,
      radius: 0.45,
      height: 1.7,
      color: 0x2f3a7a,
      emissive: 0x7a5cff,
      dropChance: 0.45,
      cost: 2,
    },
    // ---- Ranged archetype: kites the player and fires projectiles ----
    spitter: {
      id: 'spitter',
      name: 'SPITTER',
      health: 115,
      speed: 4.0,
      damage: 17,
      attackRange: 30,          // prefers to keep this far away
      minRange: 9,               // backs off if the player closes in
      attackCooldown: 2.3,
      score: 225,
      radius: 0.62,
      height: 2.0,
      color: 0x5a4a7a,
      emissive: 0xffd24a,
      dropChance: 0.55,
      cost: 3,
      ranged: true,
      projectile: {
        speed: 28,
        damage: 17,
        radius: 0.3,
        color: 0xffd24a,
        gravity: -7,
        life: 4,
      },
    },
  },

  waves: {
    total: 10,
    baseCount: 5,
    countGrowth: 2.4,
    breakTime: 5.5,
    maxAlive: 18,
    // ---- Per-wave resupply ----
    // Refills a fraction of each weapon's magazine at the start of every wave
    // (0.3 = 30% of a mag, per weapon). This is the safety net that stops a
    // long run from becoming unwinnable purely on attrition, while staying
    // small enough that scavenged ammo pickups still matter — a full wave
    // should not leave you topped up if you were nearly out.
    resupplyMagFraction: 0.3,
    // Resupply also tops the reserve pool up to at least this fraction of
    // `maxReserve`, so a single bad stretch cannot spiral into a dead run.
    resupplyReserveFloor: 0.25,
    // Per-wave difficulty ramp applied to enemy stats
    healthScale: 0.13,     // +13% enemy health per wave
    speedScale: 0.02,      // +2% enemy speed per wave
    mix: {
      grunt: 1.0,
      stalker: 0.0,
      brute: 0.0,
      spitter: 0.0,
    },
  },

  pickups: {
    healthAmount: 38,
    healthMax: 100,
    ammoAmount: 45,
    staminaAmount: 45,
    overdriveDuration: 9,        // seconds of boosted damage + fire rate
    overdriveMultiplier: 1.5,
    lifetime: 30,
    bobSpeed: 2.2,
    bobHeight: 0.22,
    spinSpeed: 1.4,
    magnetRadius: 2.8,           // pickups fly to the player within range
  },

  scoring: {
    headshotBonus: 60,
    waveClearBonus: 300,
    comboMax: 10,
    comboWindow: 2.8,
    killMultiplierStep: 0.18,
  },

  // ---- Screen-space combat feedback ----
  feel: {
    hitstopLight: 0.026,     // on any hit
    hitstopCrit: 0.075,      // headshot
    hitstopKill: 0.11,       // on kill
    shakeLight: 0.16,
    shakeCrit: 0.34,
    shakeKill: 0.55,
    shakeHurt: 0.7,
  },

  // ---- Viewmodel / player animation blending ----
  // Every one of these is a `damp` lambda (higher = snappier). They are
  // centralised so a weapon can be given a distinct feel without touching
  // the animation code. The pattern everywhere is a critically-damped
  // follow of a *target* pose, never a direct assignment — direct writes are
  // what cause visible snapping when a state changes mid-frame.
  anim: {
    // Sway lags behind the camera, giving weight to fast mouse turns.
    swayVelocityGain: 2.2,
    swayDamp: 9,
    swayReturn: 12,
    swayMaxX: 0.06,
    swayMaxY: 0.05,
    // Sprint tilt, the lower/faster blend.
    sprintDamp: 8,
    sprintBobDamp: 14,
    // Recoil: fast attack, slower recovery. The split is what makes a shot
    // read as a punch instead of a nudge.
    recoilDamp: 11,
    recoilRotDamp: 10,
    // Weapon swap / lower.
    swapDamp: 16,
    // Landing impact dip.
    landDamp: 18,
  },
};

export const KEYS = {
  forward:   ['KeyW', 'ArrowUp'],
  back:      ['KeyS', 'ArrowDown'],
  left:      ['KeyA', 'ArrowLeft'],
  right:     ['KeyD', 'ArrowRight'],
  jump:      ['Space'],
  sprint:    ['ShiftLeft', 'ShiftRight'],
  crouch:    ['ControlLeft', 'ControlRight', 'KeyC'],
  reload:    ['KeyR'],
  dash:      ['KeyQ'],
  melee:     ['KeyF'],
  slot1:     ['Digit1'],
  slot2:     ['Digit2'],
  slot3:     ['Digit3'],
  mute:      ['KeyM'],
  pause:     ['Escape'],
};
