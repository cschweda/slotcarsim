// @vitest-environment jsdom
//
// jsdom is needed here (vitest's project-wide default environment is 'node'
// — see vite.config.ts) purely for a real `localStorage`; soundPref.ts has
// no other DOM dependency.
import { beforeEach, describe, expect, it } from 'vitest';
import { loadSoundPref, saveSoundPref } from './soundPref';

const KEY = 'afx-sound';

describe('loadSoundPref', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to false when the key is missing', () => {
    expect(loadSoundPref()).toBe(false);
  });

  it('reads true for the exact stored value "on"', () => {
    localStorage.setItem(KEY, 'on');
    expect(loadSoundPref()).toBe(true);
  });

  it('reads false for the stored value "off"', () => {
    localStorage.setItem(KEY, 'off');
    expect(loadSoundPref()).toBe(false);
  });

  it('reads false for any other/garbage value — the default-off requirement', () => {
    for (const garbage of ['true', '1', 'ON', 'On', '', 'null', '{}']) {
      localStorage.setItem(KEY, garbage);
      expect(loadSoundPref()).toBe(false);
    }
  });
});

describe('saveSoundPref', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips true -> "on" -> loadSoundPref() true', () => {
    saveSoundPref(true);
    expect(localStorage.getItem(KEY)).toBe('on');
    expect(loadSoundPref()).toBe(true);
  });

  it('round-trips false -> "off" -> loadSoundPref() false', () => {
    saveSoundPref(false);
    expect(localStorage.getItem(KEY)).toBe('off');
    expect(loadSoundPref()).toBe(false);
  });
});
