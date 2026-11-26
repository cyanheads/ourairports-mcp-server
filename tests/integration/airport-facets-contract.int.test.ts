/**
 * @fileoverview Country/region discovery and search contract regressions.
 * @module tests/integration/airport-facets-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { describe, expect, it, vi } from 'vitest';
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
const { findAirportsTool } = await import('@/mcp-server/tools/definitions/find-airports.tool.js');

describe('facet validation and scoped discovery', () => {
  for (const definition of [searchAirportsTool, searchRunwaysTool]) {
    toolContractSuite(definition, {
      success: [{ name: 'accepts a valid empty country', input: { country: 'PN' } }],
      errors: [
        {
          name: 'unknown country',
          input: { country: 'UK' },
          code: JsonRpcErrorCode.NotFound,
          reason: 'unknown_country',
        },
        {
          name: 'unknown region',
          input: { region: 'US-ZZ' },
          code: JsonRpcErrorCode.NotFound,
          reason: 'unknown_region',
        },
      ],
    });
    it(`${definition.name} keeps valid empty selections, compound regions, and whitespace rejection`, async () => {
      for (const input of [
        { country: 'PN' },
        { region: 'KS-U-A' },
        { country: 'US', region: 'CA-BC' },
      ]) {
        const result = await runToolContract(definition, input);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          totalCount: 0,
          notice: expect.stringContaining('No '),
        });
        expect(JSON.stringify(result.content)).toContain('No ');
      }
      for (const input of [
        { country: 'us' },
        { country: ' us ' },
        { region: 'us-wa' },
        { region: ' us-wa ' },
        { region: 'ar-u' },
        { region: 'us-u-a' },
        { region: 'TW-X-KM' },
        { country: 'XK' },
        { country: 'XP' },
        { country: 'ZZ' },
      ]) {
        expect((await runToolContract(definition, input)).isError).toBeFalsy();
      }
      for (const input of [{ country: ' ' }, { region: '\n' }]) {
        const result = await runToolContract(definition, input);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
      }
    });
    it(`${definition.name} rejects malformed and unknown facets on both surfaces`, async () => {
      for (const input of [
        { country: 'USA' },
        { region: 'Washington' },
        { region: 'WA' },
        { region: 'US_WA' },
      ]) {
        const result = await runToolContract(definition, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
        expect(JSON.stringify(result.content)).toMatch(/format|letters|segments/);
      }
      for (const [input, reason, code] of [
        [{ country: 'UK' }, 'unknown_country', 'UK'],
        [{ country: 'XX' }, 'unknown_country', 'XX'],
        [{ region: 'US-ZZ' }, 'unknown_region', 'US-ZZ'],
      ] as const) {
        const result = await runToolContract(definition, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: -32001,
            message: expect.stringContaining(code),
            data: {
              reason,
              recovery: { hint: expect.stringContaining('ourairports_list_countries') },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain(reason);
        expect(JSON.stringify(result.content)).toContain('ourairports_list_countries');
      }
    });
    it(`${definition.name} accepts literal empty facets as unset`, async () => {
      const blank = await runToolContract(definition, { country: '', region: '', limit: 1 });
      const omitted = await runToolContract(definition, { limit: 1 });
      expect(blank.isError).toBeFalsy();
      expect(blank.structuredContent).toEqual(omitted.structuredContent);
    });
  }
  it('restricts nested regions to one country and ANDs continent', async () => {
    const result = await runToolContract(listCountriesTool, {
      country: ' us ',
      include_regions: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      countries: [
        {
          code: 'US',
          regions: expect.arrayContaining([{ code: 'US-WA', name: 'Washington', airportCount: 2 }]),
        },
      ],
      totalCount: 1,
    });
    expect(JSON.stringify(result.content)).toContain('US-WA Washington');
    const mismatch = await runToolContract(listCountriesTool, { country: 'US', continent: 'EU' });
    expect(mismatch.isError).toBeFalsy();
    expect(mismatch.structuredContent).toMatchObject({
      countries: [],
      totalCount: 0,
      notice: expect.stringContaining('US'),
    });
    expect(JSON.stringify(mismatch.content)).toContain('EU');
    const kosovo = await runToolContract(listCountriesTool, {
      country: 'xk',
      include_regions: true,
    });
    expect(kosovo.structuredContent).toMatchObject({
      countries: [{ code: 'XK', regions: [{ code: 'KS-U-A' }] }],
      totalCount: 1,
    });
    expect(JSON.stringify(kosovo.content)).toContain('KS-U-A');
    expect(
      (await runToolContract(listCountriesTool, { include_regions: true })).isError,
    ).toBeFalsy();
    expect(
      (await runToolContract(listCountriesTool, { continent: 'EU', include_regions: true }))
        .isError,
    ).toBeFalsy();
    expect((await runToolContract(listCountriesTool, { country: '' })).structuredContent).toEqual(
      (await runToolContract(listCountriesTool, {})).structuredContent,
    );
    for (const country of ['USA', ' '])
      expect(
        (await runToolContract(listCountriesTool, { country })).structuredContent,
      ).toMatchObject({ error: { code: JsonRpcErrorCode.InvalidParams } });
  });
});

describe('closed type and scheduled service across the airport-facet tools (#33, #35)', () => {
  const ANKANG = { latitude: 32.7, longitude: 108.9 };
  toolContractSuite(searchAirportsTool, {
    success: [
      { name: 'type closed without include_closed', input: { type: 'closed' } },
      { name: 'scheduled_service', input: { scheduled_service: false, country: 'CN' } },
    ],
  });
  toolContractSuite(searchRunwaysTool, {
    success: [
      { name: 'type closed without include_closed_airports', input: { type: 'closed' } },
      { name: 'scheduled_service', input: { scheduled_service: true, region: 'US-WA' } },
    ],
  });
  toolContractSuite(findAirportsTool, {
    success: [
      { name: 'type closed without include_closed', input: { ...ANKANG, type: 'closed' } },
      { name: 'scheduled_service', input: { ...ANKANG, scheduled_service: true } },
    ],
  });

  /** totalCount on structuredContent and its `**N total**` line in content[]. */
  async function totals(results: Promise<Awaited<ReturnType<typeof runToolContract>>>[]) {
    return (await Promise.all(results)).map((result) => {
      expect(result.isError).toBeFalsy();
      const { totalCount } = result.structuredContent as { totalCount: number };
      expect(JSON.stringify(result.content)).toContain(`**${totalCount} total**`);
      return totalCount;
    });
  }

  it('type closed counts the closed airports with the closed flag omitted, false, or true', async () => {
    expect(
      await totals([
        runToolContract(searchAirportsTool, { type: 'closed', limit: 1 }),
        runToolContract(searchAirportsTool, { type: 'closed', include_closed: false, limit: 1 }),
        runToolContract(searchAirportsTool, { type: 'closed', include_closed: true, limit: 1 }),
        runToolContract(searchRunwaysTool, { type: 'closed', limit: 1 }),
        runToolContract(searchRunwaysTool, {
          type: 'closed',
          include_closed_airports: false,
          limit: 1,
        }),
        runToolContract(searchRunwaysTool, {
          type: 'closed',
          include_closed_airports: true,
          limit: 1,
        }),
        runToolContract(findAirportsTool, { ...ANKANG, type: 'closed', limit: 1 }),
        runToolContract(findAirportsTool, {
          ...ANKANG,
          type: 'closed',
          include_closed: false,
          limit: 1,
        }),
        runToolContract(findAirportsTool, { ...ANKANG, type: 'closed', include_closed: true }),
      ]),
    ).toEqual([6, 6, 6, 2, 2, 2, 1, 1, 1]);
  });

  it('scheduled_service narrows totalCount and leaves the closed exclusion in place', async () => {
    expect(
      await totals([
        runToolContract(searchAirportsTool, { limit: 1 }),
        runToolContract(searchAirportsTool, { scheduled_service: true, limit: 1 }),
        runToolContract(searchAirportsTool, { scheduled_service: false, limit: 1 }),
        runToolContract(searchAirportsTool, {
          scheduled_service: true,
          include_closed: true,
          limit: 1,
        }),
        runToolContract(searchAirportsTool, { scheduled_service: true, type: 'closed' }),
        runToolContract(searchRunwaysTool, { limit: 1 }),
        runToolContract(searchRunwaysTool, { scheduled_service: true, limit: 1 }),
        runToolContract(findAirportsTool, { ...ANKANG, limit: 1 }),
        runToolContract(findAirportsTool, { ...ANKANG, scheduled_service: true, limit: 1 }),
        runToolContract(findAirportsTool, { ...ANKANG, scheduled_service: false }),
      ]),
    ).toEqual([44, 19, 25, 20, 1, 9, 9, 3, 2, 1]);
  });
});

toolContractSuite(listCountriesTool, {
  success: [{ name: 'country-scoped regions', input: { country: 'US', include_regions: true } }],
  errors: [
    {
      name: 'unknown country with recovery',
      input: { country: 'UK' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'unknown_country',
    },
  ],
});

describe('pre-change characterization', () => {
  it('preserves ranking, caps, totals, blank-query browse and tokenless-query empty', async () => {
    const ranked = svc.search({ includeClosed: false, limit: 3 });
    expect(ranked.airports.map((a) => a.ident)).toEqual(['VIDP', 'KJFK', 'SBGL']);
    expect(ranked.totalMatched).toBe(44);
    expect(svc.search({ query: '   ', includeClosed: false, limit: 3 })).toEqual(ranked);
    expect(svc.search({ query: '!!!', includeClosed: false, limit: 3 })).toEqual({
      airports: [],
      totalMatched: 0,
      noSearchableTerms: true,
    });
    const result = await runToolContract(searchAirportsTool, {
      query: ' seattle ',
      country: ' us ',
      region: ' us-wa ',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      airports: [{ ident: 'KSEA' }],
      totalCount: 2,
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(JSON.stringify(result.content)).toContain('Seattle Tacoma International Airport');
    const empty = await runToolContract(searchRunwaysTool, { country: 'US', region: 'AR-X' });
    expect(empty.isError).toBeFalsy();
    expect(empty.structuredContent).toMatchObject({
      runways: [],
      totalCount: 0,
      notice: expect.stringContaining('No runways matched'),
    });
    expect(JSON.stringify(empty.content)).toContain('No runways matched');
  });
});
