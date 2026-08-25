/**
 * @fileoverview Smoke coverage for every MCP definition shipped by the server.
 * @module tests/smoke/definitions.smoke.test
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
const { findAirportsTool } = await import('@/mcp-server/tools/definitions/find-airports.tool.js');
const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');
const { getAirportTool } = await import('@/mcp-server/tools/definitions/get-airport.tool.js');
const { listCountriesTool } = await import('@/mcp-server/tools/definitions/list-countries.tool.js');
const { searchAirportsTool } = await import(
  '@/mcp-server/tools/definitions/search-airports.tool.js'
);
const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');

describe('definition smoke coverage', () => {
  it('executes every shipped tool and resource definition', async () => {
    const searchAirports = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'seattle' }),
      createMockContext(),
    );
    const searchRunways = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'US' }),
      createMockContext(),
    );
    const getAirport = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA' }),
      createMockContext({ errors: getAirportTool.errors }),
    );
    const findAirports = await findAirportsTool.handler(
      findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31 }),
      createMockContext(),
    );
    const findNavaids = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: 'KSEA' }),
      createMockContext({ errors: findNavaidsTool.errors }),
    );
    const listCountries = await listCountriesTool.handler(
      listCountriesTool.input.parse({}),
      createMockContext(),
    );
    const airport = await airportResource.handler(
      airportResource.params!.parse({ code: 'KSEA' }),
      createMockContext({ errors: airportResource.errors, uri: new URL('airport://KSEA') }),
    );

    expect(searchAirports.airports.length).toBeGreaterThan(0);
    expect(searchRunways.runways.length).toBeGreaterThan(0);
    expect(getAirport.airport.ident).toBe('KSEA');
    expect(findAirports.airports.length).toBeGreaterThan(0);
    expect(findNavaids.navaids.length).toBeGreaterThan(0);
    expect(listCountries.countries.length).toBeGreaterThan(0);
    expect(airport.airport.ident).toBe('KSEA');
  });
});
