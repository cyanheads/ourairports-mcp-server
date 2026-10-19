/**
 * @fileoverview Registered action and resource titles.
 * @module tests/integration/catalogue.int.test
 */
import { expect, it } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

it('exposes distinct human titles while preserving machine identifiers', () => {
  expect(Object.fromEntries(allToolDefinitions.map((d) => [d.name, d.title]))).toEqual({
    ourairports_search_airports: 'Search Airports',
    ourairports_search_runways: 'Search Runways',
    ourairports_get_airport: 'Get Airport',
    ourairports_find_airports: 'Find Airports',
    ourairports_find_navaids: 'Find Navaids',
    ourairports_list_countries: 'List Countries',
  });
  expect(allResourceDefinitions[0]).toMatchObject({
    name: 'airport-record',
    title: 'Airport Record',
    uriTemplate: 'airport://{code}',
  });
});
