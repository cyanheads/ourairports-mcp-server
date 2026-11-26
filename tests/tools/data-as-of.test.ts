/**
 * @fileoverview `dataAsOf` on every success path: each tool's structuredContent
 * and content[] trailer carry the bundled snapshot's publication time — or null
 * when the data directory has no snapshot.json — and airport://{code} carries it
 * in its JSON output. Runs through the production result path (output parse,
 * enrichment parse, trailer), not the raw mock accumulator.
 * @module tests/tools/data-as-of.test
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE_DATA_DIR, loadFixtureService } from '../fixtures/load.js';

const fixtureSvc = await loadFixtureService();
let svc = fixtureSvc;
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { AirportDataService } = await import('@/services/airport-data/airport-data-service.js');
const { airportResource } = await import('@/mcp-server/resources/definitions/airport.resource.js');
const { findAirportsTool } = await import('@/mcp-server/tools/definitions/find-airports.tool.js');
const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');
const { getAirportTool } = await import('@/mcp-server/tools/definitions/get-airport.tool.js');
const { listCountriesTool } = await import('@/mcp-server/tools/definitions/list-countries.tool.js');
const { searchAirportsTool } = await import(
  '@/mcp-server/tools/definitions/search-airports.tool.js'
);
const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');

/** sourceLastModified in tests/fixtures/data/snapshot.json. */
const DATA_AS_OF = '2026-11-25T02:53:49.000Z';
const SEA = { latitude: 47.45, longitude: -122.31 };

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const textOf = (result: ContractResult) =>
  result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');

/** A service over a copy of the fixture data without snapshot.json. */
async function serviceWithoutSnapshot() {
  const dir = await mkdtemp(join(tmpdir(), 'ourairports-no-snapshot-'));
  await cp(FIXTURE_DATA_DIR, dir, { recursive: true });
  await rm(join(dir, 'snapshot.json'));
  const bare = new AirportDataService(dir);
  await bare.load();
  return { bare, dir };
}

const SUCCESS_PATHS: [string, () => Promise<ContractResult>][] = [
  ['search_airports match', () => runToolContract(searchAirportsTool, { query: 'seattle' })],
  [
    'search_airports truncated page',
    () => runToolContract(searchAirportsTool, { query: 'seattle', limit: 1 }),
  ],
  ['search_airports empty', () => runToolContract(searchAirportsTool, { query: 'zzznotaplace' })],
  [
    'search_airports no searchable terms',
    () => runToolContract(searchAirportsTool, { query: 'the' }),
  ],
  [
    'search_airports past end',
    () => runToolContract(searchAirportsTool, { query: 'seattle', offset: 500 }),
  ],
  ['search_runways match', () => runToolContract(searchRunwaysTool, { region: 'US-WA' })],
  ['search_runways spatial', () => runToolContract(searchRunwaysTool, { ...SEA, limit: 1 })],
  [
    'search_runways empty',
    () => runToolContract(searchRunwaysTool, { region: 'US-WA', min_length_ft: 99_999 }),
  ],
  [
    'search_runways past end',
    () => runToolContract(searchRunwaysTool, { region: 'US-WA', offset: 500 }),
  ],
  ['get_airport', () => runToolContract(getAirportTool, { code: 'KSEA' })],
  [
    'get_airport with no relations',
    () => runToolContract(getAirportTool, { code: '00AA', include: [] }),
  ],
  ['find_airports match', () => runToolContract(findAirportsTool, { ...SEA, limit: 1 })],
  // Every match on one page under the default limit: the path that sets no notice.
  ['find_airports single page', () => runToolContract(findAirportsTool, SEA)],
  [
    'find_airports empty',
    () => runToolContract(findAirportsTool, { latitude: 0, longitude: 0, radius_km: 50 }),
  ],
  ['find_airports past end', () => runToolContract(findAirportsTool, { ...SEA, offset: 500 })],
  ['find_navaids coordinate mode', () => runToolContract(findNavaidsTool, { ...SEA, limit: 1 })],
  [
    'find_navaids coordinate mode empty',
    () => runToolContract(findNavaidsTool, { latitude: 0, longitude: 0, radius_km: 10 }),
  ],
  ['find_navaids airport mode', () => runToolContract(findNavaidsTool, { airport_code: 'KSEA' })],
  [
    'find_navaids airport mode, shared code',
    () => runToolContract(findNavaidsTool, { airport_code: 'LEN', limit: 1 }),
  ],
  [
    'find_navaids airport mode, no-navaid notice',
    () => runToolContract(findNavaidsTool, { airport_code: '00AA' }),
  ],
  [
    'find_navaids airport mode past end',
    () => runToolContract(findNavaidsTool, { airport_code: 'KJFK', offset: 5 }),
  ],
  ['find_navaids ident mode', () => runToolContract(findNavaidsTool, { ident: 'BIK' })],
  [
    'find_navaids ident mode unmatched',
    () => runToolContract(findNavaidsTool, { ident: 'NO-SUCH-NAVAID' }),
  ],
  ['list_countries', () => runToolContract(listCountriesTool, {})],
  ['list_countries empty', () => runToolContract(listCountriesTool, { continent: 'AF' })],
];

describe('dataAsOf on every tool success path', () => {
  it.each(SUCCESS_PATHS)(
    '%s carries it in structuredContent and the trailer',
    async (_path, run) => {
      const result = await run();
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toHaveProperty('dataAsOf', DATA_AS_OF);
      expect(textOf(result)).toContain(`**dataAsOf:** \`${DATA_AS_OF}\``);
    },
  );

  it.each([
    ['get_airport unknown_code', () => runToolContract(getAirportTool, { code: 'ZZZZZZ' })],
    ['find_navaids mode_conflict', () => runToolContract(findNavaidsTool, {})],
  ])('leaves error results unchanged (%s)', async (_path, run) => {
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty('dataAsOf');
    expect(textOf(result)).not.toContain('dataAsOf');
  });
});

describe('dataAsOf without snapshot.json', () => {
  const pending = serviceWithoutSnapshot();
  afterAll(async () => {
    svc = fixtureSvc;
    await rm((await pending).dir, { recursive: true, force: true });
  });

  it('reports null on both surfaces, on its own trailer line after a notice', async () => {
    svc = (await pending).bare;
    const result = await runToolContract(findNavaidsTool, { airport_code: '00AA' });
    expect(result.structuredContent).toHaveProperty('dataAsOf', null);
    const text = textOf(result);
    expect(text).toMatch(/\n\*\*dataAsOf:\*\* null$/);
    expect(text).not.toContain('> **dataAsOf');
  });

  it('reports null through airport://{code}', async () => {
    svc = (await pending).bare;
    const record = airportResource.output!.parse(
      await airportResource.handler(
        airportResource.params!.parse({ code: 'KSEA' }),
        createMockContext({ errors: airportResource.errors }),
      ),
    );
    expect(record.dataAsOf).toBeNull();
  });
});
