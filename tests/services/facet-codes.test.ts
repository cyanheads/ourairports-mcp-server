/**
 * @fileoverview Facet schema coverage and bounded CPU behavior on long caller strings.
 * @module tests/services/facet-codes.test
 */
import { expect, it } from 'vitest';
import { CountryCodeSchema, RegionCodeSchema } from '@/mcp-server/tools/definitions/_schemas.js';

it('keeps facet validation CPU bounded across full-span input doublings', () => {
  for (const schema of [CountryCodeSchema, RegionCodeSchema]) {
    const valid = schema === CountryCodeSchema ? 'US' : 'US-WA';
    for (const shape of ['padded', 'trailing-break', 'breaks-throughout'] as const) {
      const timings: number[] = [];
      for (let size = 1250; size <= 80_000; size *= 2) {
        const value =
          shape === 'padded'
            ? ' '.repeat(size) + valid
            : shape === 'trailing-break'
              ? `${'X'.repeat(size)}\n`
              : 'X\n'.repeat(size / 2);
        for (let warm = 0; warm < 100; warm++) schema.safeParse(value);
        const start = process.threadCpuUsage();
        for (let run = 0; run < 200; run++)
          expect(schema.safeParse(value).success).toBe(shape === 'padded');
        const cpu = process.threadCpuUsage(start);
        const elapsed = cpu.user + cpu.system;
        expect(elapsed).toBeLessThan(2_000_000);
        if (timings.length > 0)
          expect(elapsed / Math.max(1, timings.at(-1) as number)).toBeLessThan(256);
        timings.push(elapsed);
      }
      expect((timings.at(-1) as number) / Math.max(1, timings[0] as number)).toBeLessThan(256);
    }
  }
}, 30_000);
