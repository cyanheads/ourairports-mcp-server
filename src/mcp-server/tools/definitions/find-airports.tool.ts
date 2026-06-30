/**
 * @fileoverview ourairports_find_airports — the grounding tool. Airports within
 * a radius of a coordinate, ranked nearest-first by great-circle (haversine)
 * distance. Coordinate in, ranked airports out — no geocoding (resolve place
 * names upstream first). This is what the live aviation servers call to turn a
 * lat/lon into the nearest airport(s).
 * @module src/mcp-server/tools/definitions/find-airports.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import { AirportSummarySchema, renderAirportLines, toAirportSummary } from './_schemas.js';

export const findAirportsTool = tool('ourairports_find_airports', {
  title: 'ourairports-mcp-server',
  description:
    'Find airports within a radius of a latitude/longitude, ranked nearest-first by great-circle distance, each with its distance (km) and bearing (degrees true) from the query point. The grounding tool for "nearest airport to here" — pair it with a live aviation server to fetch weather or positions for the result. Takes a coordinate only: no geocoding, so resolve place names to lat/lon upstream first (e.g. an OpenStreetMap or Open-Meteo geocode tool). Closed airports are excluded unless include_closed is set. OurAirports is community-edited — not authoritative for flight operations.',
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
      .max(500)
      .default(100)
      .describe('Search radius in kilometers (1–500). Defaults to 100.'),
    type: z
      .enum(AIRPORT_TYPES)
      .optional()
      .describe('Restrict to one airport type (e.g. large_airport for major fields only).'),
    include_closed: z
      .boolean()
      .default(false)
      .describe('Include airports of type "closed". Off by default.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Maximum airports to return (1–50). Defaults to OURAIRPORTS_DEFAULT_SEARCH_LIMIT (20).',
      ),
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
    totalCount: z.number().describe('Number of airports returned within the radius.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no airport fell within the radius — e.g. widen radius_km.'),
  },

  handler(input, ctx) {
    const svc = getAirportDataService();
    // Honor OURAIRPORTS_DEFAULT_SEARCH_LIMIT when limit is omitted, clamped to
    // this tool's own max of 50 (the config ceiling is 100) (#4).
    const limit = Math.min(input.limit ?? getServerConfig().defaultSearchLimit, 50);
    const hits = svc.nearbyAirports(
      input.latitude,
      input.longitude,
      input.radius_km,
      limit,
      input.type,
      input.include_closed,
    );

    ctx.enrich.total(hits.length);
    if (hits.length === 0) {
      ctx.enrich.notice(
        `No airports within ${input.radius_km} km of ${input.latitude}, ${input.longitude}` +
          `${input.type ? ` of type ${input.type}` : ''}. Widen radius_km (max 500)` +
          `${input.type ? ', drop the type filter,' : ''}${input.include_closed ? '' : ' or set include_closed'} and retry.`,
      );
    }

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
    const lines = [`## Nearest Airports — ${result.airports.length} within radius`];
    for (const h of result.airports) {
      lines.push('');
      lines.push(`**${h.distanceKm} km** at bearing ${h.bearingDeg}°`);
      lines.push(...renderAirportLines(h.airport));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
