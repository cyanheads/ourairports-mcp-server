/**
 * @fileoverview SDK v2 contract coverage for the two-mode navaid tool.
 * @module tests/integration/find-navaids-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

it.each([
  [{ latitude: 47 }, 'longitude'],
  [{ longitude: 0 }, 'latitude'],
  [{ latitude: 0, airport_code: 'KSEA' }, 'longitude'],
  [{ longitude: -122, airport_code: 'KSEA' }, 'latitude'],
])('names the missing counterpart for %j on both error surfaces', async (input, missing) => {
  const result = await runToolContract(findNavaidsTool, input);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: {
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining(`without ${missing}`),
      data: { reason: 'mode_conflict', recovery: { hint: findNavaidsTool.errors![0]!.recovery } },
    },
  });
  expect(JSON.stringify(result.content)).toContain(`without ${missing}`);
  if ('airport_code' in input)
    expect(JSON.stringify(result.content)).toContain('airport_code cannot be combined');
});

it.each([
  [{}, 'Neither latitude/longitude nor airport_code was supplied.'],
  [
    { latitude: 0, longitude: 0, airport_code: 'KSEA' },
    'Both latitude/longitude and airport_code were supplied.',
  ],
])('accurately describes the complete-mode conflict for %j', async (input, message) => {
  const result = await runToolContract(findNavaidsTool, input);
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.ValidationError, message, data: { reason: 'mode_conflict' } },
  });
  expect(JSON.stringify(result.content)).toContain(message);
});

it.each([{ latitude: 0, longitude: 0 }, { airport_code: ' ksea ' }])(
  'preserves valid input mode %j',
  async (input) => {
    const result = await runToolContract(findNavaidsTool, input);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveProperty(
      'mode',
      'airport_code' in input ? 'airport' : 'coordinate',
    );
    expect(JSON.stringify(result.content)).toContain(
      'airport_code' in input ? 'airport' : 'coordinate',
    );
  },
);

toolContractSuite(findNavaidsTool, {
  // `expected` is typed to the domain output, so enrichment fields and partial
  // navaid shapes are pinned in `assert` against the assembled structuredContent.
  success: [
    {
      name: 'validates, invokes, and formats coordinate mode',
      input: { latitude: 47.45, longitude: -122.31, radius_km: 200 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          mode: 'coordinate',
          totalCount: 2,
          navaids: [{ ident: 'SEA' }, { ident: 'PAE' }],
        });
      },
    },
    {
      name: 'validates, invokes, and formats airport mode with every navaid field',
      input: { airport_code: 'KSEA' },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          mode: 'airport',
          airportIdent: 'KSEA',
          totalCount: 1,
          navaids: [
            {
              ident: 'SEA',
              frequencyKhz: 116800,
              frequencyMhz: 116.8,
              dmeFrequencyKhz: 116800,
              usageType: 'BOTH',
              power: 'HIGH',
              magneticVariationDeg: 16.123,
              slavedVariationDeg: 18.5,
            },
          ],
        });
      },
    },
    {
      name: 'discloses a pre-limit total and truncation in coordinate mode',
      input: { latitude: 40.6413, longitude: -73.7781, radius_km: 60, limit: 1 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          totalCount: 4,
          truncated: true,
          shown: 1,
          cap: 1,
        });
      },
    },
    {
      name: 'keeps the resolution note beside truncation in airport mode',
      input: { airport_code: 'LEN', limit: 1 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          airportIdent: 'LELN',
          totalCount: 2,
          truncated: true,
          shown: 1,
          cap: 1,
          resolutionNote: expect.stringMatching(/^Resolved via iata_code\./),
        });
      },
    },
    {
      name: 'nulls MHz for an NDB-DME while keeping its DME paired frequency',
      input: { latitude: 49.0175, longitude: -118.424, radius_km: 5 },
      assert: (result) => {
        expect(result.structuredContent).toMatchObject({
          navaids: [
            { type: 'NDB-DME', frequencyKhz: 250, frequencyMhz: null, dmeFrequencyKhz: 109700 },
          ],
        });
      },
    },
  ],
  errors: [
    {
      name: 'returns the declared dual-surface error envelope',
      input: { airport_code: 'ZZZZZZ' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'unknown_code',
    },
    {
      name: 'preserves the patch-compatible mode conflict contract',
      input: {},
      code: JsonRpcErrorCode.ValidationError,
      reason: 'mode_conflict',
    },
  ],
});
