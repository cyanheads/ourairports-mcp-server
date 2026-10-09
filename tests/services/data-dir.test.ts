/**
 * @fileoverview Tests for resolveBundledDataDir — the walk up from the module to
 * the nearest ancestor holding both package.json and data/, and the
 * `<cwd>/data` fallback when no ancestor qualifies.
 * @module tests/services/data-dir.test
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ exists: (_path: string): boolean => false }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: string) => fs.exists(path) };
});

const { resolveBundledDataDir } = await import('@/services/airport-data/data-dir.js');

const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

afterEach(() => {
  fs.exists = () => false;
});

describe('resolveBundledDataDir', () => {
  it('returns data/ of the nearest ancestor holding package.json and data/', () => {
    const present = new Set([join(repoRoot, 'package.json'), join(repoRoot, 'data')]);
    fs.exists = (path) => present.has(path);

    expect(resolveBundledDataDir()).toBe(join(repoRoot, 'data'));
  });

  it('skips an ancestor with package.json but no data/', () => {
    fs.exists = (path) => path.endsWith('package.json');

    expect(resolveBundledDataDir()).toBe(join(process.cwd(), 'data'));
  });

  it('falls back to <cwd>/data when the walk reaches the filesystem root', () => {
    expect(resolveBundledDataDir()).toBe(join(process.cwd(), 'data'));
  });
});
