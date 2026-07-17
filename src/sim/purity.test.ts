// This file enforces the project's one hard architectural rule: src/sim/ and
// src/config/ are pure TypeScript with no three/DOM/nondeterminism. It is
// itself exempt from that rule in two ways: (1) it needs node:fs/node:path to
// walk the source tree, which is a test-time concern, not runtime sim code;
// (2) its own source necessarily contains the forbidden substrings below as
// literal pattern strings, which would otherwise flag itself as a false
// positive. It is excluded from the scan by filename, not by directory.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_PATTERNS = [
  `from 'three'`,
  `from "three"`,
  'document.',
  'window.',
  'Math.random',
  'Date.now',
];

const EXCLUDED_FILENAME = 'purity.test.ts';

const SIM_DIR = join(import.meta.dirname, '..', 'sim');
const CONFIG_DIR = join(import.meta.dirname, '..', 'config');

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && entry.name !== EXCLUDED_FILENAME) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('sim/config purity', () => {
  it('contains no three/DOM/nondeterminism references under src/sim or src/config', () => {
    const files = [...collectTsFiles(SIM_DIR), ...collectTsFiles(CONFIG_DIR)];

    // Sanity check the walk itself found something — an empty list would
    // make the assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (contents.includes(pattern)) {
          violations.push(`${file}: matched ${JSON.stringify(pattern)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
