/**
 * @fileoverview Barrel collecting all tool definitions into the array consumed
 * by createApp().
 * @module src/mcp-server/tools/definitions/index
 */

import { findAirportsTool } from './find-airports.tool.js';
import { findNavaidsTool } from './find-navaids.tool.js';
import { getAirportTool } from './get-airport.tool.js';
import { listCountriesTool } from './list-countries.tool.js';
import { searchAirportsTool } from './search-airports.tool.js';
import { searchRunwaysTool } from './search-runways.tool.js';

export const allToolDefinitions = [
  searchAirportsTool,
  searchRunwaysTool,
  getAirportTool,
  findAirportsTool,
  findNavaidsTool,
  listCountriesTool,
];
