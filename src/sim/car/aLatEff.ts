// The ONE shared effective-lateral-demand model for banked corners (M12).
// BOTH the per-tick chassis grip model (car/cornering.ts) and the AI/coach
// steady-state speed profile (ai/speedProfile.ts) route their lateral-demand
// math through here, so the two are STRUCTURALLY incapable of diverging: a
// banked corner raises the deslot speed in exactly the same closed form the AI
// plans its line against.
//
// Pure — trig only, no rng/DOM/three. `bank` is signed per path.ts's
// convention (positive = surface tilts toward the turn center → assists), and
// on a flat, unbanked track (bank 0) every term below collapses to the raw
// pre-M12 expression BIT-for-BIT (Math.cos(0) === 1, Math.sin(0) === 0
// exactly), which is what keeps the flat-track regression contract exact.

/**
 * Effective lateral demand, in m/s²: `max(0, v²·|κ|·cos(bank) − G·sin(bank))`.
 *
 * The `cos(bank)` factor is the reduced in-plane lateral component on a tilted
 * surface; the `−G·sin(bank)` term is gravity helping hold the pin inward. The
 * `max(0, …)` encodes the slot itself holding the car: a slow car on a steep
 * bank does NOT slide inward (the surplus would just be reacted by the slot),
 * so the demand floors at zero rather than going negative. Downstream
 * filter/dwell/slide/scrub logic consumes this value unchanged.
 *
 * bank 0 ⇒ `max(0, v²·|κ|)` = `v²·|κ|` (the term is already ≥ 0), reproducing
 * the pre-M12 raw demand exactly.
 */
export function aLatEff(v: number, kappa: number, bank: number, gravity: number): number {
  return Math.max(0, v * v * Math.abs(kappa) * Math.cos(bank) - gravity * Math.sin(bank));
}

/**
 * The inverse: the speed at which `aLatEff` equals `aLatCap` — i.e. the closed
 * form `v_max = sqrt((aLatCap + G·sin(bank)) / (|κ|·cos(bank)))`. Passing
 * `gripHard` gives the banked deslot speed; passing `gripHard·margin` gives the
 * AI's corner cap. A straight (|κ|→0, bank 0) has an infinite cap (never
 * corner-limited). bank 0 ⇒ `sqrt(aLatCap / |κ|)`, the pre-M12 corner cap
 * exactly.
 */
export function maxCornerSpeed(aLatCap: number, kappa: number, bank: number, gravity: number): number {
  const denom = Math.abs(kappa) * Math.cos(bank);
  if (denom <= 0) return Infinity;
  return Math.sqrt(Math.max(0, aLatCap + gravity * Math.sin(bank)) / denom);
}
