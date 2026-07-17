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
