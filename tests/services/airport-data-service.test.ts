/**
 * @fileoverview Behavior tests for the AirportDataService against the fixture
 * CSV slice — code resolution across all five spaces, collision handling, the
 * haversine nearest-neighbour scan, navaid kHz storage, the two navaid modes,
 * closed-airport filtering, country/region enrichment, and CSV header parsing.
 * @module tests/services/airport-data-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { AirportDataService } from '@/services/airport-data/airport-data-service.js';
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
    expect(r?.ambiguous).toBe(false);
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

  it('flags gps/local collisions as ambiguous (HBE in US and AR)', () => {
    const r = svc.resolveByCode('HBE');
    expect(r).toBeDefined();
    expect(r?.ambiguous).toBe(true);
    // First in CSV order (US row) wins.
    expect(r?.airport.isoCountry).toBe('US');
  });

  it('keeps globally-unique IATA/ICAO non-ambiguous', () => {
    expect(svc.resolveByCode('JFK')?.ambiguous).toBe(false);
    expect(svc.resolveByCode('KJFK')?.ambiguous).toBe(false);
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
    const hits = svc.nearbyAirports(47.45, -122.31, 100, 10, undefined, false);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.airport.ident).toBe('KSEA');
    expect(hits[0]?.distanceKm).toBeLessThan(hits[1]?.distanceKm as number);
    expect(hits[0]?.bearingDeg).toBeGreaterThanOrEqual(0);
    expect(hits[0]?.bearingDeg).toBeLessThanOrEqual(360);
  });

  it('excludes closed airports by default and includes them on opt-in', () => {
    const withoutClosed = svc.nearbyAirports(47.5, -122.4, 50, 50, undefined, false);
    expect(withoutClosed.some((h) => h.airport.type === 'closed')).toBe(false);
    const withClosed = svc.nearbyAirports(47.5, -122.4, 50, 50, undefined, true);
    expect(withClosed.some((h) => h.airport.ident === 'CLOSEDX')).toBe(true);
  });

  it('respects the radius and the type filter', () => {
    const far = svc.nearbyAirports(0, 0, 100, 10, undefined, false);
    expect(far).toHaveLength(0);
    const onlyLarge = svc.nearbyAirports(47.45, -122.31, 200, 10, 'large_airport', false);
    expect(onlyLarge.every((h) => h.airport.type === 'large_airport')).toBe(true);
  });
});

describe('navaids', () => {
  it('stores frequency in kHz for all types', () => {
    const navaids = svc.navaidsForAirport('KSEA', undefined, 20);
    expect(navaids).toHaveLength(1);
    expect(navaids[0]?.type).toBe('VORTAC');
    expect(navaids[0]?.frequencyKhz).toBe(116800); // 116.8 MHz stored as kHz
  });

  it('finds navaids near a coordinate, nearest-first', () => {
    const hits = svc.nearbyNavaids(47.45, -122.31, 200, 20, undefined);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.navaid.ident).toBe('SEA');
    expect(hits[0]?.distanceKm).toBeLessThanOrEqual(hits[hits.length - 1]?.distanceKm as number);
  });

  it('filters navaids by type', () => {
    const ndbs = svc.nearbyNavaids(40.633, -73.778, 100, 20, 'NDB');
    expect(ndbs.every((h) => h.navaid.type === 'NDB')).toBe(true);
    expect(ndbs.some((h) => h.navaid.ident === 'JFK')).toBe(true);
  });

  it('returns empty list for an airport with no associated navaids', () => {
    // 00AA has no navaid linking to it.
    expect(svc.navaidsForAirport('00AA', undefined, 20)).toEqual([]);
  });

  it('does not index standalone navaids (empty associated_airport) under any airport', () => {
    // NDLS is enroute with no associated_airport — only reachable via coordinate mode.
    const coord = svc.nearbyNavaids(40.0, -160.0, 50, 20, undefined);
    expect(coord.some((h) => h.navaid.ident === 'NDLS')).toBe(true);
  });
});

describe('resolveAirportIdent', () => {
  it('returns the ident for a valid code', () => {
    expect(svc.resolveAirportIdent('SEA').ident).toBe('KSEA');
  });

  it('throws notFound (unknown_code) for an invalid code', () => {
    expect(() => svc.resolveAirportIdent('ZZZZ')).toThrowError(/No airport found/);
  });
});

describe('listCountries', () => {
  it('lists countries with airport counts, sorted by name', () => {
    const countries = svc.listCountries(undefined, false);
    const us = countries.find((c) => c.code === 'US');
    expect(us).toBeDefined();
    expect(us?.name).toBe('United States');
    // Non-closed US airports in the fixture: KSEA, KJFK, 00AA, 00AK, USHBE, KBFI = 6 (CLOSEDX excluded).
    expect(us?.airportCount).toBe(6);
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
});

describe('country/region enrichment', () => {
  it('resolves country and region names', () => {
    expect(svc.country('US')?.name).toBe('United States');
    expect(svc.region('US-WA')?.name).toBe('Washington');
    expect(svc.country('ZZ')).toBeUndefined();
  });
});
