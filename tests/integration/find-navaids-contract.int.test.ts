/**
 * @fileoverview SDK v2 contract coverage for the two-mode navaid tool.
 * @module tests/integration/find-navaids-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { expect, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

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
