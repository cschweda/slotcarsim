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
} as const;
