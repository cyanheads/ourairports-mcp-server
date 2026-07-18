/**
 * @fileoverview Tests for ourairports_find_navaids — the two-mode contract
 * (coordinate vs airport, exactly one), kHz frequency surfacing, the
 * found-but-unserved notice, and the unknown_code error.
 * @module tests/tools/find-navaids.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

// Controllable OURAIRPORTS_DEFAULT_SEARCH_LIMIT for the #4 clamp test.
const cfg = vi.hoisted(() => ({ defaultSearchLimit: 20 }));
vi.mock('@/config/server-config.js', async (orig) => {
  const actual = await orig<typeof import('@/config/server-config.js')>();
  return {
    ...actual,
    getServerConfig: () => ({ dataDir: undefined, defaultSearchLimit: cfg.defaultSearchLimit }),
  };
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

  // #6: the airport-mode miss now throws via ctx.fail('unknown_code', …) at the
  // tool boundary, so the declared recovery hint reaches data.recovery.hint
  // (previously the service threw notFound() and bypassed ctx.recoveryFor).
  it('throws unknown_code with the declared recovery hint for an unknown airport code', () => {
    const ctx = ctxWithContract();
    let thrown: unknown;
    try {
      findNavaidsTool.handler(findNavaidsTool.input.parse({ airport_code: 'ZZZZZZ' }), ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const err = thrown as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    const data = err.data as { reason?: string; code?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('unknown_code');
    expect(data.code).toBe('ZZZZZZ');
    expect(data.recovery?.hint).toMatch(/ourairports_search_airports|ourairports_get_airport/);
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

  // #7: airport_code is trimmed before lookup; a padded code selects airport mode.
  it('resolves a padded airport_code by trimming ("  KSEA  ")', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: '  KSEA  ' }),
      ctx,
    );
    expect(result.mode).toBe('airport');
    expect(result.airportIdent).toBe('KSEA');
  });

  // #7: whitespace-only airport_code is now a schema validation failure — it no
  // longer falls through to mode_conflict.
  it('rejects a whitespace-only airport_code at schema validation, not as mode_conflict', () => {
    expect(() => findNavaidsTool.input.parse({ airport_code: '   ' })).toThrow();
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

  // Regression for #4: the config-derived default is clamped to the tool's own
  // max of 50 (the config ceiling is 100), aligning with find_airports.
  it('clamps a configured default above the tool max down to 50', async () => {
    cfg.defaultSearchLimit = 80;
    const spy = vi.spyOn(svc, 'nearbyNavaids');
    await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ latitude: 47.45, longitude: -122.31, radius_km: 200 }),
      ctxWithContract(),
    );
    expect(spy.mock.calls[0]?.[3]).toBe(50); // 4th positional arg is limit
    spy.mockRestore();
    cfg.defaultSearchLimit = 20;
  });
});
