/**
 * @fileoverview Server-specific configuration for ourairports-mcp-server.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * storage, etc.) is handled by @cyanheads/mcp-ts-core.
 *
 * This server wraps no live API — the only knobs are the bundled-data directory
 * and the default result cap for the search/find tools.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  dataDir: z
    .string()
    .optional()
    .describe(
      'Directory holding the six OurAirports CSV files. Defaults to the bundled `data/` directory inside the package. Overridable to point at a fresher local data drop.',
    ),
  defaultSearchLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Default result cap for search/find tools when the caller omits `limit`.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  if (!_config) {
    _config = parseEnvConfig(ServerConfigSchema, {
      dataDir: 'OURAIRPORTS_DATA_DIR',
      defaultSearchLimit: 'OURAIRPORTS_DEFAULT_SEARCH_LIMIT',
    });
  }
  return _config;
}
