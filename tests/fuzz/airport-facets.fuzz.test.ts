/**
 * @fileoverview Shared country/region boundaries across search and discovery tools.
 * @module tests/fuzz/airport-facets.fuzz.test
 */
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});
const { searchAirportsTool } = await import(
  '@/mcp-server/tools/definitions/search-airports.tool.js'
);
const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');
const { listCountriesTool } = await import('@/mcp-server/tools/definitions/list-countries.tool.js');

for (const definition of [searchAirportsTool, searchRunwaysTool, listCountriesTool]) {
  it(`${definition.name} handles generated and adversarial facets without crashes or leaks`, async () => {
    const report = await fuzzTool(definition, { numRuns: 30, numAdversarial: 20, seed: 20261018 });
    expect(report.crashes).toHaveLength(0);
    expect(report.leaks).toHaveLength(0);
    expect(report.prototypePollution).toBe(false);
  });
}
