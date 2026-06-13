/**
 * @fileoverview Tests for ourairports_find_navaids — the two-mode contract
 * (coordinate vs airport, exactly one), kHz frequency surfacing, the
 * found-but-unserved notice, and the unknown_code error.
 * @module tests/tools/find-navaids.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

/** Context wired with the tool's error contract so ctx.fail is typed/available. */
const ctxWithContract = () => createMockContext({ errors: findNavaidsTool.errors });

describe('findNavaidsTool', () => {
  it('coordinate mode: nearest-first with distance', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ latitude: 47.45, longitude: -122.31, radius_km: 200 }),
      ctx,
    );
    expect(result.mode).toBe('coordinate');
    expect(result.airportIdent).toBeNull();
    expect(result.navaids[0]?.ident).toBe('SEA');
    expect(result.navaids[0]?.distanceKm).not.toBeNull();
  });

  it('airport mode: navaids serving the airport, in kHz and MHz', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: 'KSEA' }),
      ctx,
    );
    expect(result.mode).toBe('airport');
    expect(result.airportIdent).toBe('KSEA');
    expect(result.navaids).toHaveLength(1);
    expect(result.navaids[0]?.frequencyKhz).toBe(116800);
    expect(result.navaids[0]?.frequencyMhz).toBeCloseTo(116.8, 3);
    expect(result.navaids[0]?.distanceKm).toBeNull();
  });

  it('airport mode: empty list + notice when airport has no navaids', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: '00AA' }),
      ctx,
    );
    expect(result.navaids).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/no associated navaids/);
  });

  it('throws unknown_code in airport mode for an invalid code', () => {
    const ctx = ctxWithContract();
    expect(() =>
      findNavaidsTool.handler(findNavaidsTool.input.parse({ airport_code: 'ZZZZ' }), ctx),
    ).toThrow(/No airport found/);
  });

  it('throws mode_conflict when both modes supplied', () => {
    const ctx = ctxWithContract();
    expect(() =>
      findNavaidsTool.handler(
        findNavaidsTool.input.parse({ latitude: 47, longitude: -122, airport_code: 'KSEA' }),
        ctx,
      ),
    ).toThrow();
  });

  it('throws mode_conflict when neither mode supplied', () => {
    const ctx = ctxWithContract();
    expect(() => findNavaidsTool.handler(findNavaidsTool.input.parse({}), ctx)).toThrow();
  });

  it('throws mode_conflict for a lone latitude (partial coordinate)', () => {
    const ctx = ctxWithContract();
    expect(() =>
      findNavaidsTool.handler(findNavaidsTool.input.parse({ latitude: 47 }), ctx),
    ).toThrow();
  });

  it('filters by navaid type in coordinate mode', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({
        latitude: 40.633,
        longitude: -73.778,
        radius_km: 100,
        type: 'NDB',
      }),
      ctx,
    );
    expect(result.navaids.every((n) => n.type === 'NDB')).toBe(true);
  });
});
