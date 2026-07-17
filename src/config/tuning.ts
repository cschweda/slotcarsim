// Physics/tuning constants, consumed by later milestones (motor, cornering,
// AI). This is the ONLY place tuning numbers live. Kept minimal for M0 —
// later tasks extend this with per-car presets and track-piece data.
export const TUNING = {
  /** Top speed a car can reach, in m/s. */
  vmax: 3.0,
  /** Distance from track centerline to a lane's slot, in meters (19.05mm). */
  laneOffset: 0.01905,
  /** Dynamic (trigger-released) brake deceleration constant, in 1/s. */
  brakeK: 8,
};
