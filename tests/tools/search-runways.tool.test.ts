/**
 * @fileoverview Tests for ourairports_search_runways — airport + runway facet
 * filtering, the case-insensitive surface substring match, the sparse
 * length/width exclusion rule, closed-airport / closed-runway defaults,
 * truncation disclosure, the empty-result notice, and effective-output parity.
 * @module tests/tools/search-runways.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');

describe('searchRunwaysTool', () => {
  it('filters by country facet', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'SB' }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.airport.isoCountry === 'SB')).toBe(true);
  });

  it('filters by region facet', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-NY' }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.airport.isoRegion === 'US-NY')).toBe(true);
  });

  it('filters by airport type facet', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ type: 'large_airport' }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.airport.type === 'large_airport')).toBe(true);
  });

  it('filters by minimum length, excluding shorter runways', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ min_length_ft: 12000 }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => (r.runway.lengthFt as number) >= 12000)).toBe(true);
    // KSEA's 11901 ft runway is just under the threshold — must be excluded.
    expect(result.runways.some((r) => r.runway.lengthFt === 11901)).toBe(false);
  });

  it('filters by minimum width', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ min_width_ft: 200 }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => (r.runway.widthFt as number) >= 200)).toBe(true);
  });

  it('matches surface as a case-insensitive substring, not an exact code', async () => {
    const ctx = createMockContext();
    // Query "con" (lowercase) against the fixture's "CON" (uppercase) surface.
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ surface: 'con' }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.runway.surface?.toLowerCase().includes('con'))).toBe(true);
    // "asp" matches the ASP-family runways (multiple), proving substring breadth.
    const asp = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ surface: 'asp' }),
      createMockContext(),
    );
    expect(asp.runways.length).toBeGreaterThan(1);
    expect(asp.runways.every((r) => r.runway.surface?.toLowerCase().includes('asp'))).toBe(true);
  });

  it('filters by lighting (lighted: false returns only unlighted runways)', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ lighted: false }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.runway.lighted === false)).toBe(true);
  });

  it('filters by lighting (lighted: true excludes unlighted runways)', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ lighted: true }),
      ctx,
    );
    expect(result.runways.length).toBeGreaterThan(0);
    expect(result.runways.every((r) => r.runway.lighted === true)).toBe(true);
  });

  // Closed runways at an OPEN airport are excluded unless opted in.
  it('excludes closed runways by default, includes them on request', async () => {
    const base = searchRunwaysTool.input.parse({ region: 'US-NY' });
    const defaultResult = await searchRunwaysTool.handler(base, createMockContext());
    expect(defaultResult.runways.every((r) => r.runway.closed === false)).toBe(true);

    const opened = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-NY', include_closed_runways: true }),
      createMockContext(),
    );
    expect(opened.runways.length).toBeGreaterThan(defaultResult.runways.length);
    expect(opened.runways.some((r) => r.runway.closed === true)).toBe(true);
  });

  // Runways at a CLOSED airport are excluded unless opted in.
  it('excludes runways at closed airports by default, includes them on request', async () => {
    const defaultResult = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-WA' }),
      createMockContext(),
    );
    expect(defaultResult.runways.every((r) => r.airport.type !== 'closed')).toBe(true);

    const opened = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-WA', include_closed_airports: true }),
      createMockContext(),
    );
    expect(opened.runways.length).toBeGreaterThan(defaultResult.runways.length);
    expect(opened.runways.some((r) => r.airport.type === 'closed')).toBe(true);
  });

  // The core sparse-field rule: a runway with an unknown length/width must NOT
  // pass a min_*_ft filter — unknown is excluded, never assumed to meet it.
  it('excludes runways with unknown length when min_length_ft is set', async () => {
    // Without a min filter, the sparse runway (unknown length) IS present.
    const unfiltered = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'SB' }),
      createMockContext(),
    );
    expect(unfiltered.runways.some((r) => r.runway.lengthFt === null)).toBe(true);

    // With even a trivially low min, the unknown-length runway is dropped.
    const filtered = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'SB', min_length_ft: 1 }),
      createMockContext(),
    );
    expect(filtered.runways.length).toBeLessThan(unfiltered.runways.length);
    expect(filtered.runways.every((r) => r.runway.lengthFt !== null)).toBe(true);
  });

  it('excludes runways with unknown width when min_width_ft is set', async () => {
    const unfiltered = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'SB' }),
      createMockContext(),
    );
    const filtered = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'SB', min_width_ft: 1 }),
      createMockContext(),
    );
    expect(filtered.runways.length).toBeLessThan(unfiltered.runways.length);
    expect(filtered.runways.every((r) => r.runway.widthFt !== null)).toBe(true);
  });

  it('discloses truncation via enrichment', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ limit: 1 }),
      ctx,
    );
    expect(result.runways).toHaveLength(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment?.truncated).toBe(true);
    expect(enrichment?.shown).toBe(1);
    expect((enrichment?.totalCount as number) > 1).toBe(true);
  });

  /**
   * Regression (mirrors search-airports): the framework parses the result
   * against output.extend(enrichment). On a non-truncated result the handler
   * never sets truncated/shown/cap, so those enrichment fields must be optional
   * or this parse throws on the happy path.
   */
  it('produces a valid effective output on a non-truncated result', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-NY' }),
      ctx,
    );
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
    expect(getEnrichment(ctx)?.truncated).toBeUndefined();
  });

  it('produces a valid effective output on a truncated result', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ limit: 1 }),
      ctx,
    );
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
  });

  it('emits a notice when nothing matches', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ country: 'ZZ' }),
      ctx,
    );
    expect(result.runways).toHaveLength(0);
    expect(getEnrichment(ctx)?.notice).toMatch(/No runways matched/);
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
  });

  it('rejects a whitespace-only country facet at schema validation', () => {
    expect(() => searchRunwaysTool.input.parse({ country: '   ' })).toThrow();
  });

  it('defaults limit from config and closed flags from the schema', () => {
    const input = searchRunwaysTool.input.parse({ country: 'US' });
    expect(input.limit).toBeUndefined(); // resolved in the handler, not the schema
    expect(input.include_closed_airports).toBe(false);
    expect(input.include_closed_runways).toBe(false);
  });

  it('format() renders every airport and runway field', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ region: 'US-WA', limit: 50 }),
      ctx,
    );
    const text = (searchRunwaysTool.format?.(result) ?? []).map((c) => c.text).join('\n');
    expect(text).toContain('Seattle Tacoma International Airport');
    expect(text).toContain('16L'); // runway end designator
    expect(text).toContain('surface:'); // runway surface line
    expect(text).toContain('headings (true):'); // runway headings line
    expect(text).toContain('CON'); // KSEA surface value rendered
  });
});
