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
      .min(1)
      .describe(
        'Any airport code: IATA (SEA), ICAO (KSEA), GPS, national/local, or the OurAirports ident. Case-insensitive.',
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
      .describe('How the code resolved, with an ambiguity note for shared national codes.'),
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

    const { airport, resolvedVia, ambiguous } = resolution;
    const country = svc.country(airport.isoCountry);
    const region = svc.region(airport.isoRegion);
    const resolutionNote = ambiguous
      ? `Resolved via ${resolvedVia}. "${params.code.toUpperCase()}" is a national code shared by more than one airport; the first match was returned. Re-query with the IATA or ICAO code, or the ident "${airport.ident}", if this is not the expected airport.`
      : `Resolved via ${resolvedVia}.`;

    return {
      airport: toAirportSummary(airport, country?.name, region?.name),
      resolvedVia,
      resolutionNote,
      runways: svc.runwaysForAirport(airport.id).map(toRunway),
      frequencies: svc.frequenciesForAirport(airport.id).map(toFrequency),
    };
  },
});
