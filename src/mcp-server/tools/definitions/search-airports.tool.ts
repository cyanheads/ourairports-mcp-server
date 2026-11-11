/**
 * @fileoverview ourairports_search_airports — the 80% entry point. Full-text
 * and faceted search over the bundled airport corpus by name, municipality,
 * country, region, or type. Returns ranked summaries with codes and coordinates
 * for chaining into ourairports_get_airport. Closed airports excluded by default.
 * @module src/mcp-server/tools/definitions/search-airports.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { pageLimit } from '@/mcp-server/tools/page-limit.js';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { AIRPORT_TYPES } from '@/services/airport-data/types.js';
import {
  AirportSummarySchema,
  CountryCodeSchema,
  RegionCodeSchema,
  renderAirportLines,
  renderNotice,
  toAirportSummary,
} from './_schemas.js';

const airportPageLimit = pageLimit(100);

export const searchAirportsTool = tool('ourairports_search_airports', {
  title: 'Search Airports',
  description:
    'Search the bundled OurAirports corpus by exact airport code, free text (name, municipality, keywords), and/or facets (country, region, type). All query terms must match. Text supports forward prefixes and common abbreviations such as intl. Exact code matches lead code-only searches, followed by ranked summaries favoring operational and larger airports. Use ourairports_get_airport for full records by code, ourairports_list_countries for valid country and region codes, and ourairports_find_airports for nearest airports. OurAirports is community-edited — not authoritative for flight operations.',
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
    query: z
      .string()
      .optional()
      .describe(
        'Exact IATA, ICAO, GPS, local code or ident, or text from an airport name, municipality, or keywords. Omit to browse by facets.',
      ),
    country: CountryCodeSchema,
    region: RegionCodeSchema,
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
      .array(AirportSummarySchema)
      .describe('Matching airports, ranked best-first. Codes the airport lacks are null.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total matching airports before offset and limit.'),
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

  enrichmentTrailer: {
    notice: { render: renderNotice },
  },

  handler(input, ctx) {
    const svc = getAirportDataService();
    if (input.country && !svc.country(input.country))
      throw ctx.fail('unknown_country', `Unknown country code "${input.country}".`);
    if (input.region && !svc.region(input.region))
      throw ctx.fail('unknown_region', `Unknown region code "${input.region}".`);
    const { limit, notice: clampNotice } = airportPageLimit.resolve(input.limit, ctx);
    const result = svc.search({
      ...(input.query && { query: input.query }),
      ...(input.country && { country: input.country }),
      ...(input.region && { region: input.region }),
      ...(input.type && { type: input.type }),
      includeClosed: input.include_closed,
      limit,
      offset: input.offset,
    });

    ctx.enrich.total(result.totalMatched);
    const notices = clampNotice ? [clampNotice] : [];
    const shown = result.airports.length;
    const nextOffset = input.offset + shown;
    if (nextOffset < result.totalMatched) {
      ctx.enrich.truncated({ shown, cap: limit });
      ctx.enrich({ nextOffset });
      notices.push('Use nextOffset as offset with the same query to continue.');
    }
    if (result.noSearchableTerms) {
      notices.push(
        `The query "${input.query}" contains no searchable terms — only common words (the, of, and) or punctuation, which the index drops. Provide a distinctive word from the airport name or municipality, or omit query and filter by country/region/type.`,
      );
    } else if (result.totalMatched === 0) {
      const facets = [
        input.country ? `country=${input.country}` : null,
        input.region ? `region=${input.region}` : null,
        input.type ? `type=${input.type}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      notices.push(
        `No airports matched${input.query ? ` "${input.query}"` : ''}${facets ? ` with ${facets}` : ''}. Broaden the query, relax facets, verify country/region codes with ourairports_list_countries, or set include_closed if you expect a closed field.`,
      );
      if (input.query) notices.push('If you have an airport code, try ourairports_get_airport.');
    } else if (shown === 0) {
      notices.push(
        `Offset ${input.offset} is past the ${result.totalMatched} matching airports. Use a smaller offset to see results.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

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
