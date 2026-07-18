// The authentic AFX track-piece catalog, as data. Straight lengths and curve
// radii/sweeps are exactly what a real AFX set ships; converting from the
// inches they're molded in keeps the catalog itself checkable against a ruler.
const IN = 0.0254;

export type PieceId =
  | 'straight15'
  | 'straight9'
  | 'straight6'
  | 'straight3'
  | 'straight4half'
  | 'curve6_90'
  | 'curve9_90'
  | 'curve12_90'
  | 'curve6_45'
  | 'curve9_45'
  | 'curve12_45'
  | 'cross9';

export type PieceDef =
  // meters. `crossing` marks the criss-cross square: a straight-through
  // traversal (heading unchanged, lanes at their offsets) whose physical piece
  // is one 9" square carrying TWO perpendicular molded routes — a figure-8
  // traverses it twice per lap (once each way), and the renderer dedupes the
  // two traversals into a single shared square.
  | { kind: 'straight'; length: number; crossing?: boolean }
  | { kind: 'curve'; radius: number; sweep: number }; // centerline radius (m); sweep radians, always positive

/** dir is required for curves and forbidden for straights (enforced by buildTrack). */
export interface PieceRef {
  piece: PieceId;
  dir?: 'left' | 'right';
  /**
   * M12 banking: surface bank magnitude in radians (always ≥ 0; applied banking
   * INTO the turn, sign derived from `dir`). Curves only — forbidden on a
   * straight (enforced by buildTrack, same as `dir`). Carried on the ref
   * (per-use), not the PieceDef, because the same catalog curve — e.g.
   * curve9_90 — is used UNBANKED by the oval/figure-8 and banked only by the
   * Daytona Sweep; baking a bank into its def would tilt every use.
   */
  bank?: number;
  /**
   * M12 elevation: total centerline elevation change over this piece, in meters
   * (linear ramp; +up, −down, absent/0 = flat). Valid on straights and curves.
   * Per-use for the same reason as `bank`: the catalog straights double as flat
   * pieces everywhere else, so an AFX "riser" is just an ordinary straight used
   * with a rise here (keeps the 12-piece catalog — and its regression pin —
   * intact, rather than adding straight9_up/… catalog entries).
   */
  rise?: number;
}

export const PIECES: Record<PieceId, PieceDef> = {
  straight15: { kind: 'straight', length: 15 * IN },
  straight9: { kind: 'straight', length: 9 * IN },
  straight6: { kind: 'straight', length: 6 * IN },
  straight3: { kind: 'straight', length: 3 * IN },
  // 4.5" = exactly half the 9" square. The figure-8 crossing connector: it is
  // the offset that places the two cross9 traversals' centers exactly on the
  // same point (see config/tracks.ts's figure8). No standard AFX straight
  // length hits that half-square offset — an exhaustive piece search confirms
  // no all-standard composition brings the two crossings within 1 mm — so this
  // one non-catalog filler is what makes an exactly-closing single-square
  // criss-cross geometrically possible.
  straight4half: { kind: 'straight', length: 4.5 * IN },

  curve6_90: { kind: 'curve', radius: 6 * IN, sweep: Math.PI / 2 },
  curve9_90: { kind: 'curve', radius: 9 * IN, sweep: Math.PI / 2 },
  curve12_90: { kind: 'curve', radius: 12 * IN, sweep: Math.PI / 2 },

  curve6_45: { kind: 'curve', radius: 6 * IN, sweep: Math.PI / 4 },
  curve9_45: { kind: 'curve', radius: 9 * IN, sweep: Math.PI / 4 },
  curve12_45: { kind: 'curve', radius: 12 * IN, sweep: Math.PI / 4 },

  // The AFX criss-cross square: a 9" straight-through traversal flagged as a
  // crossing (see PieceDef). Figure-8 layouts use it twice.
  cross9: { kind: 'straight', length: 9 * IN, crossing: true },
};

/** Total molded piece width (render-only — both lanes fit inside it). For M4. */
export const PIECE_WIDTH = 3 * IN;
