/**
 * @fileoverview Caller-visible navaid lookup, runway geography, and continuation contracts.
 * @module tests/tools/navaid-runway-paging.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (original) => ({
  ...(await original<typeof import('@/services/airport-data/airport-data-service.js')>()),
  getAirportDataService: () => svc,
}));

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');
const { searchRunwaysTool } = await import('@/mcp-server/tools/definitions/search-runways.tool.js');

describe('navaid ident and paging', () => {
  it('returns duplicate ident holders in dataset order across pages', async () => {
    const first = await runToolContract(findNavaidsTool, { ident: ' bik ', limit: 1 });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      mode: 'ident',
      airportIdent: null,
      totalCount: 2,
      nextOffset: 1,
      navaids: [{ id: 86052, distanceKm: null, bearingDeg: null }],
    });
    expect(JSON.stringify(first.content)).toContain('Bindook');
    expect(JSON.stringify(first.content)).toContain('nextOffset');
    const last = await runToolContract(findNavaidsTool, { ident: 'BIK', limit: 1, offset: 1 });
    expect(last.structuredContent).toMatchObject({ totalCount: 2, navaids: [{ id: 86054 }] });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
    const filtered = await runToolContract(findNavaidsTool, { ident: 'BIK', type: 'NDB' });
    expect(filtered.structuredContent).toMatchObject({ totalCount: 1, navaids: [{ id: 86054 }] });
  });

  it('distinguishes an unmatched ident from a past-end page', async () => {
    const none = await runToolContract(findNavaidsTool, { ident: 'NO-SUCH-NAVAID' });
    expect(none.structuredContent).toMatchObject({
      totalCount: 0,
      navaids: [],
      notice: expect.stringContaining('No navaids matched ident'),
    });
    const past = await runToolContract(findNavaidsTool, { ident: 'BIK', offset: 2 });
    expect(past.structuredContent).toMatchObject({
      totalCount: 2,
      navaids: [],
      notice: expect.stringContaining('offset'),
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(JSON.stringify(past.content)).not.toContain('No navaids matched');
  });

  it.each([
    [{ ident: 'BIK', airport_code: 'KSEA' }, 'mode_conflict'],
    [{ ident: 'BIK', latitude: 0, longitude: 0 }, 'mode_conflict'],
    [{ ident: 'BIK', latitude: 0 }, 'mode_conflict'],
  ])('rejects incompatible modes %j on both surfaces', async (input, reason) => {
    const result = await runToolContract(findNavaidsTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
    expect(JSON.stringify(result.content)).toContain(reason);
  });

  it('preserves coordinate and airport page order and totals', async () => {
    const coord = await runToolContract(findNavaidsTool, {
      latitude: 40.6413,
      longitude: -73.7781,
      radius_km: 60,
      limit: 1,
      offset: 1,
    });
    expect(coord.structuredContent).toMatchObject({
      totalCount: 4,
      nextOffset: 2,
      navaids: [{ ident: 'CRI' }],
    });
    const airport = await runToolContract(findNavaidsTool, {
      airport_code: 'KJFK',
      limit: 1,
      offset: 1,
    });
    expect(airport.structuredContent).toMatchObject({ totalCount: 2, navaids: [{ ident: 'CRI' }] });
    expect(airport.structuredContent).not.toHaveProperty('nextOffset');
    const past = await runToolContract(findNavaidsTool, {
      airport_code: 'KJFK',
      offset: Number.MAX_SAFE_INTEGER,
    });
    expect(past.structuredContent).toMatchObject({ totalCount: 2, navaids: [] });
  });

  it('accepts a global radius and clamps an explicit page limit', async () => {
    const result = await runToolContract(findNavaidsTool, {
      latitude: 0,
      longitude: 0,
      radius_km: 20016,
      limit: 51,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 21,
      notice: expect.stringContaining('clamped to 50'),
    });
    expect(JSON.stringify(result.content)).toContain('clamped to 50');
  });

  it.each([
    { ident: ' ' },
    { ident: 'BIK', offset: -1 },
    { ident: 'BIK', offset: 0.5 },
    { ident: 'BIK', offset: Number.MAX_SAFE_INTEGER + 1 },
    { latitude: 0, longitude: 0, radius_km: 20017 },
  ])('rejects invalid navaid input %j', async (input) => {
    const result = await runToolContract(findNavaidsTool, input);
    expect(result.isError).toBe(true);
  });
});

describe('runway spatial pages', () => {
  it('ranks qualifying OR surface matches by airport distance and renders both spatial fields', async () => {
    const result = await runToolContract(searchRunwaysTool, {
      latitude: 47.449001,
      longitude: -122.308998,
      radius_km: 100,
      surface: ['cOn', 'asP'],
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      nextOffset: 1,
      runways: [
        { airport: { ident: 'KSEA' }, runway: { id: 244323 }, distanceKm: 0, bearingDeg: 0 },
      ],
    });
    expect(JSON.stringify(result.content)).toContain('0 km');
    expect(JSON.stringify(result.content)).toContain('0°');
  });

  it('returns the next traversal row and distinguishes a past-end request', async () => {
    const result = await runToolContract(searchRunwaysTool, {
      region: 'US-WA',
      limit: 1,
      offset: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      runways: [{ distanceKm: null, bearingDeg: null }],
    });
    const first = await runToolContract(searchRunwaysTool, { region: 'US-WA', limit: 1 });
    const firstData = searchRunwaysTool.output.parse(first.structuredContent);
    const secondData = searchRunwaysTool.output.parse(result.structuredContent);
    expect(secondData.runways[0]?.runway.id).not.toBe(firstData.runways[0]?.runway.id);
    const past = await runToolContract(searchRunwaysTool, {
      region: 'US-WA',
      offset: Number.MAX_SAFE_INTEGER,
    });
    expect(past.structuredContent).toMatchObject({
      runways: [],
      notice: expect.stringContaining('offset'),
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
  });

  it('reports a clamped limit without dropping the empty-result explanation', async () => {
    const result = await runToolContract(searchRunwaysTool, {
      surface: 'no-such-surface',
      limit: 101,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 0,
      runways: [],
      notice: expect.stringMatching(/clamped to 100.*No runways matched/),
    });
    expect(JSON.stringify(result.content)).toContain('clamped to 100');
    expect(JSON.stringify(result.content)).toContain('No runways matched');
  });

  it.each([{ latitude: 0 }, { longitude: 0 }, { radius_km: 100 }])(
    'reports a spatial mode error for %j',
    async (input) => {
      const result = await runToolContract(searchRunwaysTool, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'incomplete_coordinates' } },
      });
      expect(JSON.stringify(result.content)).toContain('incomplete_coordinates');
    },
  );

  it.each([{ surface: [] }, { surface: ['asp', ' '] }, { offset: -1 }, { offset: 0.5 }])(
    'rejects invalid runway input %j',
    async (input) => {
      const result = await runToolContract(searchRunwaysTool, input);
      expect(result.isError).toBe(true);
    },
  );
});
