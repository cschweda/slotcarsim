# Slot Car Racing Simulator — Aurora AFX — Design Document

**Date:** 2026-07-17 · **Status:** Approved · **Scope:** Proof of concept (v1)

## Context

A photorealistic, web-based simulator of 1970s Aurora AFX HO-scale slot car racing — the basement figure-eight, the pistol-grip trigger, the car that flies off when you overcook a corner. Nothing like it exists on the web. This is a proof of concept: solo time-trial plus a computer-controlled opponent in the other lane. Multiplayer (lobby, leaderboard) is explicitly future work, but v1's core architecture decision — a deterministic, pure simulation core — is what makes netcode possible later and cannot be retrofitted, so it is locked in now.

## Product decisions

- **View**: Three.js real-time 3D, fixed "standing at the table" camera (~60° down-angle). Not Phaser, not 2D canvas.
- **Input**: Gamepad API analog trigger (primary — closest to a real AFX pistol grip) + keyboard fallback (hold-to-ramp). Trigger release = hard dynamic braking (authentic — AFX controllers short the motor).
- **Modes**: Solo practice/time-trial + AI opponent (adjustable difficulty). No local 2P/network in v1, but input is abstracted per-player so nothing precludes it.
- **Tracks**: v1 = oval, then figure-eight. Assembled from authentic AFX track-piece primitives (standard straights, constant-radius curve sections), 2 lanes.
- **Cars**: 1970s Aurora AFX HO look (~3" long; 917-style, 512-style bodies), glossy paint, chrome, tinted canopy. Both plain-AFX and Magna-Traction grip models (differ only in grip constants).
- **Deslot**: exceed grip → tail slides/scrubs; past hard limit → car visibly tumbles off (canned ballistic), ~2 s total penalty, auto re-slot at exit point with v=0. AI keeps circulating.
- **Audio**: WebAudio, fully synthesized (no samples) — motor whine pitch-mapped to speed, stereo-panned by table position; two cars beat against each other.
- **Stack**: Vite + TypeScript (strict) + Three.js (pinned), vanilla DOM for UI. No framework, no physics engine (slot cars are 1-DOF-on-a-path; custom physics is smaller AND more authentic).
- **Deploy**: 100% static build → works on both Netlify (v1) and a DigitalOcean/Laravel Forge/nginx droplet (static site). No server in v1.

## Architecture

**One hard rule, mechanically enforced**: `src/sim/` + `src/config/` are pure TypeScript — no `three`, no DOM, no `Math.random()`, no `Date.now()`. A vitest test greps for forbidden imports and fails loudly. Dependency direction is one-way: `render/`, `audio/`, `ui/` consume sim state; sim imports nothing outside itself + config. Sim geometry is 2D plan-view meters (renderer lifts to 3D); dynamics in accelerations (mass folded out).

```
index.html  package.json  vite.config.ts (vitest inline)  tsconfig.json (strict)  netlify.toml
docs/                     — design docs
src/
  main.ts                 — bootstrap; loop.ts — fixed timestep 120 Hz, interp alpha, hidden-tab pause
  config/tuning.ts        — ALL physics constants (flat + per-car presets); config/tracks.ts — piece lists
  sim/                    — PURE (tests colocated)
    types.ts math.ts rng.ts (mulberry32) world.ts timing.ts
    track/pieces.ts builder.ts path.ts
    car/motor.ts cornering.ts deslot.ts car.ts
    ai/speedProfile.ts driver.ts
  input/types.ts gamepad.ts keyboard.ts inputManager.ts   — ThrottleSource per player (2P/net-ready)
  render/scene.ts environment.ts trackMesh.ts carMesh.ts carsView.ts debugView.ts (?debug)
  audio/engine.ts motorVoice.ts sfx.ts
  ui/hud.ts menus.ts debugPanel.ts (dev-only live tuning sliders)
```

## Physics model

- **Motor**: authentic resistor-divider controller curve, not linear: `V_eff = V·R_m/(R_m + R_c·(1−trigger))` (R_m≈15Ω armature, R_c≈60Ω controller) → the real "nothing…nothing…EVERYTHING" AFX response. Drive accel `a = A·V_eff − B·v − drag(v)`, semi-implicit Euler. Response setting: `authentic` (default) / `linear` (comfort) / `authentic-stepped` (quantized like the wirewound coil).
- **Brake**: trigger < 0.02 → dynamic brake `a = −(B_short·v + drag)`, B_short > B. `dv/ds` is constant → closed-form brake distance `(v0−v1)/B_short` (used by both unit tests and AI).
- **Cornering/deslot state machine**: lateral demand `v²·|κ(s)|` through a first-order filter (τ≈50 ms) — critical because curvature steps at piece joints; hard-limit dwell ≥40 ms before deslot (prevents spurious joint deslots). Gripped → sliding (yaw eases out around the front pin, speed scrubs) → deslot event → canned tumble (~1.1 s, seeded rng) → wait (~0.9 s) → reslot at exit s, v=0, generation counter bumped (renderer snaps instead of lerping the teleport).
- **Render orientation**: car body along the chord between `path(s)` (guide pin) and `path(s − wheelbase)` (rear axle) — physically what a pin-guided car does; smooths joints for free. Slide yaw pivots at the pin → tail swings out.
- **Magna-Traction**: constant additive grip budget (magnet downforce is speed-independent) — plain ≈8/11 m/s² soft/hard vs Magna ≈17/24.
- **Key tuning seeds** (live-tunable in debugPanel): lane offsets ±19.05 mm; straights 15/9/6/3 in; curve radii 6/9/12 in (45°/90° sweeps; catalog data lives in pieces.ts); car ~76 mm, wheelbase ~34 mm; vmax ≈3 m/s; B_short ≈8 s⁻¹. Sanity: 9" curve inner lane deslots plain cars ≈1.5 m/s → braking into corners is mandatory, laps ≈2–3 s. Authentic HO pace.

## Track geometry & timing

- Each piece contributes per-lane a line or circular arc; lanes compile to **independent LanePaths with their own s-coordinates** (inner lane is genuinely shorter — authentic; lane choice in menu; figure-eight re-equalizes lanes). Builder chains entry/exit poses, validates closure, throws with offending piece index. `s → {pos, heading, κ}` via binary search over exact arcs/lines (no polylines in sim).
- Mesh: sweep one authentic 2-lane cross-section (matte black roadbed, recessed slot grooves, raised steel rail strips, beveled edges) along piece paths; darker seam line at every piece joint (authentic lock-and-joiner look, hides tessellation). White snap-on guardrail modules (~30 mm with tiny gaps) on curve outsides. Merge static geometry → ~3 draw calls total. Figure-eight uses a 90° crossing square piece (two crossing slot/rail sets with rail gaps); sim doesn't care about self-intersection; car-vs-car crossing collisions = backlog.
- Lap timing: sub-tick crossing interpolation (laps are ~2 s; raw 8.3 ms ticks would jitter ~0.3% — interpolation gets <1 ms). Deslot preserves s so timing needs no special cases.

## Rendering (photoreal checklist)

Pinned three, ColorManagement on, `outputColorSpace = SRGBColorSpace`, ACES filmic tone mapping (exposure ~1.1); author AFX neon paints oversaturated (ACES desaturates — verified with M0 test spheres). **Biggest zero-asset photoreal lever**: `scene.environment` from RoomEnvironment via PMREMGenerator — makes clearcoat paint/chrome/canopy read as real. One warm shadow-casting SpotLight ("room lamp"), PCFSoft 2048/1024, frustum shrink-wrapped to the table; hemisphere fill casts nothing. No EffectComposer in v1 (keeps MSAA rails crisp, saves iGPU). Quality ladder on rolling frame time: DPR 2→1.5→1.25 → shadow 1024 → blob shadows. Procedural wood table + room vignette via CanvasTexture.

**Car bodies: procedural lofts with a glb-swappable seam.** `buildCarBody(styleId): THREE.Group` is the only API. Internals: ~15 Catmull-Rom-blended cross-section profiles (real AFX bodies are already chunky caricatures — lofts suit them), tinted transparent canopy, chrome pipes/wheels, CanvasTexture liveries (stripes, roundels). At table distance the photoreal read is ~60% materials/reflections, not panel lines. If the eyeball test fails → swap internals to a repo-committed hand-authored .glb, touching one file.

## Audio

AudioContext unlock: start menu dismissed by click/keypress (gamepad presses are NOT user activation in Chrome) — `ctx.resume()` inside that handler; statechange watchdog; suspend when hidden. Persistent per-car node graph driven by `setTargetAtTime` (no per-frame nodes, no zipper). Voice: triangle at `f0 = 120 + 520·(v/vmax)` Hz + square 3·f0 through bandpass (commutator buzz) + tracking-bandpass noise (brush hiss); gains shaped by throttle load; fixed ±1.5% per-car detune → two-car beat; StereoPanner by table x; master compressor.

## Input (gamepad gotchas)

Re-fetch `navigator.getGamepads()` every poll (Chrome snapshots vs Firefox live objects). Gamepads invisible until a button press → "squeeze the trigger" connect prompt. `mapping === "standard"` → `buttons[7].value` (RT); otherwise triggers are often axes resting at −1 → normalize `(v+1)/2`. Don't hardcode: calibration wizard (detect moved control, record rest/max, persist to localStorage by `gamepad.id`). Deadzone ~0.03. Disconnect mid-race → throttle 0 → full brake + toast. Keyboard: hold Space ramps ~2.5/s, release snaps to 0 (= brake). Poll once per rAF, hold constant across sim steps.

## Future work: multiplayer (not in v1)

v1 ships zero server code. What v1 protects: deterministic fixed-timestep sim (integer tick count), seeded rng, all inputs as per-tick `InputFrame` via per-player `ThrottleSource`, race orchestration decoupled from local input. Later, on the Forge droplet: Node WebSocket daemon (Forge daemon + nginx proxy) or Laravel Reverb for rooms/lobby/track+car selection; small API + DB for the leaderboard; the deterministic sim enables lockstep or ghost racing (time-trial ghosts are the cheapest first multiplayer feature). Backlog also includes: car-vs-car collisions at the figure-eight crossing, local 2-player, real AFX controller via WebSerial + microcontroller.

## Build milestones

| # | Milestone | Demo gate |
|---|---|---|
| M0 | Scaffold + look-dev: git init, Vite/TS/vitest, design doc, netlify.toml, loop.ts, scene.ts (ACES + RoomEnvironment), clearcoat + chrome test spheres | Spheres look "photo"; `npm test` green (purity test) |
| M1 | Track model + debug view: pieces/builder/path, oval, flat-ribbon debugView, dots orbiting both lanes | Closure validation throws on bad layout; path tests pass |
| M2 | Drive it: motor, world, timing, input (kb+gamepad), HUD lap times, debugPanel live sliders | Drive a marker with the trigger; tune accel/brake live |
| M3 | Cornering + deslot (sim complete): slide yaw, tumble-as-box, reslot | Overcook → slide, scrub, tumble, 2 s, reslot; no joint-boundary deslots |
| M4 | Photoreal track + environment: extruded track, rails, guardrails, seams, wood table, warm lighting, shadows, quality presets | A still frame reads as a photo |
| M5 | Cars: procedural 917/512-style lofts, liveries, chord pose, wheel spin, slide/tumble anim | Two cars circulating — screenshot-worthy |
| M6 | Audio: unlock flow, motor voices, beat, deslot clatter, lap beep | Whine tracks speed; two-car beat audible |
| M7 | AI + race mode + figure-eight: speed profile, PD driver with seeded humanization, menus, countdown/results, crossing piece | Full race vs AI on both tracks; AI occasionally deslots at low difficulty |
| M8 | Polish + perf: quality ladder, DPR clamp, calibration wizard, optional rumble, HUD polish | 60 fps on integrated GPU at medium preset |

## Testing

Deterministic, sim-only vitest suites. Motor: stepped top speed matches closed-form root; brake distance exact `(v0−v1)/B_short`. Path: oval closes to 1e−9; inner lane shorter by analytic `2π·d·turns`; C0/C1 at joints. Cornering: max no-slide speed = `sqrt(a_soft/κ)`; single-tick κ spike at a joint does NOT deslot (filter+dwell). Timing: constant-v lap = `L/v` to 1e−6. AI: profile ≤ corner caps, obeys `dv/ds ≥ −B_short`; 20 laps at difficulty 1.0 = zero deslots; fixed seed at 0.3 = exact deslot count. Determinism: scripted throttle trace + fixed seed → bit-identical runs; golden-lap snapshot guards physics drift. Purity: grep test for three/document/window/Math.random/Date.now in sim. trackMesh smoke: no NaNs.

## Deployment

- **Netlify**: `netlify.toml` — build `npm run build`, publish `dist/`. Pure static.
- **Forge/nginx droplet**: static site, nginx root → `dist/` (deploy script: `npm ci && npm run build`). No PHP needed for v1; the Laravel side only enters with the future leaderboard/lobby.
- Vite `base: './'` so the build works at any path.

## As-built deviations (2026-07-18)

Divergences between this doc and the shipped 0.1.0 build:

- **Brake model**: pure `a = −brakeK·v`, no drag term (not `−(B_short·v + drag)` as written above) — resolves that formula's internal contradiction (an added constant term would break the claimed constant `dv/ds`) and preserves the exact closed-form `dv/ds = −brakeK` both the unit tests and the AI's backward pass depend on (`src/sim/car/motor.ts`).
- **Shadows**: `PCFShadowMap`, not `PCFSoftShadowMap` — the latter is deprecated in the pinned three 0.185.1 and silently auto-downgrades to `PCFShadowMap` at runtime with a per-frame console warning; using it directly gives identical output with no warning (`src/render/scene.ts`).
- **AI driver**: feedforward + P only, no derivative term — the motor's own back-EMF already damps the control loop, and a raw D term on the hard-driving/braking motor produced per-tick bang-bang throttle instead of a clean line (`src/sim/ai/driver.ts`).
- **Magna-Traction**: descoped from v1 — `TUNING` is flat and both cars share the plain-AFX grip constants; Magna-Traction's reference values are left as comments for a future car-type selector (`src/config/tuning.ts`).
- **Track draw calls**: ≤5 merged buckets (roadbed, slots, rails, seams, guardrails), not "~3" as estimated above.
- **Figure-eight geometry**: uses one non-catalog 4.5″ adapter straight per lobe connector — geometrically forced, since catalog straights are all 3″ multiples and none can resolve the crossing's 4.5″ half-square offset.
- **Headless AI determinism pins**: use difficulty 0.35, not 0.3; physics drift is guarded by pinned deslot counts and lap-time bands rather than a golden-lap snapshot.
- **Gamepad disconnect**: surfaces as a HUD source-label change, not a toast.
- **Architecture additions** not in the file tree above: `src/game/race.ts` (the race state machine) and `src/ui/overlays.ts` (countdown/calibration overlay factories).
- **M12 — banked curves + elevation (the Daytona Sweep track)**: lateral demand on a banked piece is the effective `aLatEff = max(0, v²·|κ|·cos θ − G·sin θ)` (`G` = `TUNING.gravity` = 9.81), so the deslot speed is `v_max = sqrt((gripHard + G·sin θ)/(|κ|·cos θ))` — ~1.96 m/s at 30° on the 9″ inner lane vs ~1.52 flat. The `max(0, …)` is the slot holding the pin in: a slow car on a steep bank does not fall inward. Elevation adds a longitudinal `a += −G·(dz/ds)` term in the slot phase (drive and brake alike). Both live in ONE shared helper (`src/sim/car/aLatEff.ts`) consumed by both `car/cornering.ts` and `ai/speedProfile.ts`, so the deslot speed and the AI's planned line can never disagree. `bank?`/`rise?` ride on the `PieceRef` (per-use) rather than new catalog entries, keeping the 12-piece catalog (and its regression pin) intact; `pointAt` gains `bank`/`z`/`grade`, and closure validation extends to elevation (net rise 0 around the loop, a separate check so the pinned x/y/heading closure message is untouched). On bank 0 / grade 0 every term vanishes exactly (`cos 0 = 1`, `sin 0 = 0`), so every pre-M12 golden/headless pin passes bit-for-bit unchanged.
  - **Deliberate simplifications**: (1) `s` and `v` remain PLAN-VIEW projections — the surface is slightly longer than its plan projection by ~1/cos θ on a bank and ~1/cos(atan(grade)) on a grade, and that correction is intentionally ignored (the discrepancy is <0.5% at these angles and would complicate the exact closed-form brake law the AI depends on). (2) The AI's banked-corner cap applies its difficulty margin as a fractional SPEED discount off the true deslot speed (`× sqrt(margin)`, the exact flat ratio) rather than margining `gripHard` inside the root — because the un-margined `G·sin θ` assist term otherwise compresses the speed headroom on a bank (~2.5% vs 3.6% flat) and would trip the tight d=1.0 line at the apex; the flat branch is kept as the exact pre-M12 expression, so flat tracks are unchanged. (3) The mesh's bank ease-in/out is cosmetic only — the physics bank is constant per piece, and the chassis lateral filter smooths the on/off step (`src/render/trackMesh.ts`).
