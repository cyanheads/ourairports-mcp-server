/**
 * @fileoverview The bundled snapshot record (`data/snapshot.json`): what counts as
 * valid, and how the airport-data service loads it, exposes `dataAsOf`, and logs it.
 * @module tests/services/snapshot.test
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirportDataService } from '@/services/airport-data/airport-data-service.js';
import { forEachRow, int } from '@/services/airport-data/csv.js';
import { readSnapshot } from '@/services/airport-data/snapshot.js';
import { FIXTURE_DATA_DIR } from '../fixtures/load.js';

const SNAPSHOT = {
  source: 'https://davidmegginson.github.io/ourairports-data/',
  sourceLastModified: '2026-11-25T02:53:49.000Z',
  fetchedAt: '2026-11-26T01:04:17.000Z',
};

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of the fixture data whose snapshot.json holds `snapshot` (null removes the file). */
async function dataDir(snapshot: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ourairports-snapshot-'));
  dirs.push(dir);
  await cp(FIXTURE_DATA_DIR, dir, { recursive: true });
  if (snapshot === null) await rm(join(dir, 'snapshot.json'));
  else await writeFile(join(dir, 'snapshot.json'), snapshot);
  return dir;
}

/** Load a service over `dir` and return it with the context of its index-load log line. */
async function loadAndLog(dir: string) {
  const info = vi.spyOn(logger, 'info');
  const svc = new AirportDataService(dir);
  await svc.load();
  const call = info.mock.calls.find(([message]) => message === 'airport-data indices built');
  return { svc, extra: (call?.[1] as { extra?: Record<string, unknown> } | undefined)?.extra };
}

describe('readSnapshot', () => {
  it('parses a valid record', async () => {
    expect(await readSnapshot(await dataDir(JSON.stringify(SNAPSHOT)))).toEqual(SNAPSHOT);
  });

  it('resolves undefined when the data directory has no snapshot.json', async () => {
    expect(await readSnapshot(await dataDir(null))).toBeUndefined();
  });

  it.each([
    ['not JSON', '{"source":'],
    ['not an object', '[]'],
    ['missing source', JSON.stringify({ ...SNAPSHOT, source: undefined })],
    ['an empty source', JSON.stringify({ ...SNAPSHOT, source: '' })],
    ['missing sourceLastModified', JSON.stringify({ ...SNAPSHOT, sourceLastModified: undefined })],
    [
      'an HTTP-date sourceLastModified',
      JSON.stringify({ ...SNAPSHOT, sourceLastModified: 'Wed, 25 Nov 2026 02:53:49 GMT' }),
    ],
    [
      'a fetchedAt with an offset instead of UTC',
      JSON.stringify({ ...SNAPSHOT, fetchedAt: '2026-11-25T18:53:49-08:00' }),
    ],
    [
      'an out-of-range fetchedAt',
      JSON.stringify({ ...SNAPSHOT, fetchedAt: '2026-13-45T99:00:00Z' }),
    ],
  ])('rejects %s, naming the file', async (_case, text) => {
    const dir = await dataDir(text);
    await expect(readSnapshot(dir)).rejects.toThrow(join(dir, 'snapshot.json'));
  });

  it('rejects a snapshot.json it cannot read (a directory), naming the file', async () => {
    const dir = await dataDir(null);
    await mkdir(join(dir, 'snapshot.json'));
    await expect(readSnapshot(dir)).rejects.toThrow(join(dir, 'snapshot.json'));
  });
});

describe('AirportDataService snapshot provenance', () => {
  it('exposes the bundled sourceLastModified as dataAsOf', async () => {
    const { svc } = await loadAndLog(FIXTURE_DATA_DIR);
    expect(svc.dataAsOf).toBe('2026-11-25T02:53:49.000Z');
  });

  it('loads a data directory without snapshot.json and reports dataAsOf null', async () => {
    const { svc } = await loadAndLog(await dataDir(null));
    expect(svc.dataAsOf).toBeNull();
    expect(svc.resolveByCode('KSEA')?.airport.ident).toBe('KSEA');
  });

  it('fails load() with an error naming the file when snapshot.json is malformed', async () => {
    const dir = await dataDir(JSON.stringify({ ...SNAPSHOT, sourceLastModified: 'yesterday' }));
    await expect(new AirportDataService(dir).load()).rejects.toThrow(join(dir, 'snapshot.json'));
  });
});

describe('index-load log line', () => {
  it('keeps the existing counts and data directory (characterization)', async () => {
    const { extra } = await loadAndLog(FIXTURE_DATA_DIR);
    expect(extra).toMatchObject({
      dataDir: FIXTURE_DATA_DIR,
      airports: expect.any(Number),
      navaids: expect.any(Number),
      countries: expect.any(Number),
      regions: expect.any(Number),
      codeKeys: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it('carries dataAsOf and fetchedAt beside the counts', async () => {
    const { extra } = await loadAndLog(FIXTURE_DATA_DIR);
    expect(extra).toMatchObject({
      dataAsOf: SNAPSHOT.sourceLastModified,
      fetchedAt: SNAPSHOT.fetchedAt,
    });
  });

  it('logs null provenance for a data directory without snapshot.json', async () => {
    const { extra } = await loadAndLog(await dataDir(null));
    expect(extra).toMatchObject({ dataAsOf: null, fetchedAt: null });
  });

  it('labels the runway count as airports with runways, not runway rows', async () => {
    const airportRefs = new Set<number>();
    forEachRow(await readFile(join(FIXTURE_DATA_DIR, 'runways.csv'), 'utf-8'), (row) => {
      const ref = int(row.get('airport_ref'));
      if (ref !== undefined) airportRefs.add(ref);
    });
    const { extra } = await loadAndLog(FIXTURE_DATA_DIR);
    expect(extra?.airportsWithRunways).toBe(airportRefs.size);
    expect(extra).not.toHaveProperty('runways');
  });
});
