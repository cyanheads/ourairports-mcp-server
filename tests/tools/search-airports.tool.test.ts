/**
 * @fileoverview Tests for ourairports_search_airports — text + facet matching,
 * ranking, closed filtering, truncation disclosure, and the empty-result notice.
 * @module tests/tools/search-airports.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

describe('searchAirportsTool', () => {
  it('matches by name and ranks the major airport first', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'seattle' }),
      ctx,
    );
    expect(result.airports[0]?.ident).toBe('KSEA');
  });

  it('discloses truncation via enrichment', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ limit: 1 }),
      ctx,
    );
    expect(result.airports).toHaveLength(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment?.truncated).toBe(true);
    expect(enrichment?.shown).toBe(1);
    expect((enrichment?.totalCount as number) > 1).toBe(true);
  });

  /**
   * Regression: the framework merges `output` + enrichment and parses the result
   * against `output.extend(enrichment)` (buildToolSuccessResult). When a result
   * is NOT truncated, the handler never sets truncated/shown/cap — so those
   * enrichment fields must be optional, or this parse throws a ValidationError on
   * the common happy path. Asserting the effective-output parse here exercises
   * exactly what the live transport does (the bare handler call does not).
   */
  it('produces a valid effective output on a non-truncated result', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'seattle' }),
      ctx,
    );
    const effective = searchAirportsTool.output.extend(searchAirportsTool.enrichment);
    const parsed = effective.safeParse({ ...result, ...getEnrichment(ctx) });
    expect(parsed.success).toBe(true);
    expect(getEnrichment(ctx)?.truncated).toBeUndefined();
  });

  it('produces a valid effective output on an empty result', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'zzznotaplace' }),
      ctx,
    );
    const effective = searchAirportsTool.output.extend(searchAirportsTool.enrichment);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
  });

  it('emits a notice when nothing matches', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'zzznotaplace' }),
      ctx,
    );
    expect(result.airports).toHaveLength(0);
    expect(getEnrichment(ctx)?.notice).toMatch(/No airports matched/);
  });

  it('excludes closed airports by default', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'field' }),
      ctx,
    );
    expect(result.airports.some((a) => a.type === 'closed')).toBe(false);
  });

  it('filters by region facet', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ region: 'US-WA' }),
      ctx,
    );
    expect(result.airports.every((a) => a.isoRegion === 'US-WA')).toBe(true);
  });

  it('defaults limit from config when omitted', () => {
    const input = searchAirportsTool.input.parse({ query: 'x' });
    expect(input.limit).toBeUndefined(); // resolved in handler, not schema
    expect(input.include_closed).toBe(false);
  });
});
