/**
 * @fileoverview Airport search query terms and their cost. Matching work per call
 * grows with the number of distinct tokens and codes in the query, while ranking
 * reads every word in query order. On a corpus where every airport matches, a
 * call's CPU across query doublings stays within a growth bound from the smallest
 * size and an absolute per-call bound at every size.
 * @module tests/services/query-cost.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AirportDataService } from '@/services/airport-data/airport-data-service.js';
import { loadFixtureService } from '../fixtures/load.js';

describe('airport search query terms', () => {
  let fixture: AirportDataService;
  beforeAll(async () => {
    fixture = await loadFixtureService();
  });
  const search = (query: string) => fixture.search({ query, includeClosed: false, limit: 20 });
  const idents = (query: string) => search(query).airports.map((a) => a.ident);

  it.each([
    ['faro faro', ['BR-0110', 'FARO']],
    ['HBE hbe', ['SAHBE', 'USHBE']],
    ['hbe Hbe HBE', ['SAHBE', 'USHBE']],
    ['faro-faro', ['BR-0110']],
  ])('matches %s as its distinct words', (query, expected) => {
    expect(idents(query)).toEqual(expected);
  });

  it('matches a query by its tokens', () => {
    const result = search('st. st, louis ST louis');
    expect(new Set(result.airports.map((a) => a.ident))).toEqual(
      new Set(['CA-0101', 'CA-0102', 'CA-0103']),
    );
    expect(result.totalMatched).toBe(3);
  });

  it.each([
    ['field', ['KBFI', 'PG-0109', '00AK']],
    ['field field', ['PG-0109', 'KBFI', '00AK']],
    ['field-field', ['PG-0109', 'KBFI', '00AK']],
    ['mcmur', ['CA-0104', 'CA-0105']],
    ['mcmur mcmur', ['CA-0105', 'CA-0104']],
    ['saint louis airport', ['CA-0103', 'CA-0101']],
    ['saint louis airport airport', ['CA-0101', 'CA-0103']],
  ])('ranks %s by every word in query order', (query, expected) => {
    expect(idents(query)).toEqual(expected);
  });

  it('flags a stopword-only query as having no searchable terms', () => {
    expect(search('the the of of')).toEqual({
      airports: [],
      totalMatched: 0,
      noSearchableTerms: true,
    });
  });
});

const AIRPORT_COUNT = 16_000;
const BASE_SIZE = 5_000;
const MAX_SIZE = 320_000;
const MAX_GROWTH = 256;
/** Per-call thread CPU ceiling at every size, in microseconds. */
const MAX_CALL_MICROS = 250_000;

describe('airport search query cost', () => {
  let dataDir: string;
  let svc: AirportDataService;

  /** A corpus where every airport carries the tokens `alpha` and `field`. */
  function writeCorpus(dir: string): void {
    const rows = ['"id","ident","type","name","latitude_deg","longitude_deg","municipality"'];
    for (let id = 1; id <= AIRPORT_COUNT; id++) {
      rows.push(
        `${id},"QC${id}","small_airport","Alpha Field ${id}",${(id % 170) - 85},${(id % 350) - 175},"Alpha"`,
      );
    }
    writeFileSync(join(dir, 'airports.csv'), `${rows.join('\n')}\n`);
    for (const file of [
      'countries.csv',
      'regions.csv',
      'runways.csv',
      'navaids.csv',
      'airport-frequencies.csv',
    ]) {
      writeFileSync(join(dir, file), '');
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ourairports-query-cost-'));
    writeCorpus(dataDir);
    svc = new AirportDataService(dataDir);
    await svc.load();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const search = (query: string) => svc.search({ query, includeClosed: false, limit: 20 });

  /** Thread CPU per call, in microseconds. */
  function cpuMicros(query: string, calls: number): number {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) search(query);
    const elapsed = process.threadCpuUsage(start);
    return (elapsed.user + elapsed.system) / calls;
  }

  const word = (i: number) =>
    `alpha${i.toString(6).replace(/\d/g, (digit) => '.,;:!?'[Number(digit)] as string)}`;

  /** Words joined by `separator` up to `size` characters, then `last`. */
  function words(separator: string, size: number, last: string): string {
    const parts: string[] = [];
    let length = last.length;
    for (let i = 0; length < size; i++) {
      const next = word(i) + separator;
      parts.push(next);
      length += next.length;
    }
    return parts.join('') + last;
  }

  const cases = [
    { name: 'one line ending in a break', build: (size: number) => words(' ', size, '\nfield') },
    { name: 'line breaks throughout', build: (size: number) => words('\r\n', size, 'field') },
    {
      name: 'no whitespace',
      build: (size: number) => `${'alpha-'.repeat(Math.floor((size - 5) / 6))}field`,
    },
  ];

  it.each(cases)(
    'bounds CPU growth across query doublings on $name',
    ({ build }) => {
      const baseline = build(BASE_SIZE);
      expect(search(baseline).totalMatched).toBe(AIRPORT_COUNT);
      for (let size = BASE_SIZE * 2; size <= MAX_SIZE; size *= 2) {
        const input = build(size);
        let bestGrowth = Number.POSITIVE_INFINITY;
        let bestTime = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 5; run++) {
          const small = cpuMicros(baseline, 3);
          const large = cpuMicros(input, 1);
          bestGrowth = Math.min(bestGrowth, large / Math.max(small, 1));
          bestTime = Math.min(bestTime, large);
        }
        expect(bestTime).toBeLessThan(MAX_CALL_MICROS);
        expect(bestGrowth).toBeLessThan(MAX_GROWTH);
      }
      expect(search(build(MAX_SIZE)).totalMatched).toBe(AIRPORT_COUNT);
    },
    0,
  );
});
