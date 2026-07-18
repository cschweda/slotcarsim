// Named track layouts, as ordered PieceRef lists for buildTrack(). This is
// the only place layouts live — the oval and the classic criss-cross figure-8.
import type { PieceRef } from '../sim/track/pieces';

export const TRACKS = {
  oval: {
    name: 'Classic Oval',
    // Counterclockwise: two straights, a 180° left corner (two 90° pieces),
    // two straights, a second 180° left corner. Centerline lap ≈ 2.96 m;
    // lane 0 (inner) ≈ 2.84 m.
    refs: [
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
    ] satisfies PieceRef[],
  },
  figure8: {
    name: 'Figure Eight',
    // Classic criss-cross figure-8. One physical 9" crossing square, traversed
    // twice per lap perpendicular to itself (the two `cross9` entries below).
    // Between them, a 3/4-circle lobe (three 9" curves) turning one way, then
    // the mirror lobe turning the other — so the track self-crosses once and
    // each lane is inner on one lobe / outer on the other (lane lengths equal).
    //
    // The 4.5" (half-square) connectors on each side of a lobe are what land
    // the second cross9's center EXACTLY on the first's: cross9 exit is +4.5"
    // past the square center, the lobe's net transform is {+90°, (−4.5,−4.5)},
    // and 4.5 + (3×curve9_90) + 4.5 realizes exactly that — closing the loop
    // to machine epsilon with the two crossings coincident and 90° apart.
    refs: [
      { piece: 'cross9' },
      { piece: 'straight4half' },
      { piece: 'curve9_90', dir: 'right' },
      { piece: 'curve9_90', dir: 'right' },
      { piece: 'curve9_90', dir: 'right' },
      { piece: 'straight4half' },
      { piece: 'cross9' },
      { piece: 'straight4half' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'curve9_90', dir: 'left' },
      { piece: 'straight4half' },
    ] satisfies PieceRef[],
  },
  daytonaSweep: {
    name: 'Daytona Sweep',
    // A speedway: an oval with BOTH 180° ends banked 30° (0.5236 rad) into the
    // turn, and a back stretch that climbs over an elevated bridge and returns.
    // Plan-view it is a 48"-straight oval (both long straights 48" so it closes
    // in x/y exactly like the classic oval, just longer for a faster-feeling
    // ~3.87 m lap); banking is a cross-section roll that leaves the centerline
    // geometry untouched, and the bridge's rise nets to 0 around the loop.
    //
    // Both ends turn the SAME way (left) — a real speedway — so the inner lane
    // (lane 0) is genuinely shorter/faster, an authentic inner-lane advantage
    // (noted in the menu's lane labels and the README).
    //
    // Banking raises the deslot speed at each end from ~1.52 m/s (flat 9" inner
    // lane) to ~1.96 m/s, so full throttle survives the ends that would spit a
    // car off the flat oval; the downhill into the second banked end is where
    // the AI/coach must brake early (the grade term in the speed profile).
    refs: [
      // Front straight (flat), 48".
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'straight9' },
      { piece: 'straight9' },
      // Banked 180° end.
      { piece: 'curve9_90', dir: 'left', bank: 0.5236 },
      { piece: 'curve9_90', dir: 'left', bank: 0.5236 },
      // Back stretch, 48": ramp up (¾"), elevated plateau (flat at +19 mm),
      // ramp down (¾") — net rise 0, but the whole loop is validated in z.
      { piece: 'straight9', rise: 0.019 },
      { piece: 'straight15' },
      { piece: 'straight15' },
      { piece: 'straight9', rise: -0.019 },
      // Second banked 180° end.
      { piece: 'curve9_90', dir: 'left', bank: 0.5236 },
      { piece: 'curve9_90', dir: 'left', bank: 0.5236 },
    ] satisfies PieceRef[],
  },
} as const;
