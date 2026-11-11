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
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { MAX_RADIUS_KM } from '@/services/airport-data/geo.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import { pageLimit } from '../page-limit.js';
import {
  AirportSummarySchema,
  CountryCodeSchema,
  numOrDash,
  RegionCodeSchema,
  RunwaySchema,
  renderAirportLines,
  renderNotice,
  renderRunwayEnds,
  renderRunwayName,
  renderRunwaySpec,
  toAirportSummary,
  toRunway,
} from './_schemas.js';

const runwayPageLimit = pageLimit(100);
const surfaceFragment = z.string().trim().min(1);

export const searchRunwaysTool = tool('ourairports_search_runways', {
  title: 'Search Runways',
  description:
    'Search the bundled OurAirports corpus by airport and runway attributes. Returns one row per matching runway, paired with its airport. Supply latitude and longitude together to filter by radius and rank by distance to each parent airport. Surface matches any supplied fragment as a case-insensitive substring of the recorded surface. Lengths describe the full runway surface, including displaced thresholds and overruns. Minimum length and width filters exclude runways missing the corresponding measurement. Closed airports and runways are excluded unless their respective flags are set. Use nextOffset to continue the same query and ourairports_list_countries to find valid country and region codes. OurAirports is community-edited. Consult official sources for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'incomplete_coordinates',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one coordinate is supplied, or a radius is supplied without both coordinates.',
      recovery: 'Supply both latitude and longitude, or omit both coordinates and radius_km.',
    },
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
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Query point latitude in decimal degrees (WGS84). Supply with longitude.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Query point longitude in decimal degrees (WGS84). Supply with latitude.'),
    radius_km: z
      .number()
      .min(1)
      .max(MAX_RADIUS_KM)
      .optional()
      .describe(
        'Search radius in kilometers (1–20,016). Defaults to 100 when coordinates are supplied.',
      ),
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
      .union([
        surfaceFragment.describe('One surface fragment.'),
        z.array(surfaceFragment).min(1).describe('Surface fragments combined with OR.'),
      ])
      .optional()
      .describe(
        'One fragment or a non-empty array of fragments. A runway qualifies when any fragment matches a case-insensitive substring of its recorded surface. For example, ["asp", "con", "pem"] matches records such as ASP, ASPH, CON, or PEM.',
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
    limit: runwayPageLimit.schema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Matching runway rows to skip. Defaults to 0. Use nextOffset to continue.'),
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
            distanceKm: z
              .number()
              .nullable()
              .describe(
                'Great-circle distance to the parent airport in kilometers, or null without a query point.',
              ),
            bearingDeg: z
              .number()
              .nullable()
              .describe(
                'Initial bearing to the parent airport in degrees true, or null without a query point.',
              ),
          })
          .describe('A runway paired with its airport (one row per matching runway).'),
      )
      .describe(
        'Matching runways, each paired with its airport. One row per runway — an airport with N matching runways contributes N rows.',
      ),
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching runways before offset and limit.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when matches remain after this page.'),
    shown: z
      .number()
      .optional()
      .describe('Number of runway rows returned. Present only when results were truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The limit that was applied. Present only when results were truncated.'),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe('Offset for the next page with the same query.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance for an empty page, continuation, or a clamped limit.'),
  },

  enrichmentTrailer: {
    notice: { render: renderNotice },
  },

  handler(input, ctx) {
    const { latitude, longitude, radius_km, offset } = input;
    const spatial =
      latitude !== undefined && longitude !== undefined
        ? { latitude, longitude, radiusKm: radius_km ?? 100 }
        : undefined;
    if (!spatial && (latitude !== undefined || longitude !== undefined || radius_km !== undefined))
      throw ctx.fail('incomplete_coordinates');

    const svc = getAirportDataService();
    if (input.country && !svc.country(input.country))
      throw ctx.fail('unknown_country', `Unknown country code "${input.country}".`);
    if (input.region && !svc.region(input.region))
      throw ctx.fail('unknown_region', `Unknown region code "${input.region}".`);
    const { limit, notice: clampNotice } = runwayPageLimit.resolve(input.limit, ctx);
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
      ...(spatial && { spatial }),
      limit,
      offset,
    });

    ctx.enrich.total(result.totalMatched);
    const notices = clampNotice ? [clampNotice] : [];
    const shown = result.matches.length;
    const nextOffset = offset + shown;
    if (nextOffset < result.totalMatched) {
      ctx.enrich.truncated({ shown, cap: limit });
      ctx.enrich({ nextOffset });
      notices.push('Use nextOffset as offset with the same query to continue.');
    } else if (result.totalMatched === 0) {
      const facets = [
        input.country ? `country=${input.country}` : null,
        input.region ? `region=${input.region}` : null,
        input.type ? `type=${input.type}` : null,
        input.min_length_ft !== undefined ? `min_length_ft=${input.min_length_ft}` : null,
        input.min_width_ft !== undefined ? `min_width_ft=${input.min_width_ft}` : null,
        input.lighted !== undefined ? `lighted=${input.lighted}` : null,
        spatial
          ? `within ${spatial.radiusKm} km of ${spatial.latitude}, ${spatial.longitude}`
          : null,
      ]
        .filter(Boolean)
        .join(', ');
      notices.push(
        `No runways matched${facets ? ` ${facets}` : ''}. Relax filters by shortening surface fragments, lowering min_length_ft or min_width_ft, or opting in to closed airports or runways.`,
      );
    } else if (shown === 0) {
      notices.push(
        `The requested offset ${offset} is past the ${result.totalMatched} matching runways. Use a smaller offset to see results.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      runways: result.matches.map((m) => ({
        airport: toAirportSummary(
          m.airport,
          svc.country(m.airport.isoCountry)?.name,
          svc.region(m.airport.isoRegion)?.name,
        ),
        runway: toRunway(m.runway),
        distanceKm: m.distanceKm === null ? null : Math.round(m.distanceKm * 100) / 100,
        bearingDeg: m.bearingDeg === null ? null : Math.round(m.bearingDeg * 10) / 10,
      })),
    };
  },

  format: (result) => {
    const lines = [`## Runway Search — ${result.runways.length} shown`];
    for (const { airport, runway: r, distanceKm, bearingDeg } of result.runways) {
      lines.push('');
      lines.push(...renderAirportLines(airport));
      lines.push(`  **Runway ${renderRunwayName(r)}** ${renderRunwaySpec(r)}`);
      lines.push(`  ${renderRunwayEnds(r)}`);
      lines.push(
        `  **Distance:** ${numOrDash(distanceKm)} km at bearing ${numOrDash(bearingDeg)}°`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
