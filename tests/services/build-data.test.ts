/**
 * @fileoverview Build-time fetched data must preserve reachable facets before writes.
 * @module tests/services/build-data.test
 */
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => io);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  ['countries.csv', 'id,code,name\n1,USA,Example\n', 'country'],
  ['regions.csv', 'id,code,iso_country\n1,US_WA,US\n', 'region'],
  ['regions.csv', 'id,code,iso_country\n1,US-WA,UK\n', 'country'],
  ['airports.csv', 'id,iso_country,iso_region\n1,UK,US-WA\n', 'country'],
  ['airports.csv', 'id,iso_country,iso_region\n1,US,US-ZZ\n', 'region'],
  ['airports.csv', 'id,iso_country,iso_region\n1,US,Washington\n', 'region'],
  [
    'airports.csv',
    'id,iso_country,iso_region,name\n1,US,US-WA,"An airport, with a\nquoted name"\n',
    'valid',
  ],
])(
  'rejects inaccessible %s metadata/references before writing any file',
  async (file, csv, field) => {
    const files: Record<string, string> = {
      'countries.csv': 'id,code,name\n1,US,"United States, America"\n',
      'regions.csv': 'id,code,iso_country\n1,US-WA,US\n',
      'airports.csv': 'id,iso_country,iso_region\n1,US,US-WA\n',
    };
    files[file] = csv;
    const floors: Record<string, number> = {
      'airports.csv': 8_000_000,
      'runways.csv': 2_000_000,
      'navaids.csv': 800_000,
      'airport-frequencies.csv': 700_000,
      'countries.csv': 10_000,
      'regions.csv': 200_000,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const name = url.split('/').at(-1)!;
        return new Response((files[name] ?? 'id,name\n').padEnd(floors[name]!, '\n'));
      }),
    );
    const fail = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    await import('../../scripts/build-data.js');
    await vi.waitFor(() =>
      expect(io.writeFile.mock.calls.length === 6 || fail.mock.calls.length > 0).toBe(true),
    );
    if (field === 'valid') {
      expect(fail).not.toHaveBeenCalled();
      expect(io.writeFile).toHaveBeenCalledTimes(6);
      expect(stderr).not.toHaveBeenCalled();
    } else {
      expect(fail).toHaveBeenCalledWith(1);
      expect(io.writeFile).not.toHaveBeenCalled();
      expect(JSON.stringify(stderr.mock.calls)).toContain(field);
    }
  },
);
