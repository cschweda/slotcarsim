// Sound on/off preference, persisted to localStorage. Defaults OFF: any
// missing, corrupt, or unrecognized stored value reads back as false — the
// only value that reads as true is the exact string this module itself
// writes for "on". Same defensive localStorage pattern as
// input/gamepad.ts's calibration storage (typeof-guarded, try/catch): a
// private-mode/quota/inaccessible localStorage just means sound stays off
// rather than throwing.
const SOUND_PREF_KEY = 'afx-sound';

/**
 * True only when the stored value is exactly 'on'. Missing, 'off', or any
 * other/garbage value all read as false — the default-off requirement.
 */
export function loadSoundPref(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(SOUND_PREF_KEY) === 'on';
  } catch {
    return false; // private-mode/quota/inaccessible storage — default to off
  }
}

/** Persists the sound preference as the literal string 'on' or 'off'. */
export function saveSoundPref(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SOUND_PREF_KEY, on ? 'on' : 'off');
  } catch {
    // private-mode/quota — the preference just won't persist past this session
  }
}
