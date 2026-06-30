/**
 * @fileoverview Tests for ourairports_list_countries — counts, continent
 * filter, region nesting, and the empty-continent notice.
 * @module tests/tools/list-countries.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    expect(us?.airportCount).toBe(10);
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
