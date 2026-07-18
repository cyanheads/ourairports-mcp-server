/**
 * @fileoverview Tests for the airport://{code} resource — code resolution,
 * inline runways/frequencies, and the unknown_code error.
 * @module tests/resources/airport.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { airportResource } = await import('@/mcp-server/resources/definitions/airport.resource.js');

describe('airportResource', () => {
  it('resolves by ICAO with runways and frequencies inline', async () => {
    const ctx = createMockContext();
    const params = airportResource.params.parse({ code: 'KSEA' });
    const result = await airportResource.handler(params, ctx);
    expect(result.airport.ident).toBe('KSEA');
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    expect(result.resolvedVia).toBe('ident');
  });

  it('throws unknown_code for an unknown code', () => {
    const ctx = createMockContext({ errors: airportResource.errors });
    const params = airportResource.params.parse({ code: 'ZZZZ' });
    expect(() => airportResource.handler(params, ctx)).toThrow(/No airport found/);
  });

  // #7: code is trimmed before lookup; a padded code resolves and a
  // whitespace-only code fails schema validation.
  it('resolves a padded code by trimming ("  ksea  ")', async () => {
    const ctx = createMockContext();
    const params = airportResource.params.parse({ code: '  ksea  ' });
    const result = await airportResource.handler(params, ctx);
    expect(result.airport.ident).toBe('KSEA');
  });

  it('rejects a whitespace-only code at schema validation', () => {
    expect(() => airportResource.params.parse({ code: '   ' })).toThrow();
  });
});
