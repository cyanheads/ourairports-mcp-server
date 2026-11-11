/**
 * @fileoverview Tests for ourairports_find_airports — haversine ranking,
 * distance/bearing output, radius/type/closed filtering, the pre-limit total
 * and truncation disclosure, the empty-radius notice, and exact coordinates in
 * content[].
 * @module tests/tools/find-airports.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

// Controllable OURAIRPORTS_DEFAULT_SEARCH_LIMIT for the #4 limit-resolution tests.
const cfg = vi.hoisted(() => ({ defaultSearchLimit: 20 }));
vi.mock('@/config/server-config.js', async (orig) => {
  const actual = await orig<typeof import('@/config/server-config.js')>();
  return {
    ...actual,
    getServerConfig: () => ({
      dataDir: undefined,
      defaultSearchLimit: cfg.defaultSearchLimit,
      clampLimits: true,
    }),
  };
});

const { findAirportsTool } = await import('@/mcp-server/tools/definitions/find-airports.tool.js');

describe('findAirportsTool', () => {
  it('ranks nearest-first with distance and bearing', async () => {
    const ctx = createMockContext();
    const result = await findAirportsTool.handler(
      findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31, radius_km: 100 }),
      ctx,
    );
    expect(result.airports.length).toBeGreaterThanOrEqual(2);
    expect(result.airports[0]?.airport.ident).toBe('KSEA');
    expect(result.airports[0]?.distanceKm).toBeLessThan(result.airports[1]?.distanceKm as number);
    expect(result.airports[0]?.bearingDeg).toBeGreaterThanOrEqual(0);
  });

  it('notices when nothing falls within the radius', async () => {
    const ctx = createMockContext();
    const result = await findAirportsTool.handler(
      findAirportsTool.input.parse({ latitude: 0, longitude: 0, radius_km: 50 }),
      ctx,
    );
    expect(result.airports).toHaveLength(0);
    expect(getEnrichment(ctx)?.notice).toMatch(/No airports within/);
  });

  it('applies the type filter', async () => {
    const ctx = createMockContext();
    const result = await findAirportsTool.handler(
      findAirportsTool.input.parse({
        latitude: 47.45,
        longitude: -122.31,
        radius_km: 200,
        type: 'large_airport',
      }),
      ctx,
    );
    expect(result.airports.every((h) => h.airport.type === 'large_airport')).toBe(true);
  });

  it('rejects out-of-range coordinates at the schema', () => {
    expect(findAirportsTool.input.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
    expect(findAirportsTool.input.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
  });

  // Regression for #4: find_airports must honor OURAIRPORTS_DEFAULT_SEARCH_LIMIT
  // (like its search/find siblings), not a hardcoded default of 10, and clamp a
  // config value above its own max of 50.
  describe('limit resolution (#4)', () => {
    it('leaves limit optional in the schema (resolved in the handler)', () => {
      const input = findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31 });
      expect(input.limit).toBeUndefined();
    });

    it('defaults to the configured search limit when limit is omitted', async () => {
      cfg.defaultSearchLimit = 20;
      const spy = vi.spyOn(svc, 'nearbyAirports');
      await findAirportsTool.handler(
        findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31 }),
        createMockContext(),
      );
      expect(spy.mock.calls[0]?.[3]).toBe(20); // 4th positional arg is limit
      spy.mockRestore();
    });

    it('clamps a configured default above the tool max down to 50', async () => {
      cfg.defaultSearchLimit = 80;
      const spy = vi.spyOn(svc, 'nearbyAirports');
      await findAirportsTool.handler(
        findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31 }),
        createMockContext(),
      );
      expect(spy.mock.calls[0]?.[3]).toBe(50);
      spy.mockRestore();
      cfg.defaultSearchLimit = 20;
    });

    it('passes an explicit caller limit through unchanged', async () => {
      const spy = vi.spyOn(svc, 'nearbyAirports');
      await findAirportsTool.handler(
        findAirportsTool.input.parse({ latitude: 47.45, longitude: -122.31, limit: 5 }),
        createMockContext(),
      );
      expect(spy.mock.calls[0]?.[3]).toBe(5);
      spy.mockRestore();
    });
  });
});

describe('findAirportsTool ranking and limit (characterization)', () => {
  const run = (input: Record<string, unknown>) =>
    findAirportsTool.handler(findAirportsTool.input.parse(input), createMockContext());

  it('ranks nearest-first with rounded distance and bearing', async () => {
    const result = await run({ latitude: 47.45, longitude: -122.31, radius_km: 100, limit: 50 });
    expect(result.airports.map((h) => [h.airport.ident, h.distanceKm, h.bearingDeg])).toEqual([
      ['KSEA', 0.13, 145.9],
      ['KBFI', 8.92, 3.9],
    ]);
  });

  it('a smaller limit returns the nearest-first prefix of the larger result', async () => {
    const one = await run({ latitude: 47.45, longitude: -122.31, radius_km: 100, limit: 1 });
    expect(one.airports.map((h) => h.airport.ident)).toEqual(['KSEA']);
  });

  it('an empty radius reports totalCount 0 and the widen-radius notice', async () => {
    const ctx = createMockContext();
    await findAirportsTool.handler(
      findAirportsTool.input.parse({ latitude: 0, longitude: 0, radius_km: 50 }),
      ctx,
    );
    expect(getEnrichment(ctx)?.totalCount).toBe(0);
    expect(getEnrichment(ctx)?.notice).toBe(
      'No airports within 50 km of 0, 0. Widen radius_km (max 20016). Set include_closed to include closed airports.',
    );
  });
});

describe('findAirportsTool pre-limit totals and truncation disclosure (#11)', () => {
  type Structured = Awaited<ReturnType<typeof findAirportsTool.handler>> & {
    totalCount: number;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
    nextOffset?: number;
  };
  /** Run through the public contract so content[] includes the enrichment trailer. */
  async function call(input: z.input<typeof findAirportsTool.input>) {
    const result = await runToolContract(findAirportsTool, input);
    expect(result.isError).toBeFalsy();
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    return { text, structured: result.structuredContent as Structured };
  }
  const SEA = { latitude: 47.45, longitude: -122.31, radius_km: 100 };

  it('reports the in-radius count before the limit and discloses the cap', async () => {
    const { text, structured } = await call({ ...SEA, limit: 1 });
    expect(structured.airports).toHaveLength(1);
    expect(structured.totalCount).toBe(2);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(1);
    expect(structured.cap).toBe(1);
    expect(structured.notice).toBe('Use nextOffset as offset with the same query to continue.');
    expect(text).toContain('**2 total**');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain(`> ${structured.notice}`);
  });

  it('no longer presents the returned count as the in-radius total in the heading', async () => {
    const { text } = await call({ ...SEA, limit: 1 });
    expect(text).not.toMatch(/within radius/);
    expect(text).toContain('## Nearest Airports — 1 shown');
  });

  it('counts only airports passing include_closed and type', async () => {
    const withClosed = await call({ ...SEA, limit: 1, include_closed: true });
    expect(withClosed.structured.totalCount).toBe(3);
    expect(withClosed.structured.truncated).toBe(true);

    const large = await call({ ...SEA, limit: 1, type: 'large_airport' });
    expect(large.structured.totalCount).toBe(1);
    expect(large.structured.truncated).toBeUndefined();
  });

  it('caps at the config-resolved default when limit is omitted', async () => {
    cfg.defaultSearchLimit = 1;
    const { structured } = await call(SEA);
    cfg.defaultSearchLimit = 20;
    expect(structured.totalCount).toBe(2);
    expect(structured.cap).toBe(1);
  });

  it('adds no truncation fields when the limit equals the match count', async () => {
    const { text, structured } = await call({ ...SEA, limit: 2 });
    expect(structured.airports).toHaveLength(2);
    expect(structured.totalCount).toBe(2);
    expect(Object.keys(structured).sort()).toEqual(['airports', 'totalCount']);
    expect(text).not.toContain('truncated');
  });

  it('reports zero with the unchanged empty-radius notice and no truncation fields', async () => {
    const { structured } = await call({ latitude: 0, longitude: 0, radius_km: 50 });
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toMatch(/^No airports within 50 km of 0, 0\./);
    expect(Object.keys(structured).sort()).toEqual(['airports', 'notice', 'totalCount']);
  });

  it('declares the truncation fields on the effective output schema', () => {
    const parsed = findAirportsTool.output
      .extend(findAirportsTool.enrichment!)
      .parse({ airports: [], totalCount: 5, truncated: true, shown: 1, cap: 1 });
    expect(parsed).toMatchObject({ totalCount: 5, truncated: true, shown: 1, cap: 1 });
  });

  it('returns a continuation, final page, and past-end notice on both surfaces', async () => {
    const first = await call({ ...SEA, limit: 1, offset: 0 });
    expect(first.structured).toMatchObject({
      airports: [{ airport: { ident: 'KSEA' } }],
      totalCount: 2,
      nextOffset: 1,
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(first.text).toContain('**nextOffset:** 1');
    const last = await call({ ...SEA, limit: 1, offset: 1 });
    expect(last.structured).toMatchObject({
      airports: [{ airport: { ident: 'KBFI' } }],
      totalCount: 2,
    });
    expect(last.structured).not.toHaveProperty('nextOffset');
    expect(last.structured).not.toHaveProperty('truncated');
    expect(last.text).toContain('KBFI');
    const past = await call({ ...SEA, limit: 1, offset: 2 });
    expect(past.structured).toMatchObject({
      airports: [],
      totalCount: 2,
      notice: expect.stringContaining('Offset 2'),
    });
    expect(past.structured).not.toHaveProperty('nextOffset');
    expect(past.text).toContain('Offset 2');
  });

  it('accepts the globe radius with filtered totals and drops impossible widen guidance', async () => {
    const globe = await call({ ...SEA, radius_km: 20016, type: 'large_airport', limit: 1 });
    expect(globe.structured).toMatchObject({
      airports: [{ airport: { ident: 'KSEA' } }],
      totalCount: 4,
      nextOffset: 1,
    });
    expect(globe.text).toContain('**4 total**');
    const empty = await call({
      ...SEA,
      radius_km: 20016,
      type: 'balloonport',
      include_closed: true,
    });
    expect(empty.structured).toMatchObject({
      airports: [],
      totalCount: 0,
      notice: expect.stringContaining('Drop the type filter'),
    });
    expect(empty.structured.notice).not.toContain('Widen');
    expect(empty.text).toContain('Drop the type filter');
  });

  it.each([{ offset: 0.5 }, { radius_km: 20017 }])(
    'rejects invalid paging or radius input %j',
    async (input) => {
      const result = await runToolContract(findAirportsTool, { ...SEA, ...input });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(JSON.stringify(result.content)).toContain(Object.keys(input)[0]);
    },
  );

  it('passes the clamped limit to the service and preserves continuation guidance', async () => {
    const [hit] = svc.nearbyAirports(
      SEA.latitude,
      SEA.longitude,
      100,
      1,
      undefined,
      false,
    ).airports;
    expect(hit).toBeDefined();
    const spy = vi.spyOn(svc, 'nearbyAirports').mockReturnValueOnce({
      airports: Array.from({ length: 50 }, (_, id) => ({
        ...hit!,
        airport: { ...hit!.airport, id },
      })),
      totalMatched: 51,
    });
    try {
      const { structured, text } = await call({ ...SEA, limit: 51 });
      expect(spy.mock.calls[0]?.[3]).toBe(50);
      expect(structured).toMatchObject({
        cap: 50,
        nextOffset: 50,
        notice:
          'Requested limit 51 was clamped to 50. Use nextOffset as offset with the same query to continue.',
      });
      expect(text).toContain('clamped to 50. Use nextOffset');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('findAirportsTool content rendering', () => {
  it('renders every coordinate as the exact structuredContent number', async () => {
    const result = await runToolContract(findAirportsTool, { latitude: 47.45, longitude: -122.31 });
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    const { airports } = result.structuredContent as Awaited<
      ReturnType<typeof findAirportsTool.handler>
    >;
    expect(airports.length).toBeGreaterThanOrEqual(2);
    for (const { airport } of airports) {
      expect(text).toContain(`**Location:** ${airport.latitudeDeg}, ${airport.longitudeDeg} ·`);
    }
    expect(text).toContain('**Location:** 47.529999, -122.302002 ·');
  });
});
