// The authentic AFX track-piece catalog, as data. Straight lengths and curve
// radii/sweeps are exactly what a real AFX set ships; converting from the
// inches they're molded in keeps the catalog itself checkable against a ruler.
const IN = 0.0254;

export type PieceId =
  | 'straight15'
  | 'straight9'
  | 'straight6'
  | 'straight3'
  | 'curve6_90'
  | 'curve9_90'
  | 'curve12_90'
  | 'curve6_45'
  | 'curve9_45'
  | 'curve12_45';

export type PieceDef =
  | { kind: 'straight'; length: number } // meters
  | { kind: 'curve'; radius: number; sweep: number }; // centerline radius (m); sweep radians, always positive

/** dir is required for curves and forbidden for straights (enforced by buildTrack). */
export interface PieceRef {
  piece: PieceId;
  dir?: 'left' | 'right';
}

export const PIECES: Record<PieceId, PieceDef> = {
  straight15: { kind: 'straight', length: 15 * IN },
  straight9: { kind: 'straight', length: 9 * IN },
  straight6: { kind: 'straight', length: 6 * IN },
  straight3: { kind: 'straight', length: 3 * IN },

  curve6_90: { kind: 'curve', radius: 6 * IN, sweep: Math.PI / 2 },
  curve9_90: { kind: 'curve', radius: 9 * IN, sweep: Math.PI / 2 },
  curve12_90: { kind: 'curve', radius: 12 * IN, sweep: Math.PI / 2 },

  curve6_45: { kind: 'curve', radius: 6 * IN, sweep: Math.PI / 4 },
  curve9_45: { kind: 'curve', radius: 9 * IN, sweep: Math.PI / 4 },
  curve12_45: { kind: 'curve', radius: 12 * IN, sweep: Math.PI / 4 },
};

/** Total molded piece width (render-only — both lanes fit inside it). For M4. */
export const PIECE_WIDTH = 3 * IN;
