/**
 * @fileoverview ourairports_get_airport — the detail tool. Resolves one airport
 * by any code (IATA / ICAO / GPS / local / OurAirports ident) and returns its
 * full record with runways and radio frequencies inline. One call returns
 * everything the common case needs.
 * @module src/mcp-server/tools/definitions/get-airport.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import {
  AirportSummarySchema,
  FrequencySchema,
  RunwaySchema,
  renderAirportLines,
  toAirportSummary,
  toFrequency,
  toRunway,
} from './_schemas.js';

export const getAirportTool = tool('ourairports_get_airport', {
  title: 'ourairports-mcp-server',
  description:
    "Fetch the full record for one airport resolved by ANY code — IATA (SEA), ICAO (KSEA), GPS, national/local, or the OurAirports ident — with its runways and radio frequencies inline. The single `code` param is resolved case-insensitively across all five identifier spaces (priority: ident, then ICAO, IATA, GPS, local). The response always echoes the airport's complete code set and a resolution_note naming which space matched, so a wrong resolution from an ambiguous national code is self-correcting (re-query with the IATA or ICAO code, or the ident). Absent codes are reported as null, never an error. Closed airports always resolve. OurAirports is community-edited — not authoritative for flight operations.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'No airport matched the supplied code in any identifier space (IATA/ICAO/GPS/local/ident).',
      recovery:
        'Try ourairports_search_airports with a partial name or municipality to discover the correct code.',
    },
  ],

  input: z.object({
    code: z
      .string()
      .min(1)
      .describe(
        'Any airport code: IATA (SEA), ICAO (KSEA), GPS code, national/local code, or the OurAirports ident. Case-insensitive.',
      ),
    include: z
      .array(z.enum(['runways', 'frequencies']))
      .default(['runways', 'frequencies'])
      .describe(
        'Which related records to include inline. Defaults to both. Pass a subset to trim the response.',
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
        'Human-readable note on how the code resolved, including an ambiguity warning for shared national codes.',
      ),
    runways: z
      .array(RunwaySchema)
      .describe(
        'Runways for the airport (empty array when none recorded, or when runways were not requested in `include`).',
      ),
    frequencies: z
      .array(FrequencySchema)
      .describe(
        'Radio frequencies in MHz (empty array when none recorded, or when frequencies were not requested in `include`).',
      ),
  }),

  handler(input, ctx) {
    const svc = getAirportDataService();
    const resolution = svc.resolveByCode(input.code);
    if (!resolution) {
      throw ctx.fail('unknown_code', `No airport found for code "${input.code}".`, {
        code: input.code,
        ...ctx.recoveryFor('unknown_code'),
      });
    }

    const { airport, resolvedVia, ambiguous } = resolution;
    const wantRunways = input.include.includes('runways');
    const wantFrequencies = input.include.includes('frequencies');

    const country = svc.country(airport.isoCountry);
    const region = svc.region(airport.isoRegion);

    const resolutionNote = ambiguous
      ? `Resolved via ${resolvedVia}. Note: "${input.code.toUpperCase()}" is a national code shared by more than one airport; the first match in the dataset was returned. If this is not the airport you expected, re-query with its IATA or ICAO code, or pass its ident "${airport.ident}".`
      : `Resolved via ${resolvedVia}.`;

    ctx.log.info('Resolved airport', { code: input.code, ident: airport.ident, resolvedVia });

    return {
      airport: toAirportSummary(airport, country?.name, region?.name),
      resolvedVia,
      resolutionNote,
      runways: wantRunways ? svc.runwaysForAirport(airport.id).map(toRunway) : [],
      frequencies: wantFrequencies ? svc.frequenciesForAirport(airport.id).map(toFrequency) : [],
    };
  },

  format: (result) => {
    const dash = (v: string | number | null) => (v == null ? '—' : String(v));
    const lines = [`## ${result.airport.name}`, ...renderAirportLines(result.airport)];
    lines.push(`**Resolved via:** ${result.resolvedVia}`);
    lines.push(`**Resolution:** ${result.resolutionNote}`);

    lines.push(`\n### Runways (${result.runways.length})`);
    if (result.runways.length === 0) {
      lines.push('_None recorded._');
    }
    for (const r of result.runways) {
      const ends = [r.leIdent, r.heIdent].filter(Boolean).join('/') || 'unnamed';
      lines.push(
        `- **${ends}** (id ${r.id}) — length ${dash(r.lengthFt)} ft × width ${dash(r.widthFt)} ft | surface: ${dash(r.surface)} | lighted: ${r.lighted ? 'yes' : 'no'} | closed: ${r.closed ? 'yes' : 'no'}`,
      );
      lines.push(
        `  - headings (true): ${dash(r.leIdent)} ${dash(r.leHeadingDegT)}° / ${dash(r.heIdent)} ${dash(r.heHeadingDegT)}°`,
      );
    }

    lines.push(`\n### Frequencies (${result.frequencies.length})`);
    if (result.frequencies.length === 0) {
      lines.push('_None recorded._');
    }
    for (const f of result.frequencies) {
      lines.push(
        `- **${f.type}** (id ${f.id}) — ${dash(f.frequencyMhz)} MHz — ${dash(f.description)}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
