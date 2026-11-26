/**
 * @fileoverview The bundled data's provenance record, `snapshot.json`, kept beside
 * the six CSVs: which OurAirports mirror deploy they came from and when this build
 * fetched them. `scripts/build-data.ts` writes and `--check`s it; the airport-data
 * service reads it at setup(). Imports zod directly rather than the framework
 * barrel because the build script shares this module.
 * @module src/services/airport-data/snapshot
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const SNAPSHOT_FILE = 'snapshot.json';

const SnapshotSchema = z.object({
  /** The mirror the CSVs were downloaded from. */
  source: z.string().min(1),
  /** The mirror's `Last-Modified` (its deploy time), shared by all six files. Dates the content. */
  sourceLastModified: z.iso.datetime(),
  /** The build clock when the fetch ran. Dates this artifact, not the data. */
  fetchedAt: z.iso.datetime(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * Read and validate `<dataDir>/snapshot.json`. Resolves `undefined` when the file
 * is absent (a data drop without one); throws naming the file when it cannot be
 * read or is not a valid record.
 */
export async function readSnapshot(dataDir: string): Promise<Snapshot | undefined> {
  const path = join(dataDir, SNAPSHOT_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Could not read the data snapshot record ${path}.`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON.`, { cause: err });
  }
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${path} is not a valid data snapshot record: expected source, plus sourceLastModified and fetchedAt as ISO 8601 UTC timestamps.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
