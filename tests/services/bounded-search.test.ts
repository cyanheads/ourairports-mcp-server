/**
 * @fileoverview Stable bounded selection and runway retention regressions.
 * @module tests/services/bounded-search.test
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { forEachRow } from '@/services/airport-data/csv.js';
import type { Airport } from '@/services/airport-data/types.js';
import { FIXTURE_DATA_DIR, loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();

describe('bounded search selection', () => {
  it('keeps the first dataset row for exact-name/score ties straddling the cap', () => {
    for (const query of [undefined, 'tied']) {
      const result = svc.search({
        ...(query && { query }),
        type: 'closed',
        country: 'FR',
        includeClosed: true,
        limit: 1,
      });
      expect(result.airports.map((a) => a.ident)).toEqual(['TIE-A']);
      expect(result.totalMatched).toBe(2);
    }
  });
  it('matches an independent stable full sort through multiple heap levels and repeated caps', async () => {
    const fresh = await loadFixtureService();
    const rows: Airport[] = [];
    forEachRow(await readFile(join(FIXTURE_DATA_DIR, 'airports.csv'), 'utf-8'), (r) => {
      rows.push(fresh.resolveByCode(r.get('ident'))!.airport);
    });
    const queryIds = new Set(
      fresh
        .search({ query: 'airport', includeClosed: true, limit: rows.length })
        .airports.map((a) => a.id),
    );
    const ranks: Record<string, number> = {
      large_airport: 6,
      medium_airport: 5,
      small_airport: 4,
      seaplane_base: 3,
      heliport: 2,
      balloonport: 1,
      closed: 0,
    };
    const score = (a: Airport, query: string | undefined) => {
      let n = (ranks[a.type] ?? 0) * 10 + (a.scheduledService ? 5 : 0);
      if (query) {
        if (a.iataCode?.toUpperCase() === 'AIRPORT' || a.icaoCode?.toUpperCase() === 'AIRPORT')
          n += 50;
        if (a.name.toUpperCase() === 'AIRPORT') n += 30;
        else if (a.name.toUpperCase().includes('AIRPORT')) n += 10;
      }
      return n;
    };
    let seed = 20261018;
    for (let trial = 0; trial < 32; trial++) {
      for (const row of rows) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        row.name = ['Same Name', 'á', 'a\u0301', 'Airport', 'Zulu Airport', 'Alpha'][
          seed % 6
        ] as string;
      }
      for (const query of [undefined, 'airport']) {
        const expected = rows
          .filter((a) => !query || queryIds.has(a.id))
          .toSorted((a, b) => score(b, query) - score(a, query) || a.name.localeCompare(b.name));
        for (const limit of [1, 2, 3, 7, 16, 100]) {
          const actual = fresh.search({ ...(query && { query }), includeClosed: true, limit });
          expect(actual.airports.map((a) => a.id)).toEqual(
            expected.slice(0, limit).map((a) => a.id),
          );
          expect(actual.totalMatched).toBe(expected.length);
        }
      }
    }
  });
  it('sorts only the retained airport candidates in both search branches', () => {
    for (const query of [undefined, 'airport']) {
      const sizes: number[] = [];
      const original = Array.prototype.sort;
      const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
        this: unknown[],
        compare,
      ) {
        sizes.push(this.length);
        return original.call(this, compare);
      });
      try {
        const result = svc.search({ ...(query && { query }), includeClosed: false, limit: 3 });
        expect(result.totalMatched).toBeGreaterThan(3);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
      } finally {
        spy.mockRestore();
      }
    }
  });
  it('stores only first-N runway rows while counting every match', () => {
    let stored = 0;
    const original = Array.prototype.push;
    Array.prototype.push = function (...items) {
      for (const item of items)
        if (item && typeof item === 'object' && 'airport' in item && 'runway' in item) stored++;
      return original.apply(this, items);
    };
    try {
      const result = svc.searchRunways({
        includeClosedAirports: false,
        includeClosedRunways: false,
        limit: 1,
      });
      Array.prototype.push = original;
      expect(result.totalMatched).toBeGreaterThan(1);
      expect(stored).toBe(1);
    } finally {
      Array.prototype.push = original;
    }
  });
});
