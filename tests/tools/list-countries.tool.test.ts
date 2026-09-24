/**
 * @fileoverview Tests for ourairports_list_countries — counts, continent
 * filter, region nesting, the empty-continent notice, and escaped text in content[].
 * @module tests/tools/list-countries.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { listCountriesTool } = await import('@/mcp-server/tools/definitions/list-countries.tool.js');

describe('listCountriesTool', () => {
  it('lists countries with airport counts', async () => {
    const ctx = createMockContext();
    const result = await listCountriesTool.handler(listCountriesTool.input.parse({}), ctx);
    const us = result.countries.find((c) => c.code === 'US');
    expect(us?.airportCount).toBe(11);
    expect(us?.regions).toBeUndefined();
    expect((getEnrichment(ctx)?.totalCount as number) > 0).toBe(true);
  });

  it('filters by continent', async () => {
    const ctx = createMockContext();
    const result = await listCountriesTool.handler(
      listCountriesTool.input.parse({ continent: 'OC' }),
      ctx,
    );
    expect(result.countries.every((c) => c.continent === 'OC')).toBe(true);
  });

  it('nests regions on request', async () => {
    const ctx = createMockContext();
    const result = await listCountriesTool.handler(
      listCountriesTool.input.parse({ include_regions: true }),
      ctx,
    );
    const us = result.countries.find((c) => c.code === 'US');
    expect(us?.regions?.some((r) => r.code === 'US-WA')).toBe(true);
  });

  it('emits a notice when the continent matches nothing', async () => {
    const ctx = createMockContext();
    const result = await listCountriesTool.handler(
      listCountriesTool.input.parse({ continent: 'AN' }),
      ctx,
    );
    expect(result.countries).toHaveLength(0);
    expect(getEnrichment(ctx)?.notice).toMatch(/No countries found/);
  });
});

describe('listCountriesTool content rendering', () => {
  async function text(input: { continent?: 'EU' | 'NA'; include_regions?: boolean }) {
    const result = await runToolContract(listCountriesTool, input);
    expect(result.isError).toBeFalsy();
    return {
      text: result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n'),
      structured: result.structuredContent as Awaited<ReturnType<typeof listCountriesTool.handler>>,
    };
  }

  it('renders plain country and region lines byte-identically', async () => {
    const { text: out } = await text({ continent: 'NA', include_regions: true });
    expect(out).toContain('- **US** United States (NA) — 11 airports');
    expect(out).toContain('  - US-WA Washington — 2 airports');
  });

  it('escapes a region name while structuredContent keeps the raw value (NL-XX)', async () => {
    const { text: out, structured } = await text({ continent: 'EU', include_regions: true });
    const nl = structured.countries.find((c) => c.code === 'NL');
    expect(nl?.regions?.[0]?.name).toBe('*Offshore Platforms');
    expect(out).toContain(
      '- **NL** Netherlands (EU) — 0 airports\n  - NL-XX \\*Offshore Platforms — 0 airports',
    );
  });

  it('escapes a block marker that opens the region line, since the code starts the list item', () => {
    const [block] = listCountriesTool.format!({
      countries: [
        {
          code: 'XX',
          name: 'X',
          continent: null,
          airportCount: 1,
          regions: [{ code: '1. X', name: 'Y', airportCount: 1 }],
        },
      ],
    });
    expect(block).toMatchObject({ type: 'text' });
    expect((block as { text: string }).text).toContain('\n  - 1\\. X Y — 1 airports');
  });
});
