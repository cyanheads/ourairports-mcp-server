/**
 * @fileoverview Navigation aids by coordinate, associated airport, or exact ident.
 * Every mode reports filtered totals and stable offset continuation.
 * @module src/mcp-server/tools/definitions/find-navaids.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { MAX_RADIUS_KM } from '@/services/airport-data/geo.js';
import { NAVAID_TYPES } from '@/services/airport-data/types.js';
import { pageLimit } from '../page-limit.js';
import {
  buildResolutionNote,
  escapeMarkdown,
  NavaidSchema,
  numOrDash,
  renderNavaidFrequency,
  renderNotice,
  textOrDash,
  toNavaid,
} from './_schemas.js';

const limitPolicy = pageLimit(50);

export const findNavaidsTool = tool('ourairports_find_navaids', {
  title: 'Find Navaids',
  description:
    'Find navigation aids (VOR, VOR-DME, DME, NDB, NDB-DME, TACAN, VORTAC) by exactly one mode: latitude+longitude with optional radius_km, airport_code for navaids serving an airport, or ident for every exact navaid-code holder. Coordinate results rank nearest-first with distance (km) and bearing (degrees true); airport and ident results retain dataset order. frequencyKhz is stored for every type; frequencyMhz is the VHF or paired-VHF frequency and is null for NDB and NDB-DME. Each navaid includes DME pairing, usage, power, and magnetic variation. totalCount counts filtered matches before paging; pass nextOffset as offset with the same query to continue. An unmatched ident or an airport with no associated navaids returns an empty list; an unknown airport_code is an error. Shared airport codes carry a resolutionNote naming the other airport idents. OurAirports is community-edited — not authoritative for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'mode_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Coordinates are incomplete, multiple query modes were supplied, or no query mode was supplied.',
      recovery:
        'Supply exactly one mode: latitude and longitude, airport_code for associated navaids, or ident for an exact navaid code.',
    },
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'airport_code did not match any airport in any identifier space.',
      recovery:
        'Verify the code with ourairports_search_airports or ourairports_get_airport, then retry airport mode.',
    },
  ],

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Coordinate mode: query point latitude (−90 to 90). Provide with longitude; mutually exclusive with airport_code and ident.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Coordinate mode: query point longitude (−180 to 180). Provide with latitude.'),
    radius_km: z
      .number()
      .min(1)
      .max(MAX_RADIUS_KM)
      .default(100)
      .describe(
        `Coordinate mode: search radius in kilometers (1–${MAX_RADIUS_KM}). Defaults to 100. Ignored in airport and ident modes.`,
      ),
    airport_code: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Airport mode: any airport code (IATA/ICAO/GPS/local/ident); returns the navaids serving that airport. Case-insensitive; surrounding whitespace is ignored. Mutually exclusive with latitude/longitude and ident.',
      ),
    ident: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Ident mode: exact navaid ident, case-insensitive with surrounding whitespace ignored. Returns all holders, including navaids with no associated airport. Mutually exclusive with coordinates and airport_code.',
      ),
    type: z
      .enum(NAVAID_TYPES)
      .optional()
      .describe('Restrict to one navaid type: NDB, VOR-DME, VORTAC, TACAN, VOR, DME, or NDB-DME.'),
    limit: limitPolicy.schema,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching navaids to skip in the same query and data snapshot. Use nextOffset to continue.',
      ),
  }),

  output: z.object({
    mode: z.enum(['coordinate', 'airport', 'ident']).describe('Which query mode was used.'),
    airportIdent: z
      .string()
      .nullable()
      .describe(
        'In airport mode, the resolved airport ident the navaids were matched against; null in coordinate and ident modes.',
      ),
    navaids: z
      .array(
        NavaidSchema.extend({
          distanceKm: z
            .number()
            .nullable()
            .describe(
              'Great-circle distance from the query point in km (coordinate mode); null in airport and ident modes.',
            ),
          bearingDeg: z
            .number()
            .nullable()
            .describe(
              'Bearing from the query point in degrees true (coordinate mode); null in airport and ident modes.',
            ),
        }).describe(
          'A navaid with its frequency (kHz, plus MHz where the type has a VHF frequency), type, position, DME pairing, service volume, power, magnetic variation, and — in coordinate mode — distance and bearing from the query point.',
        ),
      )
      .describe(
        'Matching navaids. Nearest-first in coordinate mode; dataset order in airport and ident modes.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Navaids matching the selected mode and type filter before offset and limit.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when matching navaids remain after this page.'),
    shown: z
      .number()
      .optional()
      .describe('Number of navaids returned. Present only when results were truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The limit that was applied. Present only when results were truncated.'),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        'Offset for the next page using the same query. Absent on final and past-end pages.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Limit-clamp disclosure, continuation, past-end guidance, or an explanation of an empty match set.',
      ),
    resolutionNote: z
      .string()
      .optional()
      .describe(
        "Airport mode, present only when airport_code is also a code of other airports: the identifier space that matched, why this airport won, and each other airport's ident, country, and code space.",
      ),
  },

  enrichmentTrailer: {
    resolutionNote: { label: 'Resolution' },
    notice: { render: renderNotice },
  },

  handler(input, ctx) {
    const svc = getAirportDataService();

    const hasCoord = input.latitude !== undefined && input.longitude !== undefined;
    const hasPartialCoord = input.latitude !== undefined || input.longitude !== undefined;
    // Schema trims and rejects blank airport_code, so presence alone selects
    // airport mode — whitespace can no longer fall through to mode_conflict (#7).
    const hasAirport = input.airport_code !== undefined;
    const hasIdent = input.ident !== undefined;

    // Exactly one mode. A lone latitude or longitude is also a conflict.
    if (hasPartialCoord && !hasCoord) {
      const supplied = input.latitude !== undefined ? 'latitude' : 'longitude';
      const missing = input.latitude !== undefined ? 'longitude' : 'latitude';
      throw ctx.fail(
        'mode_conflict',
        `${supplied} was supplied without ${missing}.${hasAirport ? ' airport_code cannot be combined with coordinates.' : ''}${hasIdent ? ' ident cannot be combined with coordinates.' : ''}`,
      );
    }
    if (Number(hasAirport) + Number(hasCoord) + Number(hasIdent) !== 1) {
      throw ctx.fail(
        'mode_conflict',
        hasIdent
          ? 'ident cannot be combined with airport_code or latitude/longitude.'
          : hasAirport
            ? 'Both latitude/longitude and airport_code were supplied.'
            : 'Supply latitude/longitude, airport_code, or ident.',
      );
    }

    const { limit, notice } = limitPolicy.resolve(input.limit, ctx);
    const finish = <T extends { navaids: unknown[] }>(
      result: T,
      total: number,
      emptyNotice: string,
    ): T => {
      const notices = notice ? [notice] : [];
      ctx.enrich.total(total);
      const nextOffset = input.offset + result.navaids.length;
      if (nextOffset < total) {
        ctx.enrich({ nextOffset });
        ctx.enrich.truncated({ shown: result.navaids.length, cap: limit });
        notices.push(
          `Continue with offset ${nextOffset} (nextOffset) and the same query to read more navaids.`,
        );
      } else if (total > 0 && result.navaids.length === 0) {
        notices.push(
          `The offset ${input.offset} is past the ${total} matching navaids. Retry with offset 0 or a previous nextOffset.`,
        );
      }
      if (total === 0) notices.push(emptyNotice);
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      return result;
    };

    if (input.latitude !== undefined && input.longitude !== undefined) {
      const { navaids: hits, totalMatched } = svc.nearbyNavaids(
        input.latitude,
        input.longitude,
        input.radius_km,
        limit,
        input.type,
        input.offset,
      );
      const recovery = [
        input.radius_km < MAX_RADIUS_KM ? `Widen radius_km (max ${MAX_RADIUS_KM})` : null,
        input.type ? 'drop the type filter' : null,
      ]
        .filter(Boolean)
        .join(' or ');
      return finish(
        {
          mode: 'coordinate' as const,
          airportIdent: null,
          navaids: hits.map((h) => ({
            ...toNavaid(h.navaid),
            distanceKm: Math.round(h.distanceKm * 100) / 100,
            bearingDeg: Math.round(h.bearingDeg * 10) / 10,
          })),
        },
        totalMatched,
        `No navaids within ${input.radius_km} km of ${input.latitude}, ${input.longitude}${input.type ? ` of type ${input.type}` : ''}.${recovery ? ` ${recovery} and retry.` : ' The search already covers the globe.'}`,
      );
    }

    if (input.ident !== undefined) {
      const { navaids, totalMatched } = svc.navaidsByIdent(
        input.ident,
        input.type,
        limit,
        input.offset,
      );
      return finish(
        {
          mode: 'ident' as const,
          airportIdent: null,
          navaids: navaids.map((n) => ({ ...toNavaid(n), distanceKm: null, bearingDeg: null })),
        },
        totalMatched,
        `No navaids matched ident "${input.ident}"${input.type ? ` of type ${input.type}` : ''}. Verify the navaid ident${input.type ? ' or drop the type filter' : ''}; use airport_code only for an airport identifier.`,
      );
    }

    // Airport mode — resolve the code at the tool boundary so an unknown code
    // carries the declared unknown_code recovery hint (mirrors get_airport),
    // then look up associated navaids. "Found but no navaids" is an empty list.
    const code = input.airport_code as string;
    const resolution = svc.resolveByCode(code);
    if (!resolution) {
      throw ctx.fail('unknown_code', `No airport found for code "${code}".`, { code });
    }
    const { airport } = resolution;
    const ident = airport.ident;
    // A code shared with other airports resolves silently otherwise; the note
    // is its own field so notice-writing paths (last-wins) never overwrite it.
    if (resolution.sharedWith.length > 0) {
      ctx.enrich({ resolutionNote: buildResolutionNote(code, resolution) });
    }
    const { navaids, totalMatched } = svc.navaidsForAirport(ident, input.type, limit, input.offset);
    return finish(
      {
        mode: 'airport' as const,
        airportIdent: ident,
        navaids: navaids.map((n) => ({ ...toNavaid(n), distanceKm: null, bearingDeg: null })),
      },
      totalMatched,
      `Airport ${ident} was found but has no associated navaids${input.type ? ` of type ${input.type}` : ''} in the dataset. Many small fields have none; try coordinate mode around ${airport.latitudeDeg}, ${airport.longitudeDeg} to find nearby enroute navaids.`,
    );
  },

  format: (result) => {
    const lines = [
      `## Navaids — ${result.navaids.length} shown`,
      `**Mode:** ${result.mode} | **Airport:** ${textOrDash(result.airportIdent)}`,
    ];
    for (const n of result.navaids) {
      lines.push('');
      lines.push(
        `**${escapeMarkdown(n.ident)} — ${escapeMarkdown(n.name)}** [${escapeMarkdown(n.type)}] (id ${n.id})`,
      );
      lines.push(`**Frequency:** ${renderNavaidFrequency(n)}`);
      lines.push(
        `**Usage:** ${textOrDash(n.usageType)} | **Power:** ${textOrDash(n.power)} | **Magnetic variation:** ${numOrDash(n.magneticVariationDeg)}° actual, ${numOrDash(n.slavedVariationDeg)}° slaved`,
      );
      lines.push(
        `**Position:** ${n.latitudeDeg}, ${n.longitudeDeg} · elevation ${numOrDash(n.elevationFt)} ft`,
      );
      lines.push(`**Distance:** ${numOrDash(n.distanceKm)} km at ${numOrDash(n.bearingDeg)}°`);
      lines.push(
        `**DME channel:** ${textOrDash(n.dmeChannel)} · paired VHF ${numOrDash(n.dmeFrequencyKhz)} kHz | **Serves:** ${textOrDash(n.associatedAirport)} | **Country:** ${textOrDash(n.isoCountry)}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
