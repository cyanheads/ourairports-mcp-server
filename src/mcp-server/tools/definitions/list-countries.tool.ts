/**
 * @fileoverview ourairports_list_countries — the lookup table for valid
 * country/region filter values used by ourairports_search_airports. Lists the
 * countries present in the bundled dataset with ISO codes and airport counts,
 * optionally filtered to a continent and optionally with regions nested.
 * @module src/mcp-server/tools/definitions/list-countries.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
import { CONTINENTS } from '@/services/airport-data/types.js';

const RegionSchema = z
  .object({
    code: z.string().describe('ISO 3166-2 region code (e.g. US-WA).'),
    name: z.string().describe('Region name.'),
    airportCount: z.number().describe('Number of non-closed airports in the region.'),
  })
  .describe('A region within a country, with its non-closed airport count.');

const CountrySchema = z
  .object({
    code: z
      .string()
      .describe(
        'ISO 3166-1 alpha-2 country code (the value to pass as `country` to ourairports_search_airports).',
      ),
    name: z.string().describe('Country name.'),
    continent: z
      .string()
      .nullable()
      .describe('Two-letter continent code (AF, AN, AS, EU, NA, OC, SA), or null.'),
    airportCount: z.number().describe('Number of non-closed airports in the country.'),
    regions: z
      .array(RegionSchema)
      .optional()
      .describe(
        'Regions within the country with airport counts. Present only when include_regions is true.',
      ),
  })
  .describe('A country present in the dataset, with its non-closed airport count and ISO code.');

export const listCountriesTool = tool('ourairports_list_countries', {
  title: 'ourairports-mcp-server',
  description:
    "List the countries present in the bundled OurAirports dataset with their ISO 3166-1 alpha-2 codes and airport counts. This is the lookup table for valid `country` (and, with include_regions, `region`) filter values used by ourairports_search_airports. Optionally restrict to a continent or nest each country's regions. Counts exclude closed airports.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    continent: z
      .enum(CONTINENTS)
      .optional()
      .describe(
        'Restrict to one continent: AF (Africa), AN (Antarctica), AS (Asia), EU (Europe), NA (North America), OC (Oceania), SA (South America).',
      ),
    include_regions: z
      .boolean()
      .default(false)
      .describe(
        "When true, nest each country's ISO 3166-2 regions (with airport counts) under it. Off by default to keep the response compact.",
      ),
  }),

  output: z.object({
    countries: z.array(CountrySchema).describe('Countries present in the dataset, sorted by name.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Number of countries returned.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when the continent filter matched no countries.'),
  },

  handler(input, ctx) {
    const countries = getAirportDataService().listCountries(input.continent, input.include_regions);
    ctx.enrich.total(countries.length);
    if (countries.length === 0) {
      ctx.enrich.notice(
        `No countries found for continent "${input.continent}". Call ourairports_list_countries without a continent filter to see all available continents and countries.`,
      );
    }
    return {
      countries: countries.map((c) => ({
        code: c.code,
        name: c.name,
        continent: c.continent ?? null,
        airportCount: c.airportCount,
        ...(c.regions && {
          regions: c.regions.map((r) => ({
            code: r.code,
            name: r.name,
            airportCount: r.airportCount,
          })),
        }),
      })),
    };
  },

  format: (result) => {
    const lines = [`## Countries (${result.countries.length})`];
    for (const c of result.countries) {
      lines.push(
        `- **${c.code}** ${c.name}${c.continent ? ` (${c.continent})` : ''} — ${c.airportCount} airports`,
      );
      if (c.regions) {
        for (const r of c.regions) {
          lines.push(`  - ${r.code} ${r.name} — ${r.airportCount} airports`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
