// Named track layouts, as ordered PieceRef lists for buildTrack(). This is
// the only place layouts live — v1 has just the oval; the figure-eight
// arrives in M7.
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
} as const;
