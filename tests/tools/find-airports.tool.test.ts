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
});
