/**
 * @fileoverview ourairports_search_runways — cross-airport runway search. Filters
 * the bundled runway corpus by airport facets (country / region / type) and
 * runway facets (surface / min length / min width / lighting), joined back to
 * airport summaries. Returns flat { airport, runway } rows, one per matching
 * runway — the counterpart to ourairports_get_airport's per-airport runway list.
 * @module src/mcp-server/tools/definitions/search-runways.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import {
  AirportSummarySchema,
  CountryCodeSchema,
  RegionCodeSchema,
  RunwaySchema,
  renderAirportLines,
  renderRunwayEnds,
  renderRunwayName,
  renderRunwaySpec,
  toAirportSummary,
  toRunway,
} from './_schemas.js';

export const searchRunwaysTool = tool('ourairports_search_runways', {
  title: 'Search Runways',
  description:
    'Search runways across the whole bundled OurAirports corpus by attribute, joined back to their airports — the cross-airport counterpart to ourairports_get_airport (which returns runways for one already-known airport). Filter by airport facets (country, region, type) and runway facets (surface, min_length_ft, min_width_ft, lighted). Returns one flat {airport, runway} row per matching runway, so an airport with three matching runways contributes three rows. `surface` is a case-insensitive substring match against the raw upstream surface string, not an exact code — the runway surface must CONTAIN your text, so a shorter fragment matches more variants (no controlled vocabulary: "asp" matches ASP, ASPH, and Asphalt). Lengths are the full runway surface, including displaced thresholds and overruns — not usable takeoff or landing distance; each runway also reports its displaced threshold per end. A runway whose length or width is unknown is excluded when the matching min_*_ft filter is set — the data can never confirm it meets the threshold. Closed airports and closed runways are both excluded unless their include_* flag is set. Use ourairports_list_countries for valid country/region codes. OurAirports is community-edited — not authoritative for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'unknown_country',
      code: JsonRpcErrorCode.NotFound,
      when: 'The country code is absent from the bundled country table.',
      recovery: 'Call ourairports_list_countries to discover valid country codes, then retry.',
    },
    {
      reason: 'unknown_region',
      code: JsonRpcErrorCode.NotFound,
      when: 'The region code is absent from the bundled region table.',
      recovery:
        'Call ourairports_list_countries with include_regions and optionally country to discover valid region codes, then retry.',
    },
  ],

  input: z.object({
    country: CountryCodeSchema,
    region: RegionCodeSchema,
    type: z
      .enum(AIRPORT_TYPES)
      .optional()
      .describe(
        'Restrict to runways at airports of one type: large_airport, medium_airport, small_airport, heliport, seaplane_base, balloonport, or closed.',
      ),
    min_length_ft: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Minimum length of the full runway surface in feet (inclusive), matched against lengthFt — which includes displaced thresholds and overruns, so this is not a usable-distance filter. Runways with an unknown length are excluded when this is set, never assumed to pass.',
      ),
    min_width_ft: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Minimum runway width in feet (inclusive). Runways with an unknown width are excluded when this is set, never assumed to pass.',
      ),
    surface: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Surface filter — case-insensitive substring match against the raw upstream surface string (free text, no controlled vocabulary; ~654 distinct values). Match the literal text as recorded: "asp" matches ASP/ASPH/Asphalt/ASPH-G, "con" matches CON/Concrete, "turf" or "grs" for grass strips. A shorter fragment matches more variants; there is no enum or reference tool for surfaces.',
      ),
    lighted: z
      .boolean()
      .optional()
      .describe(
        'Filter by runway lighting: true for lighted runways only, false for unlighted only. Omit to include both.',
      ),
    include_closed_airports: z
      .boolean()
      .default(false)
      .describe('Include runways at airports of type "closed". Off by default.'),
    include_closed_runways: z
      .boolean()
      .default(false)
      .describe('Include runways flagged closed. Off by default.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum runway rows to return (1–100). Defaults to OURAIRPORTS_DEFAULT_SEARCH_LIMIT (20).',
      ),
  }),

  output: z.object({
    runways: z
      .array(
        z
          .object({
            airport: AirportSummarySchema.describe(
              'The airport this runway belongs to. Codes the airport lacks are null.',
            ),
            runway: RunwaySchema.describe(
              'The matching runway — full-surface dimensions, surface, lighting, and per-end designators, headings, and displaced thresholds.',
            ),
          })
          .describe('A runway paired with its airport (one row per matching runway).'),
      )
      .describe(
        'Matching runways, each paired with its airport. One row per runway — an airport with N matching runways contributes N rows.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching runways before the limit was applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when more runways matched than were returned.'),
    shown: z
      .number()
      .optional()
      .describe('Number of runway rows returned. Present only when results were truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The limit that was applied. Present only when results were truncated.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched or results were capped — how to broaden or narrow.'),
  },

  handler(input, ctx) {
    const svc = getAirportDataService();
    if (input.country && !svc.country(input.country))
      throw ctx.fail('unknown_country', `Unknown country code "${input.country}".`);
    if (input.region && !svc.region(input.region))
      throw ctx.fail('unknown_region', `Unknown region code "${input.region}".`);
    const limit = input.limit ?? getServerConfig().defaultSearchLimit;
    const result = svc.searchRunways({
      ...(input.country && { country: input.country }),
      ...(input.region && { region: input.region }),
      ...(input.type && { type: input.type }),
      ...(input.surface && { surface: input.surface }),
      ...(input.min_length_ft !== undefined && { minLengthFt: input.min_length_ft }),
      ...(input.min_width_ft !== undefined && { minWidthFt: input.min_width_ft }),
      ...(input.lighted !== undefined && { lighted: input.lighted }),
      includeClosedAirports: input.include_closed_airports,
      includeClosedRunways: input.include_closed_runways,
      limit,
    });

    ctx.enrich.total(result.totalMatched);
    const shown = result.matches.length;
    if (result.totalMatched > shown) {
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance:
          'Add or tighten filters (country, region, type, surface, min_length_ft, min_width_ft, lighted) or raise `limit` (max 100) to see more.',
      });
    }

    if (result.totalMatched === 0) {
      const facets = [
        input.country ? `country=${input.country}` : null,
        input.region ? `region=${input.region}` : null,
        input.type ? `type=${input.type}` : null,
        input.surface ? `surface~"${input.surface}"` : null,
        input.min_length_ft !== undefined ? `min_length_ft=${input.min_length_ft}` : null,
        input.min_width_ft !== undefined ? `min_width_ft=${input.min_width_ft}` : null,
        input.lighted !== undefined ? `lighted=${input.lighted}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      ctx.enrich.notice(
        `No runways matched${facets ? ` ${facets}` : ''}. ` +
          'Relax filters — surface is a substring match (try a shorter fragment), lower min_length_ft/min_width_ft, verify country/region codes with ourairports_list_countries, or set include_closed_airports/include_closed_runways to widen the set.',
      );
    }

    return {
      runways: result.matches.map((m) => ({
        airport: toAirportSummary(
          m.airport,
          svc.country(m.airport.isoCountry)?.name,
          svc.region(m.airport.isoRegion)?.name,
        ),
        runway: toRunway(m.runway),
      })),
    };
  },

  format: (result) => {
    const lines = [`## Runway Search — ${result.runways.length} shown`];
    for (const { airport, runway: r } of result.runways) {
      lines.push('');
      lines.push(...renderAirportLines(airport));
      lines.push(`  **Runway ${renderRunwayName(r)}** ${renderRunwaySpec(r)}`);
      lines.push(`  ${renderRunwayEnds(r)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
