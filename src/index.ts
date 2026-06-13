#!/usr/bin/env node
/**
 * @fileoverview ourairports-mcp-server entry point. Builds the bundled
 * OurAirports indices once at setup() and serves five read-only lookup/geo
 * tools plus the airport:// resource against them — zero runtime API.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initAirportDataService } from './services/airport-data/airport-data-service.js';

await createApp({
  name: 'ourairports-mcp-server',
  title: 'ourairports-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    'Static, offline aviation reference data (airports, runways, navaids, radio frequencies) from the public-domain OurAirports dataset — no API key, no rate limit, no upstream. Resolve any airport by a single `code` (IATA/ICAO/GPS/local/ident) with ourairports_get_airport; the `airport://{code}` resource mirrors it. Search by name or facets with ourairports_search_airports (closed airports excluded by default). Ground a coordinate in the nearest airports with ourairports_find_airports (no geocoding — resolve place names to lat/lon upstream first). Navaid frequencies are stored in kHz for every type; airport frequencies are in MHz. The data is community-edited and as fresh as the last build — not authoritative for real flight operations.',
  async setup(core) {
    const service = initAirportDataService(core.config);
    await service.load();
  },
});
