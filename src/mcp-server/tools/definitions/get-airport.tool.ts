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
  buildResolutionNote,
  escapeMarkdown,
  FrequencySchema,
  numOrDash,
  RunwaySchema,
  renderAirportLines,
  renderRunwayEnds,
  renderRunwayName,
  renderRunwaySpec,
  textOrDash,
  toAirportSummary,
  toFrequency,
  toRunway,
} from './_schemas.js';

export const getAirportTool = tool('ourairports_get_airport', {
  title: 'ourairports-mcp-server',
  description:
    "Fetch the full record for one airport resolved by ANY code — IATA (SEA), ICAO (KSEA), GPS, national/local, or the OurAirports ident — with its runways and radio frequencies inline. The single `code` param is resolved case-insensitively across all five identifier spaces (priority: ident, then ICAO, IATA, GPS, local). The response always echoes the airport's complete code set and a resolutionNote naming which space matched; when other airports carry the same code, the note names each one (ident, country, code space) and why this airport won, so a wrong resolution is self-correcting — pass the other airport's ident to fetch it. Absent codes are reported as null, never an error. Runway lengths are the full runway surface (displaced thresholds and overruns included), not usable takeoff or landing distance. Closed airports always resolve. OurAirports is community-edited — not authoritative for flight operations.",
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
      .trim()
      .min(1)
      .describe(
        'Any airport code: IATA (SEA), ICAO (KSEA), GPS code, national/local code, or the OurAirports ident. Case-insensitive; surrounding whitespace is ignored.',
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
        "How the code resolved: the identifier space that matched and, when other airports carry the same code, why this one won (resolution priority or dataset row order) and each other airport's ident, country, and code space — pass that ident to fetch it.",
      ),
    included: z
      .array(z.enum(['runways', 'frequencies']))
      .describe(
        'Which related-record sets this response carries, echoing the effective `include` selection. A relation NOT listed here was omitted by `include` (its array is empty for that reason); a listed relation with an empty array genuinely has no records.',
      ),
    runways: z
      .array(RunwaySchema)
      .describe(
        'Runways for the airport. Empty when the airport has none OR when `runways` was not in `include` — check `included` to tell which.',
      ),
    frequencies: z
      .array(FrequencySchema)
      .describe(
        'Radio frequencies in MHz. Empty when the airport has none OR when `frequencies` was not in `include` — check `included` to tell which.',
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

    const { airport, resolvedVia } = resolution;
    const wantRunways = input.include.includes('runways');
    const wantFrequencies = input.include.includes('frequencies');

    const country = svc.country(airport.isoCountry);
    const region = svc.region(airport.isoRegion);
    const resolutionNote = buildResolutionNote(input.code, resolution);

    ctx.log.info('Resolved airport', { code: input.code, ident: airport.ident, resolvedVia });

    const included: ('runways' | 'frequencies')[] = [];
    if (wantRunways) included.push('runways');
    if (wantFrequencies) included.push('frequencies');

    return {
      airport: toAirportSummary(airport, country?.name, region?.name),
      resolvedVia,
      resolutionNote,
      included,
      runways: wantRunways ? svc.runwaysForAirport(airport.id).map(toRunway) : [],
      frequencies: wantFrequencies ? svc.frequenciesForAirport(airport.id).map(toFrequency) : [],
    };
  },

  format: (result) => {
    const lines = [
      `## ${escapeMarkdown(result.airport.name)}`,
      ...renderAirportLines(result.airport),
    ];
    lines.push(`**Resolved via:** ${escapeMarkdown(result.resolvedVia)}`);
    lines.push(`**Resolution:** ${escapeMarkdown(result.resolutionNote)}`);
    lines.push(`**Included:** ${result.included.length > 0 ? result.included.join(', ') : 'none'}`);

    // The item loops never gate on `included` — format-parity walks a synthetic
    // value with both arrays populated, so both loops must always run. Only the
    // header count and empty-state line branch on the selection: an omitted
    // relation reads "not requested" (never "None recorded"), so text-only
    // clients can distinguish omission from genuine absence.
    const wantRunways = result.included.includes('runways');
    lines.push(wantRunways ? `\n### Runways (${result.runways.length})` : '\n### Runways');
    if (result.runways.length === 0) {
      lines.push(
        wantRunways ? '_None recorded._' : '_Not requested — add "runways" to `include` to fetch._',
      );
    }
    for (const r of result.runways) {
      lines.push(`- **${renderRunwayName(r)}** ${renderRunwaySpec(r)}`);
      lines.push(`  - ${renderRunwayEnds(r)}`);
    }

    const wantFrequencies = result.included.includes('frequencies');
    lines.push(
      wantFrequencies ? `\n### Frequencies (${result.frequencies.length})` : '\n### Frequencies',
    );
    if (result.frequencies.length === 0) {
      lines.push(
        wantFrequencies
          ? '_None recorded._'
          : '_Not requested — add "frequencies" to `include` to fetch._',
      );
    }
    for (const f of result.frequencies) {
      lines.push(
        `- **${escapeMarkdown(f.type)}** (id ${f.id}) — ${numOrDash(f.frequencyMhz)} MHz — ${textOrDash(f.description)}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
