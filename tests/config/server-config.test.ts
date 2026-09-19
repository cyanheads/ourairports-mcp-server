/**
 * @fileoverview Verifies optional environment values reach the server config
 * through the framework's normalization layer.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getServerConfig', () => {
  it.each(['', `\${user_config.OURAIRPORTS_DATA_DIR}`])(
    'treats %j as an unset optional data directory',
    async (value) => {
      vi.stubEnv('OURAIRPORTS_DATA_DIR', value);
      const { getServerConfig } = await import('@/config/server-config.js');

      expect(getServerConfig().dataDir).toBeUndefined();
    },
  );

  it('preserves an explicit data directory', async () => {
    vi.stubEnv('OURAIRPORTS_DATA_DIR', '/tmp/ourairports-data');
    const { getServerConfig } = await import('@/config/server-config.js');

    expect(getServerConfig().dataDir).toBe('/tmp/ourairports-data');
  });
});
