/**
 * @fileoverview ourairports_find_navaids — navigation aids near a coordinate OR
 * serving a specific airport. Two-mode tool validated to exactly one mode:
 * coordinate mode runs a haversine scan over navaid positions; airport mode is a
 * lookup on the navaid→airport-ident join. Frequencies are stored in kHz for all
 * navaid types; MHz is added only where the type has a VHF or paired-VHF
 * frequency. Both modes report the match count before `limit` and disclose
 * truncation.
 * @module src/mcp-server/tools/definitions/find-navaids.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { NAVAID_TYPES } from '@/services/airport-data/types.js';
import {
  buildResolutionNote,
  escapeMarkdown,
  NavaidSchema,
  numOrDash,
  renderNavaidFrequency,
  textOrDash,
  toNavaid,
} from './_schemas.js';

export const findNavaidsTool = tool('ourairports_find_navaids', {
  title: 'ourairports-mcp-server',
  description:
    'Find navigation aids (VOR, VOR-DME, DME, NDB, NDB-DME, TACAN, VORTAC) two ways: spatially, by passing latitude+longitude (with an optional radius_km); or relationally, by passing airport_code to get the navaids that serve that airport. Supply exactly one mode — both or neither is a validation error. Coordinate mode ranks nearest-first with distance (km) and bearing (degrees true). frequencyKhz is the stored value for every navaid type (a VOR on 114.5 MHz reads 114500); frequencyMhz carries the VHF frequency of a VOR or VOR-DME and the paired VHF frequency of a DME, TACAN, or VORTAC, and is null for NDB and NDB-DME, which are tuned in kHz. Each navaid also carries its DME paired frequency, usage class, power, and actual and slaved magnetic variation. totalCount is the match count before limit; a capped result says so. Airport mode returns an empty list (not an error) when the airport exists but has no associated navaids; an unknown airport_code is an error. When airport_code is also a code of other airports, a resolutionNote says which airport it resolved to and names the others by ident — pass that ident to query one of them. OurAirports is community-edited — not authoritative for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'mode_conflict',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both coordinate (latitude/longitude) and airport_code were supplied, or neither was.',
      recovery:
        'Supply exactly one mode: either latitude and longitude (coordinate search) or airport_code (navaids serving an airport).',
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
        'Coordinate mode: query point latitude (−90 to 90). Provide with longitude; mutually exclusive with airport_code.',
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
      .max(500)
      .default(100)
      .describe(
        'Coordinate mode: search radius in kilometers (1–500). Defaults to 100. Ignored in airport mode.',
      ),
    airport_code: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Airport mode: any airport code (IATA/ICAO/GPS/local/ident); returns the navaids serving that airport. Case-insensitive; surrounding whitespace is ignored. Mutually exclusive with latitude/longitude.',
      ),
    type: z
      .enum(NAVAID_TYPES)
      .optional()
      .describe('Restrict to one navaid type: NDB, VOR-DME, VORTAC, TACAN, VOR, DME, or NDB-DME.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Maximum navaids to return (1–50). Defaults to OURAIRPORTS_DEFAULT_SEARCH_LIMIT (20).',
      ),
  }),

  output: z.object({
    mode: z.enum(['coordinate', 'airport']).describe('Which query mode was used.'),
    airportIdent: z
      .string()
      .nullable()
      .describe(
        'In airport mode, the resolved airport ident the navaids were matched against; null in coordinate mode.',
      ),
    navaids: z
      .array(
        NavaidSchema.extend({
          distanceKm: z
            .number()
            .nullable()
            .describe(
              'Great-circle distance from the query point in km (coordinate mode); null in airport mode.',
            ),
          bearingDeg: z
            .number()
            .nullable()
            .describe(
              'Bearing from the query point in degrees true (coordinate mode); null in airport mode.',
            ),
        }).describe(
          'A navaid with its frequency (kHz, plus MHz where the type has a VHF frequency), type, position, DME pairing, service volume, power, magnetic variation, and — in coordinate mode — distance and bearing from the query point.',
        ),
      )
      .describe(
        'Matching navaids. Nearest-first in coordinate mode; in airport-association order in airport mode.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Navaids matched before the limit was applied: in-radius navaids passing the type filter (coordinate mode), or navaids associated with the airport passing the type filter (airport mode).',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when more navaids matched than were returned.'),
    shown: z
      .number()
      .optional()
      .describe('Number of navaids returned. Present only when results were truncated.'),
    cap: z
      .number()
      .optional()
      .describe('The limit that was applied. Present only when results were truncated.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no navaids matched (empty radius, or airport found but unserved) or results were capped — how to widen or narrow.',
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
  },

  handler(input, ctx) {
    // Clamp the config-derived default to this tool's own max of 50 (the config
    // ceiling is 100), aligning with find_airports (#4).
    const limit = Math.min(input.limit ?? getServerConfig().defaultSearchLimit, 50);
    const svc = getAirportDataService();

    const hasCoord = input.latitude !== undefined && input.longitude !== undefined;
    const hasPartialCoord = input.latitude !== undefined || input.longitude !== undefined;
    // Schema trims and rejects blank airport_code, so presence alone selects
    // airport mode — whitespace can no longer fall through to mode_conflict (#7).
    const hasAirport = input.airport_code !== undefined;

    // Exactly one mode. A lone latitude or longitude is also a conflict.
    if (hasAirport === hasCoord || (hasPartialCoord && !hasCoord)) {
      throw ctx.fail('mode_conflict', undefined, { ...ctx.recoveryFor('mode_conflict') });
    }

    if (hasCoord) {
      const { navaids: hits, totalMatched } = svc.nearbyNavaids(
        input.latitude as number,
        input.longitude as number,
        input.radius_km,
        limit,
        input.type,
      );
      ctx.enrich.total(totalMatched);
      // Truncation (≥ 1 shown) and the empty-radius notice are mutually exclusive.
      if (totalMatched > hits.length) {
        ctx.enrich.truncated({
          shown: hits.length,
          cap: limit,
          guidance: `Results are nearest-first, so the omitted navaids lie farther out. ${input.type ? 'Narrow radius_km or raise' : 'Narrow radius_km, add a type filter, or raise'} \`limit\` (max 50) to see more.`,
        });
      } else if (totalMatched === 0) {
        ctx.enrich.notice(
          `No navaids within ${input.radius_km} km of ${input.latitude}, ${input.longitude}` +
            `${input.type ? ` of type ${input.type}` : ''}. Widen radius_km (max 500)${input.type ? ' or drop the type filter' : ''} and retry.`,
        );
      }
      return {
        mode: 'coordinate' as const,
        airportIdent: null,
        navaids: hits.map((h) => ({
          ...toNavaid(h.navaid),
          distanceKm: Math.round(h.distanceKm * 100) / 100,
          bearingDeg: Math.round(h.bearingDeg * 10) / 10,
        })),
      };
    }

    // Airport mode — resolve the code at the tool boundary so an unknown code
    // carries the declared unknown_code recovery hint (mirrors get_airport),
    // then look up associated navaids. "Found but no navaids" is an empty list.
    const code = input.airport_code as string;
    const resolution = svc.resolveByCode(code);
    if (!resolution) {
      throw ctx.fail('unknown_code', `No airport found for code "${code}".`, {
        code,
        ...ctx.recoveryFor('unknown_code'),
      });
    }
    const { airport } = resolution;
    const ident = airport.ident;
    // A code shared with other airports resolves silently otherwise; the note
    // is its own field so notice-writing paths (last-wins) never overwrite it.
    if (resolution.sharedWith.length > 0) {
      ctx.enrich({ resolutionNote: buildResolutionNote(code, resolution) });
    }
    const { navaids, totalMatched } = svc.navaidsForAirport(ident, input.type, limit);
    ctx.enrich.total(totalMatched);
    // Truncation (≥ 1 shown) and the unserved notice are mutually exclusive, and
    // neither touches resolutionNote. The notice names the airport by ident only:
    // it rides in structuredContent unescaped, and get_airport returns the name.
    if (totalMatched > navaids.length) {
      ctx.enrich.truncated({
        shown: navaids.length,
        cap: limit,
        guidance: input.type
          ? `${ident} has ${totalMatched} associated navaids of type ${input.type}; raise \`limit\` (max 50) to see the rest.`
          : `${ident} has ${totalMatched} associated navaids; add a type filter or raise \`limit\` (max 50) to see the rest.`,
      });
    } else if (totalMatched === 0) {
      ctx.enrich.notice(
        `Airport ${ident} was found but has no associated navaids` +
          `${input.type ? ` of type ${input.type}` : ''} in the dataset. Many small fields have none; try coordinate mode around ${airport.latitudeDeg}, ${airport.longitudeDeg} to find nearby enroute navaids.`,
      );
    }
    return {
      mode: 'airport' as const,
      airportIdent: ident,
      navaids: navaids.map((n) => ({ ...toNavaid(n), distanceKm: null, bearingDeg: null })),
    };
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
