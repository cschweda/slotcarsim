# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ROADMAP.md — post-POC direction (more tracks, multiplayer, Tyco TCR mode).
- Project scaffold: Vite + TypeScript (strict) + vitest, exact-pinned dependencies, Netlify static deploy config.
- Fixed-timestep accumulator loop (`src/loop.ts`), with hidden-tab-safe reset, built test-first.
- Sim/config purity guard (`src/sim/purity.test.ts`) mechanically enforcing that `src/sim/` and `src/config/` stay pure TypeScript, with no Three.js, DOM, or nondeterministic calls.
- Initial tuning constants (`src/config/tuning.ts`) and skeletal simulation types (`src/sim/types.ts`).
- Photoreal look-dev scene (`src/render/scene.ts`, `src/render/lookdev.ts`): ACES filmic tone mapping, `RoomEnvironment` image-based lighting, a warm shadow-casting key light, and clearcoat/chrome test spheres.
- Project design document (`docs/2026-07-17-slotcar-sim-design.md`).
- Pure 2D vector/angle math helpers (`src/sim/math.ts`): `Vec2`, `add`/`sub`/`scale`/`rot`/`len`/`dist`, `wrapAngle` (into `(−π, π]`), `clamp`, `lerp` — built test-first.
- Authentic AFX track-piece catalog (`src/sim/track/pieces.ts`): straights (15/9/6/3 in) and 90°/45° curves (6/9/12 in radius), converted from inches to meters.
- Track builder (`src/sim/track/builder.ts`, TDD): `buildTrack()` walks a `PieceRef[]` list into a closed, 2-lane `Track`, deriving each lane's exact line/arc segment from the signed lane offset (`+d` lane 0, `−d` lane 1) and validating closure (throws a descriptive error naming the gap, heading error, and piece count on a bad layout).
- Arc-length-parametrized lane path (`src/sim/track/path.ts`, TDD): `createLanePath()` gives exact `pointAt(s) → {pos, heading, curvature}` via binary search over precomputed segment lengths, with modulo wrapping for any real `s` (including negative).
- Classic oval track definition (`src/config/tracks.ts`): 2 straights + a 180° left corner, twice — centerline lap ≈2.96 m, inner lane ≈2.84 m.
- Flat debug track view (`src/render/debugView.ts`): per-lane ribbon (cyan/orange), grey piece-joint markers, and two dot meshes positioned per frame.
- `src/main.ts` now builds and displays the oval by default (ground plane + debug view + two dots orbiting their lanes at constant speed); the M0 look-dev spheres move behind a `?lookdev` query param.
- Authentic AFX resistor-controller motor model (`src/sim/car/motor.ts`, TDD): `effectiveVolts()` (authentic resistor-divider curve / linear / stepped-quantized response modes), `driveAccel()`, `brakeAccel()` (pure `−brakeK·v`, no drag term, so brake distance is the exact closed form `(v0−v1)/brakeK`), and `carAccel()`'s deadband switch between them.
- `TUNING` (`src/config/tuning.ts`) extended with the motor's full constant set (`supplyV`, `motorR`, `controllerR`, `accelPerVolt`, `backEmfK`, `rollingDrag`, `throttleDeadband`, `responseMode`, `steppedBands`, `keyboardRampRate`) plus a shared `Tuning` type every sim/input/ui module reads through — one mutable object, read fresh every step, so the dev tuning panel can change feel live.
- Sub-tick lap timing (`src/sim/timing.ts`, TDD): `createLapTimer()` interpolates the exact fractional-tick crossing time when a car's step wraps past `s=0`, so lap times aren't quantized to the ~8ms tick and stay accurate to 1e-6s for a constant-speed car regardless of dt phase.
- Deterministic `Sim` world (`src/sim/world.ts`, TDD): `createSim()` steps every car with semi-implicit Euler (`carAccel` → `v` → `s`), keeps one-step-behind `prevCarStates()` alongside `carStates()` for render interpolation, supports `constant`-controlled cars (the pace-car placeholder) that ignore input and hold their velocity exactly, and feeds each car's lap timer. Bit-identical across repeated runs of the same scripted input trace (`src/sim/determinism.test.ts`) — the property multiplayer/ghost-replay will build on later.
- `wrapLerp(a, b, alpha, L)` (`src/sim/math.ts`, TDD): interpolates a car's arc-length position by the shortest **forward** hop modulo the lane length, so render interpolation stays smooth through a lap-line wrap instead of lerping backward across most of the lap.
- `CarState` gains `lapCount`; new `SimEvent` type (`{type:'lap', carIndex, lapNumber, lapTimeSec}`) (`src/sim/types.ts`).
- Input abstraction (`src/input/`): `ThrottleSource` interface; `createKeyboardThrottle()` (hold Space/ArrowUp to ramp at `keyboardRampRate`/s, release snaps to 0 immediately, prevents default scrolling); `createGamepadThrottle()` (re-fetches `navigator.getGamepads()` every read — never caches a `Gamepad` reference — reads `buttons[7]` on a `standard` mapping or falls back to scanning buttons/axes on a non-standard one, with a 0.03 deadzone); `createInputManager()` (prefers a connected gamepad, falls through to keyboard — including the authentic "dropped controller full-brake" on a mid-race disconnect).
- HUD (`src/ui/hud.ts`): fixed top-left overlay — lap count, last/best lap times (3 decimals, `—` before the first lap), a vertical throttle bar, and the active input source.
- Dev tuning panel (`src/ui/debugPanel.ts`, dev-only or `?tune`): live-bound range sliders for the motor constants, a `responseMode` select, numeric `v`/throttle readouts, and a strip chart of the last ~4s of both.
- `src/main.ts` now drives the player car (lane 0) from `inputManager`, circulates a constant-velocity pace car (lane 1, 1.5 m/s), renders both via `wrapLerp`-interpolated positions between sim ticks, and wires lap events into the HUD; `?lookdev` behavior is unchanged.
