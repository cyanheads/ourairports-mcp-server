/**
 * @fileoverview Property-based SDK v2 safety coverage for both navaid input modes.
 * @module tests/fuzz/find-navaids-tool.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

it('keeps both navaid modes safe across generated and adversarial inputs', async () => {
  const report = await fuzzTool(findNavaidsTool, {
    numRuns: 50,
    numAdversarial: 30,
    seed: 20_260_824,
  });

  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
