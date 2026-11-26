/**
 * @fileoverview Tests for ourairports_search_runways — airport + runway facet
 * filtering, the case-insensitive surface substring match, the sparse
 * length/width exclusion rule, closed-airport / closed-runway defaults,
 * truncation disclosure, the empty-result notice, effective-output parity,
 * displaced thresholds, and escaped text / exact coordinates in content[].
 * @module tests/tools/search-runways.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
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

const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');

const createMockContext = () => createBaseContext({ errors: searchRunwaysTool.errors });

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
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment!);
    expect(effective.safeParse({ ...result, ...getEnrichment(ctx) }).success).toBe(true);
    expect(getEnrichment(ctx)?.truncated).toBeUndefined();
  });

  it('produces a valid effective output on a truncated result', async () => {
    const ctx = createMockContext();
    const result = await searchRunwaysTool.handler(
      searchRunwaysTool.input.parse({ limit: 1 }),
      ctx,
    );
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment!);
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
    const effective = searchRunwaysTool.output.extend(searchRunwaysTool.enrichment!);
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
    const text = (searchRunwaysTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    expect(text).toContain('Seattle Tacoma International Airport');
    expect(text).toContain('16L'); // runway end designator
    expect(text).toContain('surface:'); // runway surface line
    expect(text).toContain('headings (true):'); // runway headings line
    expect(text).toContain('CON'); // KSEA surface value rendered
  });
});

describe('searchRunwaysTool content and displaced thresholds', () => {
  /** Run through the public contract so content[] includes the enrichment trailer. */
  async function call(input: z.input<typeof searchRunwaysTool.input>) {
    const result = await runToolContract(searchRunwaysTool, input);
    expect(result.isError).toBeFalsy();
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    const structured = result.structuredContent as Awaited<
      ReturnType<typeof searchRunwaysTool.handler>
    > & {
      totalCount: number;
    };
    return { text, structured };
  }

  it('renders a plain runway row byte-identically (KSEA 16L/34R)', async () => {
    const { text } = await call({ region: 'US-WA', surface: 'con' });
    expect(text).toContain(
      '  **Runway 16L/34R** (id 244323) — length 11901 ft × width 150 ft | surface: CON | lighted: yes | closed: no\n  headings (true): 16L 180° / 34R 360°',
    );
    expect(text).toContain('**Distance:** — km at bearing —°');
  });

  it('renders airport coordinates as the exact structuredContent numbers', async () => {
    const { text, structured } = await call({ country: 'US', limit: 100 });
    expect(structured.runways.length).toBeGreaterThan(0);
    for (const { airport } of structured.runways) {
      expect(text).toContain(`**Location:** ${airport.latitudeDeg}, ${airport.longitudeDeg} ·`);
    }
    expect(text).toContain('**Location:** 47.449001, -122.308998 ·');
  });

  it('carries both displaced thresholds per runway row and renders them by end ident (VIDP)', async () => {
    const { text, structured } = await call({ country: 'IN', min_length_ft: 14000 });
    expect(structured.runways).toHaveLength(1);
    expect(structured.runways[0]?.runway).toMatchObject({
      id: 271000,
      lengthFt: 14534,
      leDisplacedThresholdFt: 2100,
      heDisplacedThresholdFt: 4790,
    });
    expect(text).toContain(
      '  headings (true): 11R 103° / 29L 283° | displaced threshold: 11R 2100 ft / 29L 4790 ft',
    );
  });

  it('keeps min_length_ft matching full-surface lengthFt (thresholds do not shorten it)', async () => {
    const { structured } = await call({ country: 'IN', min_length_ft: 14534 });
    expect(structured.runways.map((r) => r.runway.id)).toEqual([271000]);
    const { structured: none } = await call({ country: 'IN', min_length_ft: 14535 });
    expect(none.runways).toEqual([]);
  });

  it('returns null thresholds for empty upstream cells (never 0)', async () => {
    const { structured } = await call({ region: 'US-WA' });
    expect(structured.runways.length).toBeGreaterThan(0);
    for (const { runway } of structured.runways) {
      expect(runway.leDisplacedThresholdFt).toBeNull();
      expect(runway.heDisplacedThresholdFt).toBeNull();
    }
  });

  it('escapes Markdown in the surface while structuredContent keeps the raw value (CA-1094)', async () => {
    const { text, structured } = await call({ country: 'CA', include_closed_airports: true });
    const row = structured.runways.find((r) => r.runway.id === 249263);
    expect(row?.runway.surface).toBe('GRASS&amp;GRAVEL');
    expect(text).toContain('| surface: GRASS&amp;amp;GRAVEL |');
    expect(text).toContain('headings (true): 06 —° / 24 —° | displaced threshold: 06 — / 24 —');
  });

  it('describes lengths and min_length_ft as full-surface length', () => {
    expect(searchRunwaysTool.description).toMatch(/full runway surface/);
    expect(searchRunwaysTool.input.shape.min_length_ft.description).toMatch(/full runway surface/);
    expect(searchRunwaysTool.input.shape.min_length_ft.description).toMatch(/displaced thresholds/);
  });
});

describe('searchRunwaysTool closed type and scheduled service (#33, #35)', () => {
  type Input = z.input<typeof searchRunwaysTool.input>;
  type Structured = Awaited<ReturnType<typeof searchRunwaysTool.handler>> & {
    totalCount: number;
    notice?: string;
  };
  async function call(input: Input) {
    const result = await runToolContract(searchRunwaysTool, input);
    expect(result.isError).toBeFalsy();
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    return { text, structured: result.structuredContent as Structured };
  }
  const ids = (structured: Structured) => structured.runways.map((r) => r.runway.id);

  it('returns runways at closed airports for type closed whether the flag is omitted or false', async () => {
    const opted = await call({ type: 'closed', include_closed_airports: true });
    expect(ids(opted.structured)).toEqual([245683, 249263]);
    const inputs: Input[] = [
      { type: 'closed' },
      { type: 'closed', include_closed_airports: false },
    ];
    for (const input of inputs) {
      const { text, structured } = await call(input);
      expect(structured).toEqual(opted.structured);
      expect(text).toContain('(ident CLOSEDX,');
    }
  });

  it('filters by scheduled_service at the airport level on both surfaces', async () => {
    const us = await call({ country: 'US', scheduled_service: true });
    expect(ids(us.structured)).toEqual([244323, 244324, 245678, 700100, 245681]);
    expect(us.structured.totalCount).toBe(5);
    expect(us.structured.runways.every((r) => r.airport.scheduledService)).toBe(true);
    expect(us.text.split('**Scheduled service:** yes')).toHaveLength(6);
    expect(us.text).not.toContain('**Scheduled service:** no');
    const unscheduled = await call({ country: 'US', scheduled_service: false });
    expect(unscheduled.structured.totalCount).toBe(0);
    const closed = await call({ country: 'US', scheduled_service: false, type: 'closed' });
    expect(ids(closed.structured)).toEqual([245683]);
  });

  it('rejects a non-boolean scheduled_service at argument validation', async () => {
    const input = { scheduled_service: 'no' } as unknown as Input;
    const result = await runToolContract(searchRunwaysTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(result.content)).toContain('scheduled_service');
  });

  it('states that type closed needs no closed-airport flag', () => {
    expect(searchRunwaysTool.description).toMatch(/type closed/);
    expect(searchRunwaysTool.input.shape.type.description).toMatch(/include_closed_airports/);
    expect(searchRunwaysTool.input.shape.include_closed_airports.description).toMatch(
      /type "?closed"?/,
    );
  });

  it.each<[Input, string]>([
    [
      { min_length_ft: 99_999, min_width_ft: 999, surface: 'asp' },
      'No runways matched min_length_ft=99999, min_width_ft=999, surface=asp. Relax filters by shortening surface fragments, lowering min_length_ft or min_width_ft, or opting in to closed airports or runways.',
    ],
    [
      { region: 'US-WA', min_length_ft: 20_000, surface: 'asp' },
      'No runways matched region=US-WA, min_length_ft=20000, surface=asp. Relax filters by shortening surface fragments, lowering min_length_ft, or opting in to closed airports or runways.',
    ],
    [
      {
        surface: ['xyz', 'qqq'],
        min_width_ft: 999,
        include_closed_airports: true,
        include_closed_runways: true,
      },
      'No runways matched min_width_ft=999, surface=xyz or qqq. Relax filters by shortening surface fragments or lowering min_width_ft.',
    ],
    [
      { scheduled_service: false },
      'No runways matched scheduled_service=false. Relax filters by dropping scheduled_service or opting in to closed airports or runways.',
    ],
    [
      { type: 'closed', scheduled_service: true },
      'No runways matched type=closed, scheduled_service=true. Relax filters by dropping type or scheduled_service or opting in to closed runways.',
    ],
    [
      { country: 'PN', include_closed_runways: true },
      'No runways matched country=PN. Relax filters by opting in to closed airports.',
    ],
    [
      { country: 'PN', type: 'heliport', include_closed_runways: true },
      'No runways matched country=PN, type=heliport. Relax filters by dropping type.',
    ],
    [
      {
        latitude: -54.43,
        longitude: 3.41,
        radius_km: 20_016,
        type: 'balloonport',
        include_closed_airports: true,
        include_closed_runways: true,
      },
      'No runways matched type=balloonport, within 20016 km of -54.43, 3.41. Relax filters by dropping type.',
    ],
    [
      { latitude: 0, longitude: 0, radius_km: 10, lighted: true },
      'No runways matched lighted=true, within 10 km of 0, 0. Relax filters by dropping lighted, widening radius_km (max 20016), or opting in to closed airports or runways.',
    ],
  ])(
    'names the filters set and only remedies that could add rows for %j',
    async (input, notice) => {
      const { text, structured } = await call(input);
      expect(structured).toMatchObject({ runways: [], totalCount: 0, notice });
      expect(text).toContain(`> ${notice}`);
    },
  );
});
