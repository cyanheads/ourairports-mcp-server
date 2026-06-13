/**
 * @fileoverview Resolves the bundled `data/` directory holding the six
 * OurAirports CSVs. The data ships at the package root (alongside `dist/`, see
 * package.json `files`), so at runtime — whether running from source via Bun or
 * from compiled `dist/` — we walk up from this module's location to the nearest
 * directory containing both `package.json` and a `data/` folder.
 *
 * An explicit `OURAIRPORTS_DATA_DIR` override (resolved by the caller) always
 * wins; this helper supplies the default.
 * @module src/services/airport-data/data-dir
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from this module toward the filesystem root, returning the first
 * ancestor that contains a `data/` directory next to a `package.json`. Falls
 * back to `<cwd>/data` if no such ancestor is found (dev convenience).
 */
export function resolveBundledDataDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded walk — repo/package nesting never approaches this depth.
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'data'))) {
      return join(dir, 'data');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'data');
}
