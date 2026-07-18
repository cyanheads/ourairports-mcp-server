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

  // #2: a globally-unique ident resolves to its own airport even when an earlier
  // CSV row uses the same string as a gps/local code.
  it('resolves a shadowed unique ident to its own airport (5MO → Plattsburg)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: '5MO' }), ctx);
    expect(result.airport.ident).toBe('5MO');
    expect(result.airport.name).toBe('Plattsburg Airpark');
    expect(result.resolvedVia).toBe('ident');
  });

  // #5: `include` selection is echoed via the `included` output field, and
  // format() distinguishes an omitted relation ("not requested") from a
  // genuinely empty one ("None recorded").
  it('include default returns both relations and lists them in `included`', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'KSEA' }), ctx);
    expect(result.included).toEqual(['runways', 'frequencies']);
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    const text = (getAirportTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    expect(text).toContain('**Included:** runways, frequencies');
    expect(text).not.toContain('Not requested');
    expect(text).not.toContain('None recorded');
  });

  it('include ["runways"] omits frequencies and labels the section "not requested", not "None recorded"', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA', include: ['runways'] }),
      ctx,
    );
    expect(result.included).toEqual(['runways']);
    expect(result.runways.length).toBe(2);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    // KSEA HAS frequencies — omitting them must not read as "None recorded".
    expect(text).toMatch(/### Frequencies\n_Not requested/);
    expect(text).not.toContain('### Frequencies (0)');
    expect(text).toContain('16L'); // runways still rendered
  });

  it('include [] omits both relations (neither shown as "None recorded")', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA', include: [] }),
      ctx,
    );
    expect(result.included).toEqual([]);
    expect(result.runways).toEqual([]);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    expect(text).toContain('**Included:** none');
    expect(text).not.toContain('None recorded');
    expect(text.match(/_Not requested/g)?.length).toBe(2);
  });

  it('a requested relation with no records still reads "None recorded" (00AA has no frequencies)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: '00AA', include: ['frequencies'] }),
      ctx,
    );
    expect(result.included).toEqual(['frequencies']);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    expect(text).toMatch(/### Frequencies \(0\)\n_None recorded\._/);
    expect(text).toMatch(/### Runways\n_Not requested/); // runways not requested here
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

  // #7: code is trimmed before lookup; a padded code resolves, and a
  // whitespace-only code fails schema validation rather than becoming unknown_code.
  it('resolves a padded code by trimming ("  SEA  " → KSEA)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: '  SEA  ' }),
      ctx,
    );
    expect(result.airport.ident).toBe('KSEA');
  });

  it('rejects a whitespace-only code at schema validation, not as unknown_code', () => {
    expect(() => getAirportTool.input.parse({ code: '   ' })).toThrow();
  });
});
