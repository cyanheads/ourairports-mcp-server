/**
 * @fileoverview SDK v2 contract coverage for the two-mode navaid tool.
 * @module tests/integration/find-navaids-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

toolContractSuite(findNavaidsTool, {
  success: [
    {
      name: 'validates, invokes, and formats coordinate mode',
      input: { latitude: 47.45, longitude: -122.31, radius_km: 200 },
    },
    {
      name: 'validates, invokes, and formats airport mode',
      input: { airport_code: 'KSEA' },
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
