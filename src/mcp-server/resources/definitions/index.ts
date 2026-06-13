/**
 * @fileoverview Barrel collecting all resource definitions into the array
 * consumed by createApp().
 * @module src/mcp-server/resources/definitions/index
 */

import { airportResource } from './airport.resource.js';

export const allResourceDefinitions = [airportResource];
