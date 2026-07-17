# AFX Slot Car Simulator

A photorealistic, browser-based simulation of 1970s Aurora AFX HO-scale slot car racing — the basement figure-eight, the pistol-grip trigger, the car that flies off when you overcook a corner. This is a proof of concept: solo time-trial play plus a computer-controlled opponent, built on Three.js with a custom deterministic physics core (no physics engine — slot cars are 1-DOF-on-a-path). Ships as a fully static build.

## Features

**Current (M0 — scaffold + look-dev)**

- Vite + TypeScript (strict) + vitest project scaffold, deployable as a static site.
- Fixed-timestep simulation loop (120 Hz) with hidden-tab-safe pause/resume.
- A photoreal rendering pipeline proof: ACES filmic tone mapping, image-based lighting from a room environment map, and clearcoat/chrome test materials under a warm key light.
- A mechanically-enforced architecture rule: the simulation core (`src/sim/`, `src/config/`) is pure TypeScript, guarded by a test that fails if it ever imports Three.js, touches the DOM, or calls `Math.random`/`Date.now`.

**Planned**

- Track model (oval, then figure-eight) built from authentic AFX track-piece primitives, with two independent lanes.
- Drivable cars: authentic AFX motor/brake response curve, cornering and deslot physics (slide, tumble, re-slot).
- Procedural 1970s AFX-style car bodies, liveries, chrome, tinted canopies.
- Fully synthesized WebAudio motor sound (no samples), pitch-mapped to speed.
- An AI opponent with adjustable difficulty, and a full race mode with lap timing.
- Gamepad (analog trigger) and keyboard input.

This is a proof of concept, not a finished game — most of the above is not yet built. See the [design doc](docs/2026-07-17-slotcar-sim-design.md) for the full architecture and milestone plan, and [ROADMAP.md](ROADMAP.md) for post-POC direction.

## Requirements

- Node.js 22 (see `.nvmrc`)

## Getting started

```bash
npm install
npm run dev
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck, then build for production (`dist/`) |
| `npm run preview` | Preview the production build locally |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run typecheck` | Typecheck without emitting output |

## Architecture

The simulation core is pure, deterministic TypeScript (`src/sim/`, driven by constants in `src/config/`) with no dependency on Three.js, the DOM, or non-determinism; rendering (`src/render/`), audio, and UI all consume sim state one-way, never the reverse. See [`docs/2026-07-17-slotcar-sim-design.md`](docs/2026-07-17-slotcar-sim-design.md) for the full design.

## Deployment

100% static build — no server required.

- **Netlify**: configured via `netlify.toml` (`npm run build`, publishes `dist/`).
- **Any static host** (e.g. nginx): run `npm run build` and point the web root at `dist/`.

## License

MIT — see [LICENSE](LICENSE).
