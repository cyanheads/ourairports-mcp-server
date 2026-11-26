/**
 * @fileoverview Build-time fetched data must preserve reachable facets and record
 * the mirror snapshot it came from before anything is written; `--check` refuses a
 * bundle without a valid snapshot record.
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const FLOORS: Record<string, number> = {
  'airports.csv': 8_000_000,
  'runways.csv': 2_000_000,
  'navaids.csv': 800_000,
  'airport-frequencies.csv': 700_000,
  'countries.csv': 10_000,
  'regions.csv': 200_000,
};
const VALID_CSV: Record<string, string> = {
  'countries.csv': 'id,code,name\n1,US,"United States, America"\n',
  'regions.csv': 'id,code,iso_country\n1,US-WA,US\n',
  'airports.csv': 'id,iso_country,iso_region\n1,US,US-WA\n',
};
/** One GitHub Pages deploy time, as every mirror file reports it. */
const LAST_MODIFIED = 'Wed, 25 Nov 2026 02:53:49 GMT';
const SNAPSHOT = {
  source: 'https://davidmegginson.github.io/ourairports-data/',
  sourceLastModified: '2026-11-25T02:53:49.000Z',
  fetchedAt: '2026-11-26T01:04:17.000Z',
};

/** Serve each mirror file at its size floor with a per-file Last-Modified header (null omits it). */
function stubMirror(
  files: Record<string, string> = VALID_CSV,
  lastModified: (name: string) => string | null = () => LAST_MODIFIED,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const name = url.split('/').at(-1)!;
      const header = lastModified(name);
      return new Response((files[name] ?? 'id,name\n').padEnd(FLOORS[name]!, '\n'), {
        headers: header === null ? {} : { 'last-modified': header },
      });
    }),
  );
}

/** Serve an already-bundled data/ directory to `--check`; `snapshot` null means absent. */
function stubBundle(snapshot: string | null): void {
  io.readdir.mockResolvedValue([
    ...Object.keys(FLOORS),
    ...(snapshot === null ? [] : ['snapshot.json']),
  ]);
  io.stat.mockImplementation(async (path: string) => ({
    size: FLOORS[path.split('/').at(-1)!] ?? 0,
  }));
  io.readFile.mockImplementation(async (path: string) => {
    const name = path.split('/').at(-1)!;
    if (name === 'snapshot.json') {
      if (snapshot === null)
        throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
      return snapshot;
    }
    return VALID_CSV[name] ?? '';
  });
}

/** Import the script (main() runs on import) and wait until it exits or reports completion. */
async function runBuildData(argv: string[] = []) {
  const fail = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  // A repeated spyOn returns the live spy; drop the previous run's calls.
  for (const spy of [fail, stderr, log]) spy.mockClear();
  process.argv.push(...argv);
  try {
    vi.resetModules();
    await import('../../scripts/build-data.js');
  } finally {
    process.argv.splice(process.argv.length - argv.length, argv.length);
  }
  const finished = () =>
    fail.mock.calls.length > 0 ||
    log.mock.calls.some(([line]) => /Data bundle written|data files present/.test(String(line)));
  // Wait in event-loop turns, not timer polls: vi.waitFor advances a faked Date.
  for (let turn = 0; turn < 10_000 && !finished(); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(finished()).toBe(true);
  return { fail, stderr: JSON.stringify(stderr.mock.calls) };
}

/** The snapshot record the fetch wrote, parsed. */
function writtenSnapshot(): unknown {
  const call = io.writeFile.mock.calls.find(([path]) => String(path).endsWith('/snapshot.json'));
  return call ? JSON.parse(String(call[1])) : undefined;
}

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
    stubMirror({ ...VALID_CSV, [file]: csv });
    const { fail, stderr } = await runBuildData();
    if (field === 'valid') {
      expect(fail).not.toHaveBeenCalled();
      expect(io.writeFile).toHaveBeenCalledTimes(7);
      expect(stderr).toBe('[]');
    } else {
      expect(fail).toHaveBeenCalledWith(1);
      expect(io.writeFile).not.toHaveBeenCalled();
      expect(stderr).toContain(field);
    }
  },
);

it('writes snapshot.json beside the CSVs from the mirror Last-Modified and the build clock', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SNAPSHOT.fetchedAt));
  stubMirror();
  const { fail } = await runBuildData();
  expect(fail).not.toHaveBeenCalled();
  expect(io.writeFile.mock.calls.map(([path]) => String(path).split('/').at(-1)).sort()).toEqual(
    [...Object.keys(FLOORS), 'snapshot.json'].sort(),
  );
  expect(writtenSnapshot()).toEqual(SNAPSHOT);
});

it('keeps sourceLastModified when unchanged data is rebuilt later; only fetchedAt moves', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  stubMirror();
  vi.setSystemTime(new Date('2026-11-26T01:04:17Z'));
  await runBuildData();
  const first = writtenSnapshot() as typeof SNAPSHOT;
  io.writeFile.mockClear();
  vi.setSystemTime(new Date('2026-11-27T09:30:00Z'));
  await runBuildData();
  const second = writtenSnapshot() as typeof SNAPSHOT;
  expect(second.sourceLastModified).toBe(first.sourceLastModified);
  expect(second.fetchedAt).toBe('2026-11-27T09:30:00.000Z');
  expect(second.fetchedAt).not.toBe(first.fetchedAt);
});

it.each([
  ['1 second', 'Wed, 25 Nov 2026 02:53:50 GMT', '2026-11-25T02:53:50.000Z'],
  ['10 minutes', 'Wed, 25 Nov 2026 03:03:49 GMT', '2026-11-25T03:03:49.000Z'],
])(
  'dates one deploy whose Last-Modified values span %s by the latest',
  async (_span, regions, expected) => {
    stubMirror(VALID_CSV, (name) => (name === 'regions.csv' ? regions : LAST_MODIFIED));
    const { fail, stderr } = await runBuildData();
    expect(fail).not.toHaveBeenCalled();
    expect(stderr).toBe('[]');
    expect((writtenSnapshot() as typeof SNAPSHOT).sourceLastModified).toBe(expected);
  },
);

it.each([
  ['lacks Last-Modified', (name: string) => (name === 'navaids.csv' ? null : LAST_MODIFIED)],
  [
    'disagrees on Last-Modified',
    (name: string) => (name === 'runways.csv' ? 'Thu, 26 Nov 2026 02:51:07 GMT' : LAST_MODIFIED),
  ],
  [
    'spans just over 10 minutes of Last-Modified',
    (name: string) => (name === 'airports.csv' ? 'Wed, 25 Nov 2026 03:03:50 GMT' : LAST_MODIFIED),
  ],
  [
    'sends an unparseable Last-Modified',
    (name: string) => (name === 'regions.csv' ? 'yesterday' : LAST_MODIFIED),
  ],
])('fails before writing any file when a response %s', async (_case, lastModified) => {
  stubMirror(VALID_CSV, lastModified);
  const { fail, stderr } = await runBuildData();
  expect(fail).toHaveBeenCalledWith(1);
  expect(io.writeFile).not.toHaveBeenCalled();
  expect(stderr).toContain('Last-Modified');
});

it('--check accepts a bundle with a valid snapshot.json', async () => {
  stubBundle(JSON.stringify(SNAPSHOT));
  const { fail, stderr } = await runBuildData(['--check']);
  expect(fail).not.toHaveBeenCalled();
  expect(stderr).toBe('[]');
});

// The malformed variants are tabled at readSnapshot (tests/services/snapshot.test.ts).
it.each([
  ['is missing', null, 'Missing snapshot.json'],
  [
    'has a non-ISO sourceLastModified',
    JSON.stringify({ ...SNAPSHOT, sourceLastModified: 'Wed, 25 Nov 2026 02:53:49 GMT' }),
    'snapshot.json is not a valid data snapshot record',
  ],
])('--check fails when snapshot.json %s, saying so', async (_case, snapshot, message) => {
  stubBundle(snapshot);
  const { fail, stderr } = await runBuildData(['--check']);
  expect(fail).toHaveBeenCalledWith(1);
  expect(stderr).toContain(message);
});

it.each([
  [
    'an HTTP error status',
    async () => new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }),
    'navaids.csv: HTTP 503',
  ],
  [
    'a network failure',
    async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    },
    'Failed to download https://davidmegginson.github.io/ourairports-data/navaids.csv',
  ],
])(
  'fails before writing any file, snapshot.json included, when one download meets %s',
  async (_case, failing, message) => {
    stubMirror();
    const mirror = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/navaids.csv') ? failing() : mirror(url))),
    );
    const { fail, stderr } = await runBuildData();
    expect(fail).toHaveBeenCalledWith(1);
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(stderr).toContain(message);
  },
);

// prepublishOnly runs `build:data --check` at publish time, so it must work offline.
it.each([
  ['a valid snapshot.json', JSON.stringify(SNAPSHOT), false],
  ['no snapshot.json', null, true],
])(
  '--check reads only the bundled files, never the network, with %s',
  async (_case, snapshot, fails) => {
    const fetchSpy = vi.fn(async (): Promise<Response> => {
      throw new Error('--check must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    stubBundle(snapshot);
    const { fail } = await runBuildData(['--check']);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (fails) expect(fail).toHaveBeenCalledWith(1);
    else expect(fail).not.toHaveBeenCalled();
  },
);
