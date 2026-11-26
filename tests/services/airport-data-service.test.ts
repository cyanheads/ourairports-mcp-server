/**
 * @fileoverview Behavior tests for the AirportDataService against the fixture
 * CSV slice — code resolution across all five spaces, collision handling, the
 * haversine nearest-neighbour scan, navaid kHz storage, the two navaid modes,
 * closed-airport filtering, country/region enrichment, and CSV header parsing.
 * @module tests/services/airport-data-service.test
 */

import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AirportDataService } from '@/services/airport-data/airport-data-service.js';
import { forEachRow } from '@/services/airport-data/csv.js';
import { haversineKm, MAX_RADIUS_KM, nearest } from '@/services/airport-data/geo.js';
import type { AirportFacets } from '@/services/airport-data/types.js';
import { FIXTURE_DATA_DIR, loadFixtureService } from '../fixtures/load.js';

let svc: AirportDataService;

beforeAll(async () => {
  svc = await loadFixtureService();
});

/**
 * Call inside a `describe`: loads a temp copy of the fixture data with `rows`
 * appended to airports.csv, so a test can add airports without moving the counts
 * other tests assert on the fixture, and removes the copy afterwards.
 */
function withExtraAirports(rows: string[]) {
  let extended: AirportDataService;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ourairports-extra-airports-'));
    await cp(FIXTURE_DATA_DIR, dir, { recursive: true });
    await appendFile(join(dir, 'airports.csv'), rows.map((row) => `${row}\n`).join(''));
    extended = new AirportDataService(dir);
    await extended.load();
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const search = (query: string) => extended.search({ query, includeClosed: false, limit: 20 });
  return { search, idents: (query: string) => search(query).airports.map((a) => a.ident) };
}

describe('CSV parsing by header name', () => {
  it('parses an airport with full code set (KSEA)', () => {
    const r = svc.resolveByCode('KSEA');
    expect(r).toBeDefined();
    expect(r?.airport.name).toBe('Seattle Tacoma International Airport');
    expect(r?.airport.iataCode).toBe('SEA');
    expect(r?.airport.icaoCode).toBe('KSEA');
    expect(r?.airport.elevationFt).toBe(433);
    expect(r?.airport.isoCountry).toBe('US');
    expect(r?.airport.scheduledService).toBe(true);
  });

  it('treats empty code cells as absent (00AA has no ICAO/IATA)', () => {
    const r = svc.resolveByCode('00AA');
    expect(r).toBeDefined();
    expect(r?.airport.iataCode).toBeUndefined();
    expect(r?.airport.icaoCode).toBeUndefined();
    expect(r?.airport.gpsCode).toBe('00AA');
    expect(r?.airport.localCode).toBe('00AA');
  });
});

describe('code resolution across identifier spaces', () => {
  it('resolves by IATA and reports the matched space', () => {
    const r = svc.resolveByCode('SEA');
    expect(r?.airport.ident).toBe('KSEA');
    expect(r?.resolvedVia).toBe('iata_code');
    expect(r?.sharedWith).toEqual([]);
  });

  it('resolves by ICAO', () => {
    const r = svc.resolveByCode('ksea');
    expect(r?.resolvedVia).toBe('ident'); // KSEA is both ident and icao_code; ident wins by priority
    expect(r?.airport.ident).toBe('KSEA');
  });

  it('resolves by ident for a code-less small airport', () => {
    const r = svc.resolveByCode('00ak');
    expect(r?.airport.name).toBe('Lowell Field');
    expect(r?.resolvedVia).toBe('ident');
  });

  it('returns undefined for an unknown code', () => {
    expect(svc.resolveByCode('ZZZZ')).toBeUndefined();
    expect(svc.resolveByCode('')).toBeUndefined();
  });

  it('records the other holder of a gps/local collision (HBE in US and AR)', () => {
    const r = svc.resolveByCode('HBE');
    expect(r).toBeDefined();
    expect(r?.sharedWith.map((h) => h.airport.isoCountry)).toEqual(['AR']);
    // First in CSV order (US row) wins.
    expect(r?.airport.isoCountry).toBe('US');
  });

  it('keeps globally-unique IATA/ICAO unshared', () => {
    expect(svc.resolveByCode('JFK')?.sharedWith).toEqual([]);
    expect(svc.resolveByCode('KJFK')?.sharedWith).toEqual([]);
  });

  // Regression for #2: a globally-unique ident must never be shadowed by an
  // EARLIER CSV row's gps/local code. The fixture seeds three shadow pairs where
  // the earlier row claims the string in national-code space; global priority
  // passes register every ident before any national code, so the ident-owner
  // wins while the other airport is still recorded as a holder of the code.
  it('resolves 5MO to its ident-owner (Plattsburg), not the local_code shadow (Applegate, 15MO)', () => {
    const r = svc.resolveByCode('5MO');
    expect(r?.airport.ident).toBe('5MO');
    expect(r?.airport.name).toBe('Plattsburg Airpark');
    expect(r?.resolvedVia).toBe('ident');
    expect(r?.sharedWith.map((h) => h.airport.ident)).toEqual(['15MO']); // 15MO still carries 5MO as its local_code
  });

  it('resolves 1A8 to its ident-owner (Empire), not the gps_code shadow (Goldfield, 0L5)', () => {
    const r = svc.resolveByCode('1A8');
    expect(r?.airport.ident).toBe('1A8');
    expect(r?.airport.name).toBe('Empire Airport');
    expect(r?.resolvedVia).toBe('ident');
    expect(r?.sharedWith.map((h) => h.airport.ident)).toEqual(['0L5']);
  });

  it('resolves ERT to its ident-owner (Erdenet), not the local_code shadow (Estancia, AR-0143)', () => {
    const r = svc.resolveByCode('ERT');
    expect(r?.airport.ident).toBe('ERT');
    expect(r?.airport.name).toBe('Erdenet Airport');
    expect(r?.resolvedVia).toBe('ident');
    expect(r?.sharedWith.map((h) => h.airport.ident)).toEqual(['AR-0143']);
  });
});

describe('shared-code holders', () => {
  const holders = (code: string) =>
    svc.resolveByCode(code)?.sharedWith.map((h) => `${h.airport.ident}:${h.spaces.join('+')}`);

  it('is empty for a code on one airport, however many of its spaces carry it', () => {
    expect(holders('KSEA')).toEqual([]);
    expect(holders('SEA')).toEqual([]);
    expect(holders('00AA')).toEqual([]);
  });

  it('lists every other airport with each space it carries the code in', () => {
    expect(holders('HBE')).toEqual(['SAHBE:gps_code+local_code']);
    expect(holders('1A8')).toEqual(['0L5:gps_code+local_code']);
    expect(holders('GIG')).toEqual(['SBGL:iata_code']);
    expect(holders('LGTL')).toEqual(['GR-0109:icao_code']);
    expect(holders('AKA')).toEqual(['ABP:local_code']);
  });

  it('lists same-space tie losers in dataset row order (HBI)', () => {
    const r = svc.resolveByCode('HBI');
    expect(r?.airport.ident).toBe('AR-0572');
    expect(r?.resolvedVia).toBe('local_code');
    expect(holders('HBI')).toEqual(['AYHH:local_code', 'KHBI:local_code']);
  });

  it('resolves every listed holder by its own ident (the recovery the note suggests)', () => {
    for (const code of ['HBE', 'HBI', 'GIG', 'LGTL', 'AKA', '5MO', '1A8', 'ERT']) {
      const sharedWith = svc.resolveByCode(code)?.sharedWith;
      expect(sharedWith?.length).toBeGreaterThan(0);
      for (const holder of sharedWith ?? []) {
        const r = svc.resolveByCode(holder.airport.ident);
        expect(r?.airport.id).toBe(holder.airport.id);
        expect(r?.resolvedVia).toBe('ident');
      }
    }
  });
});

describe('runway and frequency joins', () => {
  it('joins runways by airport id', () => {
    const sea = svc.resolveByCode('KSEA')?.airport;
    const runways = svc.runwaysForAirport(sea?.id as number);
    expect(runways).toHaveLength(2);
    expect(runways[0]?.leIdent).toBe('16L');
    expect(runways[0]?.lengthFt).toBe(11901);
    expect(runways[0]?.surface).toBe('CON');
  });

  it('joins frequencies by airport id (in MHz)', () => {
    const sea = svc.resolveByCode('KSEA')?.airport;
    const freqs = svc.frequenciesForAirport(sea?.id as number);
    expect(freqs.length).toBeGreaterThanOrEqual(3);
    const twr = freqs.find((f) => f.type === 'TWR');
    expect(twr?.frequencyMhz).toBe(119.9);
  });

  it('returns empty arrays for an airport with no runways/frequencies', () => {
    const aa = svc.resolveByCode('00AA')?.airport;
    expect(svc.runwaysForAirport(aa?.id as number)).toEqual([]);
    expect(svc.frequenciesForAirport(aa?.id as number)).toEqual([]);
  });
});

describe('nearbyAirports (haversine)', () => {
  const open = { includeClosed: false };
  const withClosed = { includeClosed: true };
  const large = { type: 'large_airport', includeClosed: false };

  it('ranks nearest-first and computes distance/bearing', () => {
    // Near Seattle — KSEA and KBFI are ~7 km apart.
    const { airports: hits } = svc.nearbyAirports(47.45, -122.31, 100, 10, open);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.airport.ident).toBe('KSEA');
    expect(hits[0]?.distanceKm).toBeLessThan(hits[1]?.distanceKm as number);
    expect(hits[0]?.bearingDeg).toBeGreaterThanOrEqual(0);
    expect(hits[0]?.bearingDeg).toBeLessThanOrEqual(360);
  });

  it('excludes closed airports by default and includes them on opt-in', () => {
    const withoutClosed = svc.nearbyAirports(47.5, -122.4, 50, 50, open);
    expect(withoutClosed.airports.some((h) => h.airport.type === 'closed')).toBe(false);
    const included = svc.nearbyAirports(47.5, -122.4, 50, 50, withClosed);
    expect(included.airports.some((h) => h.airport.ident === 'CLOSEDX')).toBe(true);
  });

  it('respects the radius and the type filter', () => {
    const far = svc.nearbyAirports(0, 0, 100, 10, open);
    expect(far).toEqual({ airports: [], totalMatched: 0 });
    const onlyLarge = svc.nearbyAirports(47.45, -122.31, 200, 10, large);
    expect(onlyLarge.airports.every((h) => h.airport.type === 'large_airport')).toBe(true);
  });

  it('reports the filtered in-radius total before the limit (#11)', () => {
    const capped = svc.nearbyAirports(47.45, -122.31, 100, 1, open);
    expect(capped.airports.map((h) => h.airport.ident)).toEqual(['KSEA']);
    expect(capped.totalMatched).toBe(2);
    expect(svc.nearbyAirports(47.45, -122.31, 100, 1, withClosed).totalMatched).toBe(3);
    expect(svc.nearbyAirports(47.45, -122.31, 100, 1, large).totalMatched).toBe(1);
    const all = svc.nearbyAirports(47.45, -122.31, 100, 2, open);
    expect(all.airports).toHaveLength(2);
    expect(all.totalMatched).toBe(2);
  });
});

describe('airport facets shared by search, runway search, and the nearby scan (#33, #35)', () => {
  type Row = { ident: string; type: string; scheduled: boolean };
  const airports: Row[] = [];
  const runwayIds = new Map<string, number[]>();

  beforeAll(async () => {
    forEachRow(await readFile(join(FIXTURE_DATA_DIR, 'airports.csv'), 'utf-8'), (r) => {
      airports.push({
        ident: r.get('ident'),
        type: r.get('type'),
        scheduled: r.get('scheduled_service') === 'yes',
      });
    });
    forEachRow(await readFile(join(FIXTURE_DATA_DIR, 'runways.csv'), 'utf-8'), (r) => {
      const ids = runwayIds.get(r.get('airport_ident')) ?? [];
      ids.push(Number(r.get('id')));
      runwayIds.set(r.get('airport_ident'), ids);
    });
  });

  const grid: AirportFacets[] = [undefined, 'closed', 'medium_airport'].flatMap((type) =>
    [false, true].flatMap((includeClosed) =>
      [undefined, true, false].map((scheduledService) => ({
        includeClosed,
        ...(type && { type }),
        ...(scheduledService !== undefined && { scheduledService }),
      })),
    ),
  );

  it.each(grid)('selects the same airports in all three scans for %j', (facets) => {
    const expected = airports
      .filter(
        (a) =>
          (facets.type ? a.type === facets.type : facets.includeClosed || a.type !== 'closed') &&
          (facets.scheduledService === undefined || a.scheduled === facets.scheduledService),
      )
      .map((a) => a.ident)
      .sort();

    const found = svc.search({ ...facets, limit: 100 });
    expect(found.airports.map((a) => a.ident).sort()).toEqual(expected);
    expect(found.totalMatched).toBe(expected.length);

    const near = svc.nearbyAirports(0, 0, MAX_RADIUS_KM, 100, facets);
    expect(near.airports.map((h) => h.airport.ident).sort()).toEqual(expected);
    expect(near.totalMatched).toBe(expected.length);

    const { includeClosed, ...airportFacets } = facets;
    const runways = svc.searchRunways({
      ...airportFacets,
      includeClosedAirports: includeClosed,
      includeClosedRunways: true,
      limit: 100,
    });
    const byId = (a: number, b: number) => a - b;
    expect(runways.matches.map((m) => m.runway.id).sort(byId)).toEqual(
      expected.flatMap((ident) => runwayIds.get(ident) ?? []).sort(byId),
    );
  });

  it('type closed returns the closed airports with includeClosed false or true (#33)', () => {
    const closed = (includeClosed: boolean) =>
      svc.search({ type: 'closed', includeClosed, limit: 100 });
    expect(closed(false)).toEqual(closed(true));
    expect(closed(false).airports.map((a) => a.ident)).toEqual([
      'CN-0119',
      'LGTL',
      'CA-1094',
      'CLOSEDX',
      'TIE-A',
      'TIE-B',
    ]);
    const runways = (includeClosedAirports: boolean) =>
      svc
        .searchRunways({
          type: 'closed',
          includeClosedAirports,
          includeClosedRunways: false,
          limit: 100,
        })
        .matches.map((m) => m.runway.id);
    expect(runways(false)).toEqual([245683, 249263]);
    expect(runways(true)).toEqual(runways(false));
    const near = svc.nearbyAirports(32.7, 108.9, 50, 10, { type: 'closed', includeClosed: false });
    expect(near.airports.map((h) => h.airport.ident)).toEqual(['CN-0119']);
  });

  it('keeps closed runways out of a type closed runway search until includeClosedRunways (#33)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ourairports-closed-runway-'));
    try {
      await cp(FIXTURE_DATA_DIR, dir, { recursive: true });
      await appendFile(
        join(dir, 'runways.csv'),
        '990201,990119,"CN-0119",8000,150,"CON",1,1,"07",,,,,,"25",,,,,\n',
      );
      const withClosedRunway = new AirportDataService(dir);
      await withClosedRunway.load();
      const ids = (includeClosedRunways: boolean) =>
        withClosedRunway
          .searchRunways({
            type: 'closed',
            includeClosedAirports: false,
            includeClosedRunways,
            limit: 100,
          })
          .matches.map((m) => m.runway.id);
      expect(ids(false)).toEqual([245683, 249263]);
      expect(ids(true)).toEqual([245683, 249263, 990201]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scheduledService splits the open airports and keeps the closed exclusion (#35)', () => {
    const total = (facets: AirportFacets) => svc.search({ ...facets, limit: 1 }).totalMatched;
    expect(total({ includeClosed: false })).toBe(44);
    expect(total({ includeClosed: false, scheduledService: true })).toBe(19);
    expect(total({ includeClosed: false, scheduledService: false })).toBe(25);
    expect(total({ includeClosed: true, scheduledService: true })).toBe(20);
    const closedScheduled = svc.search({
      type: 'closed',
      includeClosed: false,
      scheduledService: true,
      limit: 10,
    });
    expect(closedScheduled.airports.map((a) => a.ident)).toEqual(['CN-0119']);
    const near = (facets: AirportFacets) =>
      svc.nearbyAirports(32.7, 108.9, 50, 10, facets).airports.map((h) => h.airport.ident);
    expect(near({ includeClosed: false, scheduledService: true })).toEqual(['ZLAK', 'CN-0114']);
    expect(near({ includeClosed: true, scheduledService: true })).toEqual([
      'CN-0119',
      'ZLAK',
      'CN-0114',
    ]);
    expect(near({ includeClosed: false, scheduledService: false })).toEqual(['CN-0118']);
  });

  it('pages a scheduledService selection without duplicates or skips (#35)', () => {
    const facets: AirportFacets = { includeClosed: true, scheduledService: true };
    const full = svc.search({ ...facets, limit: 100 });
    const paged = Array.from({ length: full.totalMatched + 1 }, (_, offset) =>
      svc.search({ ...facets, limit: 1, offset }).airports.map((a) => a.ident),
    ).flat();
    expect(paged).toEqual(full.airports.map((a) => a.ident));

    const near = (limit: number, offset: number) =>
      svc.nearbyAirports(32.7, 108.9, MAX_RADIUS_KM, limit, facets, offset);
    const fullNear = near(100, 0);
    const pagedNear = Array.from({ length: fullNear.totalMatched + 1 }, (_, offset) =>
      near(1, offset).airports.map((h) => h.airport.ident),
    ).flat();
    expect(fullNear.totalMatched).toBe(20);
    expect(pagedNear).toEqual(fullNear.airports.map((h) => h.airport.ident));
  });
});

describe('navaids', () => {
  it('stores frequency in kHz for all types', () => {
    const { navaids } = svc.navaidsForAirport('KSEA', undefined, 20);
    expect(navaids).toHaveLength(1);
    expect(navaids[0]?.type).toBe('VORTAC');
    expect(navaids[0]?.frequencyKhz).toBe(116800); // 116.8 MHz stored as kHz
  });

  it('finds navaids near a coordinate, nearest-first', () => {
    const { navaids: hits } = svc.nearbyNavaids(47.45, -122.31, 200, 20, undefined);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.navaid.ident).toBe('SEA');
    expect(hits[0]?.distanceKm).toBeLessThanOrEqual(hits[hits.length - 1]?.distanceKm as number);
  });

  it('filters navaids by type', () => {
    const { navaids: ndbs } = svc.nearbyNavaids(40.633, -73.778, 100, 20, 'NDB');
    expect(ndbs.every((h) => h.navaid.type === 'NDB')).toBe(true);
    expect(ndbs.some((h) => h.navaid.ident === 'JFK')).toBe(true);
  });

  it('returns empty list for an airport with no associated navaids', () => {
    // 00AA has no navaid linking to it.
    expect(svc.navaidsForAirport('00AA', undefined, 20)).toEqual({ navaids: [], totalMatched: 0 });
  });

  it('does not index standalone navaids (empty associated_airport) under any airport', () => {
    // NDLS is enroute with no associated_airport.
    const coord = svc.nearbyNavaids(40.0, -160.0, 50, 20, undefined);
    expect(coord.navaids.some((h) => h.navaid.ident === 'NDLS')).toBe(true);
  });

  it('reports the in-radius and associated totals before the limit (#11)', () => {
    const coord = svc.nearbyNavaids(40.6413, -73.7781, 60, 1, undefined);
    expect(coord.navaids.map((h) => h.navaid.ident)).toEqual(['JFK']);
    expect(coord.totalMatched).toBe(4);
    expect(svc.nearbyNavaids(40.6413, -73.7781, 60, 1, 'NDB').totalMatched).toBe(3);

    const airport = svc.navaidsForAirport('kjfk', undefined, 1);
    expect(airport.navaids.map((n) => n.ident)).toEqual(['JFK']);
    expect(airport.totalMatched).toBe(2);
    expect(svc.navaidsForAirport('KJFK', 'VOR-DME', 1).totalMatched).toBe(1);
  });

  it('looks up all holders of an exact navaid ident in dataset order and pages after type filtering', () => {
    const first = svc.navaidsByIdent(' bik ', undefined, 1);
    const second = svc.navaidsByIdent('BIK', undefined, 1, 1);
    expect(first.navaids.map((n) => n.id)).toEqual([86052]);
    expect(second.navaids.map((n) => n.id)).toEqual([86054]);
    expect(first.totalMatched).toBe(2);
    expect(second.totalMatched).toBe(2);
    expect(svc.navaidsByIdent('BIK', 'NDB', 1)).toMatchObject({
      navaids: [{ id: 86054 }],
      totalMatched: 1,
    });
    expect(svc.navaidsByIdent('BIK', 'NDB', 1, 1)).toEqual({ navaids: [], totalMatched: 1 });
    expect(svc.navaidsByIdent('BI', undefined, 1)).toEqual({ navaids: [], totalMatched: 0 });
    expect(svc.navaidsForAirport('KJFK', undefined, 1, 1)).toMatchObject({
      navaids: [{ ident: 'CRI' }],
      totalMatched: 2,
    });
  });

  it('parses slaved_variation_deg and keeps a stored 0 (#18)', () => {
    const sea = svc.navaidsForAirport('KSEA', undefined, 1).navaids[0];
    expect(sea?.slavedVariationDeg).toBe(18.5);
    expect(sea?.magneticVariationDeg).toBe(16.123);
    const rdg = svc.nearbyNavaids(49.040298461899994, 12.5264997482, 1, 1, undefined).navaids[0];
    expect(rdg?.navaid.slavedVariationDeg).toBe(0);
    const ndls = svc.nearbyNavaids(40.0, -160.0, 1, 1, undefined).navaids[0];
    expect(ndls?.navaid.slavedVariationDeg).toBeUndefined();
  });

  it('drops non-positive placeholder frequencies at parse time (#14)', () => {
    const bik = svc
      .nearbyNavaids(-34.18, 150.1, 30, 10, 'NDB')
      .navaids.map((h) => h.navaid)
      .find((n) => n.ident === 'BIK');
    expect(bik).toBeDefined();
    expect(bik?.frequencyKhz).toBeUndefined();
    const mqd = svc.nearbyNavaids(-33.108299255371, 151.13900756836, 1, 1, 'VOR').navaids[0];
    expect(mqd?.navaid.frequencyKhz).toBeUndefined();
  });
});

describe('nearest() pre-limit count (#11)', () => {
  // Three points on the equator at 0°, 1°, and 2° east (~111 km apart) plus one far away.
  const coords = new Float64Array([0, 2, 0, 0, 0, 1, 50, 50]);

  it('keeps coordinate order for equal distances', () => {
    const tied = new Float64Array([0, 1, 0, -1, 0, 0, 1, 0]);
    const { hits, total } = nearest(tied, 0, 0, 300, 3, () => true);
    expect(hits.map((h) => h.index)).toEqual([2, 0, 1]);
    expect(total).toBe(4);
  });

  it('keeps great-circle distance finite at antipodes', () => {
    const lat = 88.40000000000009;
    expect(haversineKm(-lat, 0, lat, 180)).toBeCloseTo(20015.1144, 3);
  });

  it('returns the nearest `limit` hits and the in-radius count before the slice', () => {
    const { hits, total } = nearest(coords, 0, 0, 300, 2, () => true);
    expect(hits.map((h) => h.index)).toEqual([1, 2]);
    expect(total).toBe(3);
  });

  it('counts only accepted in-radius entries', () => {
    expect(nearest(coords, 0, 0, 300, 1, (i) => i !== 2).total).toBe(2);
    expect(nearest(coords, 0, 0, 50, 10, () => true)).toEqual({
      hits: [{ index: 1, distanceKm: 0 }],
      total: 1,
    });
  });

  it('returns every hit when the limit is at or above the count', () => {
    const { hits, total } = nearest(coords, 0, 0, 300, 3, () => true);
    expect(hits).toHaveLength(3);
    expect(total).toBe(3);
  });
});

describe('listCountries', () => {
  it('combines country and continent without inferring region membership from its prefix', () => {
    expect(svc.listCountries('EU', true, 'us')).toEqual([]);
    expect(svc.listCountries('EU', true, 'xk')).toMatchObject([
      { code: 'XK', regions: [{ code: 'KS-U-A' }] },
    ]);
  });
  it('lists countries with airport counts, sorted by name', () => {
    const countries = svc.listCountries(undefined, false);
    const us = countries.find((c) => c.code === 'US');
    expect(us).toBeDefined();
    expect(us?.name).toBe('United States');
    // Non-closed US airports in the fixture: KSEA, KJFK, 00AA, 00AK, USHBE, KBFI,
    // 15MO, 5MO, 0L5, 1A8, KHBI = 11 (CLOSEDX excluded; the four code-shadowing rows are US).
    expect(us?.airportCount).toBe(11);
    expect(us?.regions).toBeUndefined();
  });

  it('filters by continent', () => {
    const oc = svc.listCountries('OC', false);
    expect(oc.every((c) => c.continent === 'OC')).toBe(true);
    expect(oc.some((c) => c.code === 'SB')).toBe(true);
    expect(oc.some((c) => c.code === 'US')).toBe(false);
  });

  it('nests regions with counts when requested', () => {
    const us = svc.listCountries(undefined, true).find((c) => c.code === 'US');
    expect(us?.regions).toBeDefined();
    const wa = us?.regions?.find((r) => r.code === 'US-WA');
    expect(wa?.name).toBe('Washington');
    // KSEA + KBFI in WA (CLOSEDX is closed, excluded).
    expect(wa?.airportCount).toBe(2);
  });
});

describe('search', () => {
  it.each([
    [' jfk ', 'KJFK'],
    ['lgtl', 'GR-0109'],
    ['sbom', 'BR-2199'],
    ['mt0644', 'BR-2199'],
    ['ar-0572', 'AR-0572'],
    ['jfk kennedy', 'KJFK'],
    ['seattle tacoma intl', 'KSEA'],
    ['asheboro rgnl', 'KHBI'],
  ])('leads search for %s with %s', (query, ident) => {
    const res = svc.search({ query, includeClosed: false, limit: 20 });
    expect(res.airports[0]?.ident).toBe(ident);
  });

  it('finds every exact shared-code holder without treating code prefixes as codes', () => {
    const search = (query: string) => svc.search({ query, includeClosed: false, limit: 20 });
    expect(search('HBE').airports.map((a) => a.ident)).toEqual(['SAHBE', 'USHBE']);
    expect(search('SBOM').airports.map((a) => a.ident)).toEqual(['BR-2199']);
    expect(search('SBO').totalMatched).toBe(0);
    expect(search('ar-057').totalMatched).toBe(0);
    expect(search('jfk seattle').totalMatched).toBe(0);
  });
  it('matches by name token (AND) and ranks larger/operational first', () => {
    const res = svc.search({ query: 'seattle', includeClosed: false, limit: 20 });
    expect(res.totalMatched).toBeGreaterThanOrEqual(1);
    expect(res.airports[0]?.ident).toBe('KSEA'); // large_airport + scheduled + name match
  });

  it('excludes closed airports by default', () => {
    const res = svc.search({ query: 'field', includeClosed: false, limit: 20 });
    expect(res.airports.some((a) => a.type === 'closed')).toBe(false);
  });

  it('includes closed airports when opted in', () => {
    const res = svc.search({ includeClosed: true, type: 'closed', limit: 20 });
    expect(res.airports.some((a) => a.ident === 'CLOSEDX')).toBe(true);
  });

  it('filters by country and region facets', () => {
    const wa = svc.search({ region: 'US-WA', includeClosed: false, limit: 20 });
    expect(wa.airports.every((a) => a.isoRegion === 'US-WA')).toBe(true);
    expect(wa.airports.some((a) => a.ident === 'KSEA')).toBe(true);
    const sb = svc.search({ country: 'SB', includeClosed: false, limit: 20 });
    expect(sb.airports.every((a) => a.isoCountry === 'SB')).toBe(true);
  });

  it('reports totalMatched before the limit and truncates', () => {
    const res = svc.search({ includeClosed: false, limit: 1 });
    expect(res.airports).toHaveLength(1);
    expect(res.totalMatched).toBeGreaterThan(1);
  });

  it('returns empty when nothing matches', () => {
    const res = svc.search({ query: 'nonexistentplacename', includeClosed: false, limit: 20 });
    expect(res.airports).toHaveLength(0);
    expect(res.totalMatched).toBe(0);
  });

  // Regression for #1: a query token must not match a SHORTER indexed token it
  // merely starts with. "Aero B Ranch Airport" (00AA) contributes a bare "b"
  // token; before the fix, "bzzqxw".startsWith("b") falsely matched it.
  it('does not false-match a gibberish query via a short indexed token (#1)', () => {
    const res = svc.search({ query: 'bzzqxw', includeClosed: false, limit: 20 });
    expect(res.airports).toHaveLength(0);
    expect(res.totalMatched).toBe(0);
  });

  it('still matches a real forward prefix (intended direction kept)', () => {
    // "seatt" is a prefix of the indexed token "seattle".
    const res = svc.search({ query: 'seatt', includeClosed: false, limit: 20 });
    expect(res.airports.some((a) => a.ident === 'KSEA')).toBe(true);
  });

  // Regression for #3: a non-blank query that tokenizes to nothing (only
  // stopwords or punctuation) returns zero with the noSearchableTerms flag —
  // distinct from an omitted/blank query, which browses by facets.
  it('flags a non-blank query that tokenizes to nothing (#3)', () => {
    for (const query of ['the', '!!!', 'the of and']) {
      const res = svc.search({ query, includeClosed: false, limit: 20 });
      expect(res.airports).toHaveLength(0);
      expect(res.totalMatched).toBe(0);
      expect(res.noSearchableTerms).toBe(true);
    }
  });

  it('browses by facets when query is omitted or whitespace-only (not flagged) (#3)', () => {
    const omitted = svc.search({ includeClosed: false, limit: 20 });
    expect(omitted.totalMatched).toBeGreaterThan(1);
    expect(omitted.noSearchableTerms).toBeUndefined();
    const blank = svc.search({ query: '   ', includeClosed: false, limit: 20 });
    expect(blank.totalMatched).toBeGreaterThan(1);
    expect(blank.noSearchableTerms).toBeUndefined();
  });
});

describe('search name alternatives and name boost (#34)', () => {
  const idents = (query: string, limit = 20) =>
    svc.search({ query, includeClosed: false, limit }).airports.map((a) => a.ident);

  it.each([
    // A "St." name leads a keyword-only "st" match that sorts first alphabetically.
    ['st louis', ['CA-0101', 'CA-0102', 'CA-0103']],
    ['saint louis', ['CA-0101', 'CA-0103']],
    ['ft mcmurray', ['CA-0104', 'CA-0105']],
    ['sault sainte marie', ['CA-0108']],
    // The whole-name match (+30) outranks a larger scheduled airport with no name boost here.
    ['saint louis airport', ['CA-0103', 'CA-0101']],
    // Only the last query token may match as a forward prefix: "fo" earns CA-0104 no
    // boost, so the score tie falls to the name.
    ['fo mcmurray', ['CA-0105', 'CA-0104']],
    // A last-token prefix earns the consecutive-token boost (+10), never the whole-name one.
    ['saint louis airp', ['CA-0101', 'CA-0103']],
  ])('ranks %s as %j', (query, expected) => {
    expect(idents(query)).toEqual(expected);
  });

  it('adds alternatives without removing literal matches', () => {
    const set = (query: string) => new Set(idents(query, 100));
    expect(set('ft mcmurray')).toEqual(set('fort mcmurray'));
    expect(set('mt pleasant')).toEqual(new Set(['CA-0106', 'CA-0107']));
    // ft and mt are one-way: the full spelling keeps its literal matches only.
    expect(set('mount pleasant')).toEqual(new Set(['CA-0106']));
    expect(set('fort')).toEqual(new Set(['CA-0104', 'CA-0105']));
    // A literal token keeps its forward prefix beside the alternative.
    expect(set('st')).toContain('CA-0102');
    expect(set('sault ste marie')).toEqual(new Set(['CA-0108']));
  });

  it('boosts name tokens and forward prefixes, never a mid-word substring', () => {
    // "field" is inside "Bauerfield" but is not one of its name tokens.
    expect(idents('field', 2)).toEqual(['KBFI', 'PG-0109']);
    // "mcmur" prefixes a name token of CA-0104 and only the municipality of CA-0105.
    expect(idents('mcmur')).toEqual(['CA-0104', 'CA-0105']);
  });

  describe('with a name spelled "Sainte"', () => {
    const extra = withExtraAirports([
      '990140,"CA-0140","small_airport","Sainte Anne Airport",46.9,-71.3,240,"NA","CA","CA-QC","Sainte-Anne","no",,,,,,,',
    ]);

    it('reaches it through ste as well as sainte', () => {
      expect(extra.idents('ste anne')).toEqual(['CA-0140']);
      expect(extra.idents('sainte anne')).toEqual(['CA-0140']);
    });
  });
});

describe('search one-word code tier (#38)', () => {
  const search = (query: string) => svc.search({ query, includeClosed: false, limit: 20 });

  it.each([
    // The municipality's airport outranks a smaller code-only holder.
    ['faro', ['BR-0110', 'FARO'], 2],
    // Equal scores: the municipality holder wins the tie against the ICAO holder.
    ['palu', ['CN-0114', 'PALU'], 2],
    // The IATA holder keeps the lead over municipality holders.
    ['del', ['VIDP', 'AR-0115', 'LELN'], 3],
    // A name-only token stays outside the tier.
    ['gago', ['GAGO', 'BR-0110'], 2],
  ])('ranks %s as %j with every match counted', (query, expected, total) => {
    const result = search(query);
    expect(result.airports.map((a) => a.ident)).toEqual(expected);
    expect(result.totalMatched).toBe(total);
  });

  it.each([' palu', 'palu ', ' palu '])(
    'keeps the tier for the padded one-word code query %j',
    (query) => {
      const result = search(query);
      expect(result.airports.map((a) => a.ident)).toEqual(['CN-0114', 'PALU']);
      expect(result.totalMatched).toBe(2);
    },
  );

  it.each([
    // A code word beside a text word: with no tier, the larger scheduled airport leads
    // the code holder that leads the one-word query.
    ['faro airport', ['BR-0110', 'FARO']],
    ['gago airport', ['BR-0110', 'GAGO']],
    // A code holder still needs every other word.
    ['faro gago', ['BR-0110']],
    ['jfk kennedy', ['KJFK']],
  ])('ranks the multi-word query %s as %j, outside the tier', (query, expected) => {
    expect(search(query).airports.map((a) => a.ident)).toEqual(expected);
  });

  describe('with an airport whose municipality only starts with the code word', () => {
    // Medium with scheduled service, it ties both tier members on score, so only
    // tier membership decides its place.
    const extra = withExtraAirports([
      '990120,"CN-0120","medium_airport","Occidental Airport",32.6,108.7,300,"AS","CN","CN-61","Paluan","yes",,,,,,,',
    ]);

    it('matches it by prefix but keeps it outside the tier', () => {
      const result = extra.search('palu');
      expect(result.airports.map((a) => a.ident)).toEqual(['CN-0114', 'PALU', 'CN-0120']);
      expect(result.totalMatched).toBe(3);
    });
  });
});

describe('search tokenizer folds Latin letters NFKD leaves whole', () => {
  const idents = (query: string) =>
    svc.search({ query, includeClosed: false, limit: 20 }).airports.map((a) => a.ident);

  it.each([
    ['lodz', ['GR-0116']],
    ['ŁÓDŹ', ['GR-0116']],
    ['wladyslaw reymont', ['GR-0116']],
    ['rost', ['GR-0117']],
    ['røst', ['GR-0117']],
    // № decomposes to "No"; its capital letter survives the strip.
    ['no 1', ['CN-0118']],
  ])('matches %s whole', (query, expected) => {
    expect(idents(query)).toEqual(expected);
  });

  it('no longer matches word fragments split at a folded letter', () => {
    expect(idents('st')).not.toContain('GR-0117');
    expect(idents('adys')).toEqual([]);
  });

  describe('every folded letter', () => {
    /**
     * One airport per folded letter: its name, the name word folded to ASCII, and the
     * fragment after the letter, which an unfolded letter would split into a token.
     */
    const FOLDS: [letter: string, ident: string, name: string, word: string, fragment: string][] = [
      ['æ', 'FOLD-AE', 'Kværndrup', 'kvaerndrup', 'rndrup'],
      ['đ', 'FOLD-D', 'Međugorje', 'medugorje', 'ugorje'],
      ['ð', 'FOLD-ETH', 'Sauðárkrókur', 'saudarkrokur', 'arkrokur'],
      ['ħ', 'FOLD-H', 'Għajnsielem', 'ghajnsielem', 'ajnsielem'],
      ['ı', 'FOLD-I', 'Kırşehir', 'kirsehir', 'rsehir'],
      ['ł', 'FOLD-L', 'Białystok', 'bialystok', 'ystok'],
      ['ø', 'FOLD-O', 'Sørkjosen', 'sorkjosen', 'rkjosen'],
      ['œ', 'FOLD-OE', 'Rœschwoog', 'roeschwoog', 'schwoog'],
      ['ß', 'FOLD-SS', 'Großenhain', 'grossenhain', 'enhain'],
      ['þ', 'FOLD-TH', 'Þingeyri', 'thingeyri', 'ingeyri'],
      ['ŧ', 'FOLD-T', 'Vuoŧŧasjávri', 'vuottasjavri', 'asjavri'],
      ['ə', 'FOLD-E', 'Mingəçevir', 'mingecevir', 'cevir'],
      ['ᵫ', 'FOLD-UE', 'Grᵫnfeld', 'gruenfeld', 'nfeld'],
    ];
    const extra = withExtraAirports(
      FOLDS.map(
        ([, ident, name], i) =>
          `${990150 + i},"${ident}","small_airport","${name} Airport",35.3,25.4,100,"EU","GR","GR-M",,"no",,,,,,,`,
      ),
    );

    it.each(FOLDS)('folds %s inside its word (%s)', (_letter, ident, _name, word, fragment) => {
      expect(extra.idents(word)).toEqual([ident]);
      expect(extra.idents(fragment)).toEqual([]);
    });
  });
});

describe('country/region enrichment', () => {
  it('resolves country and region names', () => {
    expect(svc.country('US')?.name).toBe('United States');
    expect(svc.region('US-WA')?.name).toBe('Washington');
    expect(svc.country('XX')).toBeUndefined();
  });
});
