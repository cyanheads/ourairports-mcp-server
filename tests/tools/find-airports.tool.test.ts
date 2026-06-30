/**
 * @fileoverview Tests for ourairports_find_airports — haversine ranking,
 * distance/bearing output, radius/type/closed filtering, and the empty-radius
 * notice.
 * @module tests/tools/find-airports.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    getServerConfig: () => ({ dataDir: undefined, defaultSearchLimit: cfg.defaultSearchLimit }),
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
