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
  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['false', false],
  ])('parses clamp policy %j as %j', async (value, expected) => {
    vi.stubEnv('OURAIRPORTS_CLAMP_LIMITS', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().clampLimits).toBe(expected);
  });

  it('rejects an invalid clamp policy with the env name', async () => {
    vi.stubEnv('OURAIRPORTS_CLAMP_LIMITS', 'sometimes');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow('OURAIRPORTS_CLAMP_LIMITS');
  });

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
