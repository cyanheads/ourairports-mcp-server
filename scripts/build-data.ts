/**
 * @fileoverview Build-time data fetcher. Downloads the six OurAirports CSVs from
 * the daily-updated GitHub mirror and writes them into the package's `data/`
 * directory, which the server loads at setup(), together with `snapshot.json`:
 * the mirror's deploy time (`sourceLastModified`, which the server reports as
 * `dataAsOf`) and this fetch's build clock (`fetchedAt`). Run this before
 * `bun run build`; the Docker build stage runs it, so each image build bundles
 * the snapshot current at that moment, and the server never touches the network
 * at runtime.
 *
 * The OurAirports data is dedicated to the public domain; bundling and
 * redistribution are unrestricted (attribution is a courtesy, see README).
 *
 * @example
 * // Fetch and bundle the latest CSVs:
 * // bun run scripts/build-data.ts
 *
 * // Verify already-bundled files, snapshot.json included, without downloading
 * // (publishing runs this through prepublishOnly):
 * // bun run scripts/build-data.ts --check
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forEachRow, reqStr, str } from '../src/services/airport-data/csv.js';
import {
  COUNTRY_CODE_PATTERN,
  REGION_CODE_PATTERN,
} from '../src/services/airport-data/facet-codes.js';
import {
  readSnapshot,
  SNAPSHOT_FILE,
  type Snapshot,
} from '../src/services/airport-data/snapshot.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT_DIR, 'data');

/** The daily-updated mirror — the canonical bulk distribution (ourairports.com has no query API). */
const MIRROR_BASE = 'https://davidmegginson.github.io/ourairports-data';

/** The six files, with a sanity floor on expected size to catch a truncated/HTML download. */
const FILES: readonly { name: string; minBytes: number }[] = [
  { name: 'airports.csv', minBytes: 8_000_000 },
  { name: 'runways.csv', minBytes: 2_000_000 },
  { name: 'navaids.csv', minBytes: 800_000 },
  { name: 'airport-frequencies.csv', minBytes: 700_000 },
  { name: 'countries.csv', minBytes: 10_000 },
  { name: 'regions.csv', minBytes: 200_000 },
] as const;

const HEADER_SNIFF = /^(?:"?id"?,)/;

/** Refuse a bundle whose metadata or airport facets cannot be selected by callers. */
function validateFacets(files: ReadonlyMap<string, string>): void {
  const countries = new Set<string>();
  const regions = new Set<string>();
  const countryCode = (value: string, field: string): string => {
    const code = reqStr(value, field);
    if (!COUNTRY_CODE_PATTERN.test(code))
      throw new Error(`Invalid country code in ${field}: "${code}".`);
    return code.toUpperCase();
  };
  const regionCode = (value: string, field: string): string => {
    const code = reqStr(value, field);
    if (!REGION_CODE_PATTERN.test(code))
      throw new Error(`Invalid region code in ${field}: "${code}".`);
    return code.toUpperCase();
  };
  forEachRow(files.get('countries.csv') as string, (row) =>
    countries.add(countryCode(row.get('code'), 'countries.code')),
  );
  forEachRow(files.get('regions.csv') as string, (row) => {
    regions.add(regionCode(row.get('code'), 'regions.code'));
    const country = countryCode(row.get('iso_country'), 'regions.iso_country');
    if (!countries.has(country))
      throw new Error(`Unknown country reference in regions.iso_country: "${country}".`);
  });
  forEachRow(files.get('airports.csv') as string, (row) => {
    if (str(row.get('iso_country'))) {
      const country = countryCode(row.get('iso_country'), 'airports.iso_country');
      if (!countries.has(country))
        throw new Error(`Unknown country reference in airports.iso_country: "${country}".`);
    }
    if (str(row.get('iso_region'))) {
      const region = regionCode(row.get('iso_region'), 'airports.iso_region');
      if (!regions.has(region))
        throw new Error(`Unknown region reference in airports.iso_region: "${region}".`);
    }
  });
}

async function fetchFile(name: string): Promise<{ text: string; lastModified: string | null }> {
  const url = `${MIRROR_BASE}/${name}`;
  const res = await fetch(url, { headers: { 'user-agent': 'ourairports-mcp-server-build' } }).catch(
    (err: unknown) => {
      throw new Error(`Failed to download ${url}: the request did not complete.`, { cause: err });
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  // Guard against an HTML error page returned with HTTP 200.
  if (!HEADER_SNIFF.test(text)) {
    throw new Error(`Downloaded ${name} does not start with a CSV header row — refusing to write.`);
  }
  return { text, lastModified: res.headers.get('last-modified') };
}

/**
 * One mirror deploy stamps its six files within seconds of each other, and the
 * mirror deploys once a day, so values further apart than this mixed two deploys.
 */
const DEPLOY_WINDOW_MS = 10 * 60 * 1000;

/**
 * The mirror's deploy time as ISO 8601 UTC: the latest `Last-Modified` of the
 * six files. A missing or unparseable header means the bundle cannot be dated,
 * and values spanning more than `DEPLOY_WINDOW_MS` mean it mixes two deploys (a
 * CDN edge can serve a pre-deploy copy for minutes after one) — refuse either.
 */
function mirrorDeployTime(
  results: readonly { name: string; lastModified: string | null }[],
): string {
  const missing: string[] = [];
  const times: number[] = [];
  for (const { name, lastModified } of results) {
    if (lastModified === null) {
      missing.push(name);
      continue;
    }
    const time = Date.parse(lastModified);
    if (Number.isNaN(time)) {
      throw new Error(
        `Unparseable Last-Modified "${lastModified}" on ${name} — refusing to write.`,
      );
    }
    times.push(time);
  }
  if (missing.length > 0) {
    throw new Error(
      `No Last-Modified header on ${missing.join(', ')}, so the snapshot cannot be dated — refusing to write.`,
    );
  }
  const latest = Math.max(...times);
  if (latest - Math.min(...times) > DEPLOY_WINDOW_MS) {
    throw new Error(
      `The mirror files' Last-Modified values span more than ${DEPLOY_WINDOW_MS / 60_000} minutes (${results.map((r) => `${r.name}: ${r.lastModified}`).join('; ')}), so the fetch mixed two mirror deploys — refusing to write. Run build:data again.`,
    );
  }
  return new Date(latest).toISOString();
}

async function download(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  console.log(`Downloading ${FILES.length} OurAirports CSVs → ${DATA_DIR}`);

  const results = await Promise.all(
    FILES.map(async ({ name, minBytes }) => {
      const { text, lastModified } = await fetchFile(name);
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes < minBytes) {
        throw new Error(
          `Downloaded ${name} is ${bytes} bytes, below the ${minBytes}-byte floor — likely truncated.`,
        );
      }
      return { name, bytes, text, lastModified };
    }),
  );
  const snapshot: Snapshot = {
    source: `${MIRROR_BASE}/`,
    sourceLastModified: mirrorDeployTime(results),
    fetchedAt: new Date().toISOString(),
  };

  validateFacets(new Map(results.map(({ name, text }) => [name, text])));
  await Promise.all([
    ...results.map(({ name, text }) => writeFile(join(DATA_DIR, name), text, 'utf-8')),
    writeFile(join(DATA_DIR, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8'),
  ]);

  for (const { name, bytes } of results) {
    console.log(`  ✓ ${name} (${(bytes / 1_048_576).toFixed(2)} MB)`);
  }
  console.log(`  ✓ ${SNAPSHOT_FILE} (data as of ${snapshot.sourceLastModified})`);
  console.log('Data bundle written.');
}

async function check(): Promise<void> {
  let present: string[];
  try {
    present = await readdir(DATA_DIR);
  } catch {
    throw new Error(
      `Data directory ${DATA_DIR} does not exist. Run: bun run scripts/build-data.ts`,
    );
  }
  const missing: string[] = [];
  for (const { name, minBytes } of FILES) {
    if (!present.includes(name)) {
      missing.push(name);
      continue;
    }
    const s = await stat(join(DATA_DIR, name));
    if (s.size < minBytes) {
      throw new Error(`${name} is ${s.size} bytes, below the ${minBytes}-byte floor.`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing data files: ${missing.join(', ')}. Run: bun run scripts/build-data.ts`,
    );
  }
  validateFacets(
    new Map(
      await Promise.all(
        ['countries.csv', 'regions.csv', 'airports.csv'].map(
          async (name) => [name, await readFile(join(DATA_DIR, name), 'utf-8')] as const,
        ),
      ),
    ),
  );
  const snapshot = await readSnapshot(DATA_DIR);
  if (!snapshot) {
    throw new Error(
      `Missing ${SNAPSHOT_FILE} in ${DATA_DIR}, so the bundle cannot be dated. Run: bun run scripts/build-data.ts`,
    );
  }
  console.log(
    `All ${FILES.length} data files present and above size floor; data as of ${snapshot.sourceLastModified}.`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    await check();
  } else {
    await download();
  }
}

main().catch((err) => {
  console.error('build-data failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
