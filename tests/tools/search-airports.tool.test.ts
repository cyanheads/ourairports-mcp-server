/**
 * @fileoverview Tests for ourairports_search_airports — text + facet matching,
 * ranking, closed filtering, truncation disclosure, the empty-result notice,
 * and exact coordinates / escaped text in content[].
 * @module tests/tools/search-airports.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext as createBaseContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
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

const createMockContext = () => createBaseContext({ errors: searchAirportsTool.errors });

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
    const effective = searchAirportsTool.output.extend(searchAirportsTool.enrichment!);
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
    const effective = searchAirportsTool.output.extend(searchAirportsTool.enrichment!);
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

  it('suggests an exact-code lookup on both response surfaces when a query has no matches', async () => {
    const result = await runToolContract(searchAirportsTool, { query: 'ZZZX' });
    expect(result.structuredContent).toMatchObject({
      airports: [],
      totalCount: 0,
      notice: expect.stringContaining('ourairports_get_airport'),
    });
    expect(JSON.stringify(result.content)).toContain('ourairports_get_airport');
  });

  it('keeps a multiline query literal in the notice on both response surfaces', async () => {
    const query = 'ZZZX\r\n- [lookup](https://example.com)';
    const result = await runToolContract(searchAirportsTool, { query });
    expect(result.structuredContent).toMatchObject({
      airports: [],
      notice: expect.stringContaining(query),
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain('ZZZX&#13;');
    expect(text).toContain('\n> \\- \\[lookup\\](https://example.com)');
  });

  // #1: a gibberish query no longer false-matches via a short indexed token.
  it('returns zero for a gibberish query that shares a leading letter with a short token', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'bzzqxw' }),
      ctx,
    );
    expect(result.airports).toHaveLength(0);
  });

  // #3: a non-blank query of only stopwords/punctuation gets a distinct
  // "no searchable terms" notice rather than the whole corpus or the generic
  // no-match guidance.
  it('emits the no-searchable-terms notice for a stopword-only query', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'the' }),
      ctx,
    );
    expect(result.airports).toHaveLength(0);
    expect(getEnrichment(ctx)?.notice).toMatch(/no searchable terms/i);
    const effective = searchAirportsTool.output.extend(searchAirportsTool.enrichment!);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
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

  // #7: country/region facets are trimmed before lookup; a padded facet matches
  // the same airports as the unpadded form, and a blank facet is rejected.
  it('matches a padded country facet by trimming (" US ")', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'seattle', country: ' US ', limit: 1 }),
      ctx,
    );
    expect(result.airports).toHaveLength(1);
    expect(result.airports[0]?.ident).toBe('KSEA');
  });

  it('matches a padded region facet by trimming (" US-WA ")', async () => {
    const ctx = createMockContext();
    const result = await searchAirportsTool.handler(
      searchAirportsTool.input.parse({ query: 'seattle', region: ' US-WA ' }),
      ctx,
    );
    expect(result.airports.every((a) => a.isoRegion === 'US-WA')).toBe(true);
    expect(result.airports.some((a) => a.ident === 'KSEA')).toBe(true);
  });

  it('rejects a whitespace-only country facet at schema validation', () => {
    expect(() => searchAirportsTool.input.parse({ country: '   ' })).toThrow();
  });

  it('defaults limit from config when omitted', () => {
    const input = searchAirportsTool.input.parse({ query: 'x' });
    expect(input.limit).toBeUndefined(); // resolved in handler, not schema
    expect(input.include_closed).toBe(false);
  });
});

describe('searchAirportsTool paging', () => {
  it('advances by returned rows and keeps the complete match count', async () => {
    const first = await runToolContract(searchAirportsTool, { query: 'seattle', limit: 1 });
    expect(first.structuredContent).toMatchObject({
      airports: [{ ident: 'KSEA' }],
      totalCount: 2,
      nextOffset: 1,
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(first.content.map((block) => 'text' in block && block.text).join('\n')).toContain(
      '**nextOffset:** 1',
    );
    const last = await runToolContract(searchAirportsTool, {
      query: 'seattle',
      limit: 1,
      offset: 1,
    });
    expect(last.structuredContent).toMatchObject({
      airports: [{ ident: 'KBFI' }],
      totalCount: 2,
    });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
    expect(last.structuredContent).not.toHaveProperty('truncated');
    expect(JSON.stringify(last.content)).toContain('KBFI');
    const past = await runToolContract(searchAirportsTool, {
      query: 'seattle',
      limit: 1,
      offset: 2,
    });
    expect(past.structuredContent).toMatchObject({
      airports: [],
      totalCount: 2,
      notice: expect.stringContaining('Offset 2'),
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(JSON.stringify(past.content)).toContain('Offset 2');
  });

  it('rejects a negative offset on both response surfaces', async () => {
    const result = await runToolContract(searchAirportsTool, { offset: -1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(JSON.stringify(result.content)).toContain('offset');
  });

  it('composes clamp and continuation notices on both response surfaces', async () => {
    const [airport] = svc.search({ includeClosed: false, limit: 1 }).airports;
    expect(airport).toBeDefined();
    const spy = vi.spyOn(svc, 'search').mockReturnValueOnce({
      airports: Array.from({ length: 100 }, (_, id) => ({ ...airport!, id })),
      totalMatched: 101,
    });
    try {
      const result = await runToolContract(searchAirportsTool, { limit: 101 });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
      expect(result.structuredContent).toMatchObject({
        cap: 100,
        nextOffset: 100,
        notice:
          'Requested limit 101 was clamped to 100. Use nextOffset as offset with the same query to continue.',
      });
      expect(JSON.stringify(result.content)).toContain('clamped to 100. Use nextOffset');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('searchAirportsTool content rendering', () => {
  it.each([
    ['jfk', 'KJFK', 'John F Kennedy International Airport'],
    ['seattle tacoma intl', 'KSEA', 'Seattle Tacoma International Airport'],
  ])('renders the leading match for %s', async (query, ident, name) => {
    const result = await runToolContract(searchAirportsTool, { query, limit: 1 });
    expect(result.structuredContent).toMatchObject({ airports: [{ ident, name }] });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(name) });
  });

  it('keeps forward prefix matches for airport text', async () => {
    const result = await runToolContract(searchAirportsTool, { query: 'seatt', limit: 2 });
    expect(result.structuredContent).toMatchObject({
      airports: [{ ident: 'KSEA' }, { ident: 'KBFI' }],
      totalCount: 2,
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Seattle Tacoma') });
  });

  it('renders every coordinate as the exact structuredContent number (KSEA 47.449001, -122.308998)', async () => {
    const result = await runToolContract(searchAirportsTool, { query: 'Seattle' });
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    const { airports } = result.structuredContent as Awaited<
      ReturnType<typeof searchAirportsTool.handler>
    >;
    expect(airports[0]?.ident).toBe('KSEA');
    for (const a of airports) {
      expect(text).toContain(`**Location:** ${a.latitudeDeg}, ${a.longitudeDeg} ·`);
    }
    expect(text).toContain(
      '**Location:** 47.449001, -122.308998 · elevation 433 ft · continent NA',
    );
  });

  it('escapes an airport name in the summary line ((*)Kasteli)', async () => {
    const result = await runToolContract(searchAirportsTool, { query: 'kasteli hellenic' });
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    expect(text).toContain('**(\\*)Kasteli Hellenic Air Force Base** (ident GR-0109, id 604508)');
  });
});
