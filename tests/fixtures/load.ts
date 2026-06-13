/**
 * @fileoverview Test helper — constructs and loads an AirportDataService from
 * the bundled fixture CSV slice (a handful of airports/runways/navaids), so the
 * suite runs entirely offline with no network and no full data drop.
 * @module tests/fixtures/load
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirportDataService } from '@/services/airport-data/airport-data-service.js';

export const FIXTURE_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

/** Build a fresh service over the fixture data and await its index load. */
export async function loadFixtureService(): Promise<AirportDataService> {
  const svc = new AirportDataService(FIXTURE_DATA_DIR);
  await svc.load();
  return svc;
}
