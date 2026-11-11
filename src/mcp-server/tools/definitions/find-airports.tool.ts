/**
 * @fileoverview ourairports_find_airports — the grounding tool. Airports within
 * a radius of a coordinate, ranked nearest-first by great-circle (haversine)
 * distance. Coordinate in, ranked airports out — no geocoding (resolve place
 * names upstream first). This is what the live aviation servers call to turn a
 * lat/lon into the nearest airport(s).
 * @module src/mcp-server/tools/definitions/find-airports.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { pageLimit } from '@/mcp-server/tools/page-limit.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { MAX_RADIUS_KM } from '@/services/airport-data/geo.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import { AirportSummarySchema, renderAirportLines, toAirportSummary } from './_schemas.js';

const airportPageLimit = pageLimit(50);

export const findAirportsTool = tool('ourairports_find_airports', {
  title: 'Find Airports',
  description:
    'Find airports within a radius of a latitude/longitude, ranked nearest-first by great-circle distance. Each result includes distance in kilometers and bearing in degrees true from the query point. Resolve place names to coordinates before calling. Use nextOffset to continue the same query. OurAirports is community-edited — not authoritative for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe('Query point latitude in decimal degrees (WGS84), −90 to 90.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Query point longitude in decimal degrees (WGS84), −180 to 180.'),
    radius_km: z
      .number()
      .min(1)
      .max(MAX_RADIUS_KM)
      .default(100)
      .describe(`Search radius in kilometers (1–${MAX_RADIUS_KM}). Defaults to 100.`),
    type: z
      .enum(AIRPORT_TYPES)
      .optional()
      .describe('Restrict to one airport type (e.g. large_airport for major fields only).'),
    include_closed: z
      .boolean()
      .default(false)
      .describe('Include airports of type "closed". Off by default.'),
    limit: airportPageLimit.schema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Matching airports to skip. Defaults to 0. Use nextOffset to continue.'),
  }),

  output: z.object({
    airports: z
      .array(
        z
          .object({
            airport: AirportSummarySchema.describe(
              'The airport record. Codes the airport lacks are null.',
            ),
            distanceKm: z
              .number()
              .describe('Great-circle distance from the query point in kilometers.'),
            bearingDeg: z
              .number()
              .describe(
                'Initial bearing from the query point in degrees true (0–360, clockwise from north).',
              ),
          })
          .describe('An airport with its great-circle distance and bearing from the query point.'),
      )
      .describe('Airports within the radius, nearest-first.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Airports within the radius that pass the type and include_closed filters, counted before offset and limit.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when matches remain after this page.'),
    shown: z
      .number()
      .optional()
      .describe('Number of airports returned. Present only when results were truncated.'),
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

  handler(input, ctx) {
    const svc = getAirportDataService();
    const { limit, notice: clampNotice } = airportPageLimit.resolve(input.limit, ctx);
    const { airports: hits, totalMatched } = svc.nearbyAirports(
      input.latitude,
      input.longitude,
      input.radius_km,
      limit,
      input.type,
      input.include_closed,
      input.offset,
    );

    ctx.enrich.total(totalMatched);
    const notices = clampNotice ? [clampNotice] : [];
    const nextOffset = input.offset + hits.length;
    if (nextOffset < totalMatched) {
      ctx.enrich.truncated({ shown: hits.length, cap: limit });
      ctx.enrich({ nextOffset });
      notices.push('Use nextOffset as offset with the same query to continue.');
    } else if (totalMatched === 0) {
      notices.push(
        `No airports within ${input.radius_km} km of ${input.latitude}, ${input.longitude}${input.type ? ` of type ${input.type}` : ''}.`,
      );
      if (input.radius_km < MAX_RADIUS_KM) notices.push(`Widen radius_km (max ${MAX_RADIUS_KM}).`);
      if (input.type) notices.push('Drop the type filter.');
      if (!input.include_closed) notices.push('Set include_closed to include closed airports.');
    } else if (hits.length === 0) {
      notices.push(
        `Offset ${input.offset} is past the ${totalMatched} matching airports. Use a smaller offset to see results.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      airports: hits.map((h) => ({
        airport: toAirportSummary(
          h.airport,
          svc.country(h.airport.isoCountry)?.name,
          svc.region(h.airport.isoRegion)?.name,
        ),
        distanceKm: Math.round(h.distanceKm * 100) / 100,
        bearingDeg: Math.round(h.bearingDeg * 10) / 10,
      })),
    };
  },

  format: (result) => {
    const lines = [`## Nearest Airports — ${result.airports.length} shown`];
    for (const h of result.airports) {
      lines.push('');
      lines.push(`**${h.distanceKm} km** at bearing ${h.bearingDeg}°`);
      lines.push(...renderAirportLines(h.airport));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
