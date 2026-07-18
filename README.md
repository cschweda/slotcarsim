# AFX Slot Car Simulator

A photorealistic, browser-based simulation of 1970s Aurora AFX HO-scale slot car racing — the basement figure-eight, the pistol-grip trigger, the car that flies off when you overcook a corner. This is a proof of concept: solo time-trial play plus a computer-controlled opponent, built on Three.js with a custom deterministic physics core (no physics engine — slot cars are 1-DOF-on-a-path). Ships as a fully static build.

## Features

- Two track layouts — Classic Oval and a criss-cross Figure Eight — built from authentic AFX track-piece primitives, with two independent lanes.
- Drivable cars: authentic AFX motor/brake response curve, cornering and deslot physics (slide, tumble, re-slot), procedural 1970s AFX-style bodies, liveries, chrome, and tinted canopies.
- Fully synthesized WebAudio motor sound (no samples), pitch-mapped to speed.
- An AI opponent with adjustable difficulty, and a full race mode with lap timing (plus a solo Time Trial mode).
- Gamepad (analog trigger, with an auto-calibration wizard and rumble) and keyboard input — see [Controls](#controls) below.
- A photoreal rendering pipeline: ACES filmic tone mapping, image-based lighting from a room environment map, a warm key light, and an auto quality ladder that steps rendering quality down under sustained load and back up once it recovers.
- Fixed-timestep (120 Hz) deterministic simulation core with hidden-tab-safe pause/resume.
- A mechanically-enforced architecture rule: the simulation core (`src/sim/`, `src/config/`) is pure TypeScript, guarded by a test that fails if it ever imports Three.js, touches the DOM, or calls `Math.random`/`Date.now`.

This is a proof of concept, not a finished commercial game. See the [design doc](docs/2026-07-17-slotcar-sim-design.md) for the full architecture and milestone plan, and [ROADMAP.md](ROADMAP.md) for post-POC direction.

| Classic Oval | Figure Eight |
| --- | --- |
| ![Classic Oval](docs/img/oval.jpg) | ![Figure Eight](docs/img/figure8.jpg) |

## Controls

- **Gamepad** (preferred whenever one is connected): the analog trigger is throttle. The first time an unfamiliar controller is used, a 5-second calibration wizard runs automatically ("SQUEEZE AND RELEASE THE TRIGGER") to find and measure its active control; the result is remembered (`localStorage`) so it only happens once per controller. Force a re-run with `?calibrate`. Deslotting gives a strong rumble pulse and reslotting a light one, on gamepads that support it.
- **Keyboard** (fallback, always available): `Space` or `↑` is throttle — hold to ramp up like squeezing a trigger, release to brake instantly.
- **Sound** — off by default. A persistent `SOUND: ON`/`SOUND: OFF` button in the top-right corner (visible in every screen after the start gate) toggles it; `M` is the keyboard shortcut and always stays in sync with the button. The choice is remembered (`localStorage`) across reloads.
- **Mouse wheel** — zoom the track view in/out (trackpad pinch works too). Resets to the fitted default on every race/track rebuild.
- **`Esc`** — abort the current race and return to the menu.
- Menus: `↑`/`↓` choose a row, `←`/`→` change its value, `Enter` confirm/start.

## Modes

- **Race vs AI** — first to 5 laps against a computer opponent (Easy/Medium/Hard), on the Classic Oval or the criss-cross Figure Eight.
- **Time Trial** — solo, unlimited laps, tracking your best lap time.

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
