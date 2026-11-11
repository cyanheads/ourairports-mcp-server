/**
 * @fileoverview Shared page-limit validation, disclosure, and telemetry.
 * @module src/mcp-server/tools/page-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const clamps = createCounter(
  'ourairports.limit.clamped',
  'Explicit tool limits clamped to the page ceiling',
);

/** Keeps tools/list and request validation aligned with the deployment's limit policy. */
export function pageLimit(maximum: number) {
  return {
    schema: z
      .number()
      .int()
      .min(1)
      .check((ctx) => {
        if (!getServerConfig().clampLimits && ctx.value > maximum) {
          ctx.issues.push({
            code: 'too_big',
            origin: 'number',
            maximum,
            inclusive: true,
            input: ctx.value,
          });
        }
      })
      .meta({
        get maximum() {
          return getServerConfig().clampLimits ? undefined : maximum;
        },
      })
      .optional()
      .describe(
        `Maximum rows to return. Defaults to OURAIRPORTS_DEFAULT_SEARCH_LIMIT (20), up to ${maximum}. Larger positive integers clamp to ${maximum} with a notice; OURAIRPORTS_CLAMP_LIMITS=false restores strict rejection.`,
      ),

    resolve(
      requested: number | undefined,
      ctx: Pick<Context, 'log'>,
    ): { limit: number; notice?: string } {
      const limit = Math.min(requested ?? getServerConfig().defaultSearchLimit, maximum);
      if (requested !== undefined && requested > maximum) {
        ctx.log.notice('Page limit clamped', { requested, limit });
        clamps.add(1, { maximum });
        return { limit, notice: `Requested limit ${requested} was clamped to ${maximum}.` };
      }
      return { limit };
    },
  };
}
