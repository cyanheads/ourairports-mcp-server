/**
 * @fileoverview Page-limit policy at the schema, disclosure, and telemetry seam.
 * @module tests/tools/page-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => ({ add }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('pageLimit', () => {
  it.each([50, 100])('clamps once and discloses the effective %i row ceiling', async (maximum) => {
    vi.stubEnv('OURAIRPORTS_CLAMP_LIMITS', 'true');
    const { pageLimit } = await import('@/mcp-server/tools/page-limit.js');
    const policy = pageLimit(maximum);
    const ctx = createMockContext();
    vi.spyOn(ctx.log, 'notice');
    const requested = maximum + 1;
    const parsed = policy.schema.parse(requested);
    expect(policy.resolve(parsed, ctx)).toEqual({
      limit: maximum,
      notice: `Requested limit ${requested} was clamped to ${maximum}.`,
    });
    expect(ctx.log.notice).toHaveBeenCalledExactlyOnceWith('Page limit clamped', {
      requested,
      limit: maximum,
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(1, { maximum });
    const json = z.toJSONSchema(policy.schema);
    expect(json.type).toBe('integer');
    expect(json).not.toHaveProperty('maximum');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '51'])(
    'rejects invalid limit %j',
    async (value) => {
      vi.stubEnv('OURAIRPORTS_CLAMP_LIMITS', 'true');
      const { pageLimit } = await import('@/mcp-server/tools/page-limit.js');
      expect(pageLimit(50).schema.safeParse(value).success).toBe(false);
    },
  );

  it('advertises and enforces strict mode', async () => {
    vi.stubEnv('OURAIRPORTS_CLAMP_LIMITS', 'false');
    const { pageLimit } = await import('@/mcp-server/tools/page-limit.js');
    const policy = pageLimit(50);
    expect(policy.schema.safeParse(51).success).toBe(false);
    expect(policy.schema.parse(50)).toBe(50);
    expect(z.toJSONSchema(policy.schema)).toMatchObject({ type: 'integer', maximum: 50 });
    expect(add).not.toHaveBeenCalled();
  });

  it('retains omission behavior without treating the configured default as a caller clamp', async () => {
    vi.stubEnv('OURAIRPORTS_DEFAULT_SEARCH_LIMIT', '75');
    const { pageLimit } = await import('@/mcp-server/tools/page-limit.js');
    const ctx = createMockContext();
    vi.spyOn(ctx.log, 'notice');
    expect(pageLimit(50).resolve(undefined, ctx)).toEqual({ limit: 50 });
    expect(pageLimit(100).resolve(undefined, ctx)).toEqual({ limit: 75 });
    expect(pageLimit(50).resolve(2, ctx)).toEqual({ limit: 2 });
    expect(ctx.log.notice).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
