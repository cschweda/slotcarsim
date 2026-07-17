# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
