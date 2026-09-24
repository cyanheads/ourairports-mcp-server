/**
 * @fileoverview airport://{code} — stable-URI twin of ourairports_get_airport
 * for clients that inject resource context. Resolves one airport by any code
 * (IATA / ICAO / GPS / local / ident) and returns its full record with runways
 * and frequencies inline, delegating to the same service accessor as the tool.
 *
 * No list() — enumerating 85k airports as a resource list is an exhaustive dump,
 * not a discovery aid. Discovery is ourairports_search_airports.
 * @module src/mcp-server/resources/definitions/airport.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AirportSummarySchema,
  buildResolutionNote,
  FrequencySchema,
  RunwaySchema,
  toAirportSummary,
  toFrequency,
  toRunway,
} from '@/mcp-server/tools/definitions/_schemas.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';

export const airportResource = resource('airport://{code}', {
  name: 'airport-record',
  title: 'ourairports-mcp-server',
  description:
    'A single airport record by any code (IATA / ICAO / GPS / local / OurAirports ident), with runways and radio frequencies inline. Stable-URI twin of ourairports_get_airport.',
  mimeType: 'application/json',
  cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },

  errors: [
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'No airport matched the supplied code in any identifier space.',
      recovery:
        'Use ourairports_search_airports with a partial name or municipality to discover the correct code.',
    },
  ],

  params: z.object({
    code: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Any airport code: IATA (SEA), ICAO (KSEA), GPS, national/local, or the OurAirports ident. Case-insensitive; surrounding whitespace is ignored.',
      ),
  }),

  output: z.object({
    airport: AirportSummarySchema.describe(
      'The resolved airport record. Codes the airport lacks are null.',
    ),
    resolvedVia: z
      .string()
      .describe(
        'Which identifier space the code matched: ident, icao_code, iata_code, gps_code, or local_code.',
      ),
    resolutionNote: z
      .string()
      .describe(
        "How the code resolved: the identifier space that matched and, when other airports carry the same code, why this one won (resolution priority or dataset row order) and each other airport's ident, country, and code space — read airport://{ident} with that ident to fetch it.",
      ),
    runways: z
      .array(RunwaySchema)
      .describe('Runways for the airport (empty array when none recorded).'),
    frequencies: z
      .array(FrequencySchema)
      .describe('Radio frequencies in MHz (empty array when none recorded).'),
  }),

  handler(params, ctx) {
    const svc = getAirportDataService();
    const resolution = svc.resolveByCode(params.code);
    if (!resolution) {
      throw ctx.fail('unknown_code', `No airport found for code "${params.code}".`, {
        code: params.code,
        ...ctx.recoveryFor('unknown_code'),
      });
    }

    const { airport, resolvedVia } = resolution;
    const country = svc.country(airport.isoCountry);
    const region = svc.region(airport.isoRegion);

    return {
      airport: toAirportSummary(airport, country?.name, region?.name),
      resolvedVia,
      resolutionNote: buildResolutionNote(params.code, resolution),
      runways: svc.runwaysForAirport(airport.id).map(toRunway),
      frequencies: svc.frequenciesForAirport(airport.id).map(toFrequency),
    };
  },
});
