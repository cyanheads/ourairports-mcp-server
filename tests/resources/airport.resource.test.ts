/**
 * @fileoverview Tests for the airport://{code} resource — code resolution,
 * inline runways/frequencies with displaced thresholds, the shared-code
 * resolution note (identical to ourairports_get_airport), and the unknown_code error.
 * @module tests/resources/airport.resource.test
 */

import { createMockContext as createBaseMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { airportResource } = await import('@/mcp-server/resources/definitions/airport.resource.js');
const { getAirportTool } = await import('@/mcp-server/tools/definitions/get-airport.tool.js');
const createMockContext = () => createBaseMockContext({ errors: airportResource.errors });

describe('airportResource', () => {
  it('resolves by ICAO with runways and frequencies inline', async () => {
    const ctx = createMockContext();
    const params = airportResource.params!.parse({ code: 'KSEA' });
    const result = await airportResource.handler(params, ctx);
    expect(result.airport.ident).toBe('KSEA');
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    expect(result.resolvedVia).toBe('ident');
  });

  it('throws unknown_code for an unknown code', () => {
    const ctx = createMockContext();
    const params = airportResource.params!.parse({ code: 'ZZZZ' });
    expect(() => airportResource.handler(params, ctx)).toThrow(/No airport found/);
  });

  // #7: code is trimmed before lookup; a padded code resolves and a
  // whitespace-only code fails schema validation.
  it('resolves a padded code by trimming ("  ksea  ")', async () => {
    const ctx = createMockContext();
    const params = airportResource.params!.parse({ code: '  ksea  ' });
    const result = await airportResource.handler(params, ctx);
    expect(result.airport.ident).toBe('KSEA');
  });

  it('rejects a whitespace-only code at schema validation', () => {
    expect(() => airportResource.params!.parse({ code: '   ' })).toThrow();
  });
});

describe('airportResource runway thresholds and resolution note', () => {
  const read = async (code: string) =>
    airportResource.output!.parse(
      await airportResource.handler(airportResource.params!.parse({ code }), createMockContext()),
    );

  it('exposes displaced thresholds through RunwaySchema (VIDP 271000), null when not recorded', async () => {
    const result = await read('VIDP');
    expect(result.runways.find((r) => r.id === 271000)).toMatchObject({
      lengthFt: 14534,
      leDisplacedThresholdFt: 2100,
      heDisplacedThresholdFt: 4790,
    });
    expect(result.runways.find((r) => r.id === 236778)).toMatchObject({
      leDisplacedThresholdFt: null,
      heDisplacedThresholdFt: 499,
    });
  });

  it('keeps the plain note for a code on one airport (KSEA)', async () => {
    expect((await read('KSEA')).resolutionNote).toBe('Resolved via ident.');
  });

  it.each(['GIG', 'HBE', 'HBI', 'AKA', 'LGTL', '5MO', '1A8', 'ERT', 'SEA'])(
    'returns the same note as ourairports_get_airport (%s)',
    async (code) => {
      const tool = await getAirportTool.handler(
        getAirportTool.input.parse({ code }),
        createBaseMockContext({ errors: getAirportTool.errors }),
      );
      expect((await read(code)).resolutionNote).toBe(tool.resolutionNote);
    },
  );

  it('names the IATA owner an ident shadows (GIG → SBGL)', async () => {
    expect((await read('GIG')).resolutionNote).toContain('1 other airport: SBGL (BR, iata_code)');
  });
});
