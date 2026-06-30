/**
 * @fileoverview ourairports_search_airports — the 80% entry point. Full-text
 * and faceted search over the bundled airport corpus by name, municipality,
 * country, region, or type. Returns ranked summaries with codes and coordinates
 * for chaining into ourairports_get_airport. Closed airports excluded by default.
 * @module src/mcp-server/tools/definitions/search-airports.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import { AirportSummarySchema, renderAirportLines, toAirportSummary } from './_schemas.js';

export const searchAirportsTool = tool('ourairports_search_airports', {
  title: 'ourairports-mcp-server',
  description:
    'Search the bundled OurAirports corpus by free-text (name / municipality / keywords) and/or facets (country, region, type). Every query token must match (word order and partial words are handled). Returns ranked airport summaries — operational and larger airports first — each with its full code set and coordinates, ready to chain into ourairports_get_airport. Closed airports are excluded unless include_closed is set. Use ourairports_list_countries for valid country/region codes. For "nearest airport to a coordinate" use ourairports_find_airports instead. OurAirports is community-edited — not authoritative for flight operations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search over airport name, municipality, and keywords. Tokens are AND-matched. Omit to browse purely by facets.',
      ),
    country: z
      .string()
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 country code filter (e.g. US). Exact match. Discover codes with ourairports_list_countries.',
      ),
    region: z
      .string()
      .optional()
      .describe('ISO 3166-2 region code filter (e.g. US-WA). Exact match.'),
    type: z
      .enum(AIRPORT_TYPES)
      .optional()
      .describe(
        'Restrict to one airport type: large_airport, medium_airport, small_airport, heliport, seaplane_base, balloonport, or closed.',
      ),
    include_closed: z
      .boolean()
      .default(false)
      .describe(
        'Include airports of type "closed". Off by default — closed airports pollute the live-flight grounding use case.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum airports to return (1–100). Defaults to OURAIRPORTS_DEFAULT_SEARCH_LIMIT (20).',
      ),
  }),

  output: z.object({
    airports: z
      .array(AirportSummarySchema)
      .describe('Matching airports, ranked best-first. Codes the airport lacks are null.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total airports matched before the limit was applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true only when more airports matched than were returned.'),
    shown: z
      .number()
      .optional()
      .describe('Number of airports returned. Present only when results were truncated.'),
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
    const limit = input.limit ?? getServerConfig().defaultSearchLimit;
    const result = svc.search({
      ...(input.query && { query: input.query }),
      ...(input.country && { country: input.country }),
      ...(input.region && { region: input.region }),
      ...(input.type && { type: input.type }),
      includeClosed: input.include_closed,
      limit,
    });

    ctx.enrich.total(result.totalMatched);
    const shown = result.airports.length;
    if (result.totalMatched > shown) {
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance:
          'Add or tighten filters (country, region, type) or raise `limit` (max 100) to see more.',
      });
    }

    if (result.noSearchableTerms) {
      ctx.enrich.notice(
        `The query "${input.query}" contains no searchable terms — only common words (the, of, and) or punctuation, which the index drops. ` +
          'Provide a distinctive word from the airport name or municipality, or omit query and filter by country/region/type.',
      );
    } else if (result.totalMatched === 0) {
      const facets = [
        input.country ? `country=${input.country}` : null,
        input.region ? `region=${input.region}` : null,
        input.type ? `type=${input.type}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      ctx.enrich.notice(
        `No airports matched${input.query ? ` "${input.query}"` : ''}${facets ? ` with ${facets}` : ''}. ` +
          'Broaden the query, relax facets, verify country/region codes with ourairports_list_countries, or set include_closed if you expect a closed field.',
      );
    }

    return {
      airports: result.airports.map((a) =>
        toAirportSummary(a, svc.country(a.isoCountry)?.name, svc.region(a.isoRegion)?.name),
      ),
    };
  },

  format: (result) => {
    const lines = [`## Airport Search — ${result.airports.length} shown`];
    for (const a of result.airports) {
      lines.push('');
      lines.push(...renderAirportLines(a));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
