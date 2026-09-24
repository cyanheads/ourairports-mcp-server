/**
 * @fileoverview Behavior tests for the AirportDataService against the fixture
 * CSV slice — code resolution across all five spaces, collision handling, the
 * haversine nearest-neighbour scan, navaid kHz storage, the two navaid modes,
 * closed-airport filtering, country/region enrichment, and CSV header parsing.
 * @module tests/services/airport-data-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { AirportDataService } from '@/services/airport-data/airport-data-service.js';
import { nearest } from '@/services/airport-data/geo.js';
import { loadFixtureService } from '../fixtures/load.js';

let svc: AirportDataService;

beforeAll(async () => {
  svc = await loadFixtureService();
});

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
  it('ranks nearest-first and computes distance/bearing', () => {
    // Near Seattle — KSEA and KBFI are ~7 km apart.
    const { airports: hits } = svc.nearbyAirports(47.45, -122.31, 100, 10, undefined, false);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.airport.ident).toBe('KSEA');
    expect(hits[0]?.distanceKm).toBeLessThan(hits[1]?.distanceKm as number);
    expect(hits[0]?.bearingDeg).toBeGreaterThanOrEqual(0);
    expect(hits[0]?.bearingDeg).toBeLessThanOrEqual(360);
  });

  it('excludes closed airports by default and includes them on opt-in', () => {
    const withoutClosed = svc.nearbyAirports(47.5, -122.4, 50, 50, undefined, false);
    expect(withoutClosed.airports.some((h) => h.airport.type === 'closed')).toBe(false);
    const withClosed = svc.nearbyAirports(47.5, -122.4, 50, 50, undefined, true);
    expect(withClosed.airports.some((h) => h.airport.ident === 'CLOSEDX')).toBe(true);
  });

  it('respects the radius and the type filter', () => {
    const far = svc.nearbyAirports(0, 0, 100, 10, undefined, false);
    expect(far).toEqual({ airports: [], totalMatched: 0 });
    const onlyLarge = svc.nearbyAirports(47.45, -122.31, 200, 10, 'large_airport', false);
    expect(onlyLarge.airports.every((h) => h.airport.type === 'large_airport')).toBe(true);
  });

  it('reports the filtered in-radius total before the limit (#11)', () => {
    const capped = svc.nearbyAirports(47.45, -122.31, 100, 1, undefined, false);
    expect(capped.airports.map((h) => h.airport.ident)).toEqual(['KSEA']);
    expect(capped.totalMatched).toBe(2);
    expect(svc.nearbyAirports(47.45, -122.31, 100, 1, undefined, true).totalMatched).toBe(3);
    expect(svc.nearbyAirports(47.45, -122.31, 100, 1, 'large_airport', false).totalMatched).toBe(1);
    const all = svc.nearbyAirports(47.45, -122.31, 100, 2, undefined, false);
    expect(all.airports).toHaveLength(2);
    expect(all.totalMatched).toBe(2);
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
    // NDLS is enroute with no associated_airport — only reachable via coordinate mode.
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

describe('country/region enrichment', () => {
  it('resolves country and region names', () => {
    expect(svc.country('US')?.name).toBe('United States');
    expect(svc.region('US-WA')?.name).toBe('Washington');
    expect(svc.country('ZZ')).toBeUndefined();
  });
});
