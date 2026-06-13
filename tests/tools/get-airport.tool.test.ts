/**
 * @fileoverview Tests for ourairports_get_airport — code resolution, inline
 * runways/frequencies, the resolution note, ambiguity warning, include
 * trimming, and the unknown_code error contract.
 * @module tests/tools/get-airport.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { getAirportTool } = await import('@/mcp-server/tools/definitions/get-airport.tool.js');

describe('getAirportTool', () => {
  it('resolves by IATA with inline runways and frequencies', async () => {
    const ctx = createMockContext();
    const input = getAirportTool.input.parse({ code: 'SEA' });
    const result = await getAirportTool.handler(input, ctx);

    expect(result.airport.ident).toBe('KSEA');
    expect(result.airport.iataCode).toBe('SEA');
    expect(result.resolvedVia).toBe('iata_code');
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    expect(result.airport.countryName).toBe('United States');
    expect(result.airport.regionName).toBe('Washington');
  });

  it('reports absent codes as null (00AA has no IATA/ICAO)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: '00AA' }), ctx);
    expect(result.airport.iataCode).toBeNull();
    expect(result.airport.icaoCode).toBeNull();
    expect(result.airport.gpsCode).toBe('00AA');
  });

  it('emits an ambiguity note for a shared national code', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'HBE' }), ctx);
    expect(result.resolutionNote).toMatch(/shared by more than one airport/);
  });

  it('trims related records via include', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA', include: ['runways'] }),
      ctx,
    );
    expect(result.runways.length).toBe(2);
    expect(result.frequencies).toEqual([]);
  });

  it('throws unknown_code for an unknown code', () => {
    const ctx = createMockContext({ errors: getAirportTool.errors });
    expect(() => getAirportTool.handler(getAirportTool.input.parse({ code: 'ZZZZ' }), ctx)).toThrow(
      /No airport found/,
    );
  });

  it('format() renders runways and frequencies', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'KSEA' }), ctx);
    const text = (getAirportTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    expect(text).toContain('Seattle Tacoma International Airport');
    expect(text).toContain('16L');
    expect(text).toContain('119.9 MHz');
  });
});
