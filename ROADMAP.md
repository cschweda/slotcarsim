# Roadmap

The proof-of-concept scope (milestones M0–M8 in [`docs/2026-07-17-slotcar-sim-design.md`](docs/2026-07-17-slotcar-sim-design.md)) ships first as a complete solo time-trial and AI opponent experience. Everything below is post-POC, roughly prioritized.

## More pre-made track layouts

The track system is already data-driven: each layout is simply an ordered list of authentic AFX piece primitives in `src/config/tracks.ts` that forms a closed loop. New layouts require zero engine work — just add piece references to the existing catalog. Expansion opportunities:

- Larger ovals and road courses, using the full palette: 45° curves (in addition to current 90°), 6"/9"/12" radii combinations, longer straights (15"/9"/6"/3").
- Chicane and slalom sequences (alternating left-right curves) that players recognize from real AFX sets and YouTube nostalgia clips.
- Classic track shapes: the "Grand Stand" or "Drag Strip" figure-eight variants, the lane-crossing bridge (renderred as an elevated pass-under).

## Multiplayer

Architecture is already ready: the deterministic, fixed-timestep simulation core, seeded RNG, and per-player throttle abstraction (`ThrottleSource` per `InputFrame`) make netcode feasible without retrofitting.

- **Cheapest first step**: time-trial ghost racing — throttle trace replay as an opponent ghost, no server needed.
- **Server infrastructure** (on the existing Laravel Forge droplet): Node WebSocket daemon (or Laravel Reverb) for lobby, track/car selection, and live race coordination.
- **Leaderboard API + database**: persist best times and per-player stats.
- **Lockstep or eventual-consistency play** as latency allows.

## Tyco TCR mode (lane-changing slotless racing)

A new game mode where cars can steer between lanes to pass and block, like classic Tyco/Ideal TCR sets. Aurora stayed in the slot — this mode is an explicit homage to the competitive chaos of TCR.

- **Core mechanic**: instead of one fixed `LanePath`, cars gain a lane-selection state and a steer input in the per-tick `InputFrame`.
- **Transition geometry**: new piece types (diagonal segments) connect adjacent lanes, allowing smooth lane changes without the current mandatory lane commit.
- **Determinism preserved**: steer input is just another per-player frame input; the deterministic sim core is untouched.
- **AI adaptation**: speed profile and driver PD tuning would need TCR-aware parameters (aggressive passing, gap recognition), but the architecture already separates those constants.

## Other backlog

- **Local 2-player**: input is already per-player; only UI and a second gamepad/keyboard binding remain.
- **Car-vs-car collision** at the figure-eight crossing (where slot paths intersect).
- **Real AFX controller interface** via WebSerial + microcontroller firmware (authenticate a physical Tomy trigger as the throttle input).
- **Additional car body styles**: cosmetic variations (Magna-Traction models, non-AFX licensed designs if legal) and livery customization.
- **Accessibility**: keyboard-only modes, visual/audio cues for deslot/lap events, remappable controls.
