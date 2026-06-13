/**
 * @fileoverview Build-time data fetcher. Downloads the six OurAirports CSVs from
 * the daily-updated GitHub mirror and writes them into the package's `data/`
 * directory, which the server loads at setup(). Run this before `bun run build`
 * (and in the Docker build stage / weekly CI rebuild) so the image is
 * self-contained — the server never touches the network at runtime.
 *
 * The OurAirports data is dedicated to the public domain; bundling and
 * redistribution are unrestricted (attribution is a courtesy, see README).
 *
 * @example
 * // Fetch and bundle the latest CSVs:
 * // bun run scripts/build-data.ts
 *
 * // Verify already-bundled files without downloading:
 * // bun run scripts/build-data.ts --check
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function fetchFile(name: string): Promise<string> {
  const url = `${MIRROR_BASE}/${name}`;
  const res = await fetch(url, { headers: { 'user-agent': 'ourairports-mcp-server-build' } });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  // Guard against an HTML error page returned with HTTP 200.
  if (!HEADER_SNIFF.test(text)) {
    throw new Error(`Downloaded ${name} does not start with a CSV header row — refusing to write.`);
  }
  return text;
}

async function download(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  console.log(`Downloading ${FILES.length} OurAirports CSVs → ${DATA_DIR}`);

  const results = await Promise.all(
    FILES.map(async ({ name, minBytes }) => {
      const text = await fetchFile(name);
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes < minBytes) {
        throw new Error(
          `Downloaded ${name} is ${bytes} bytes, below the ${minBytes}-byte floor — likely truncated.`,
        );
      }
      await writeFile(join(DATA_DIR, name), text, 'utf-8');
      return { name, bytes };
    }),
  );

  for (const { name, bytes } of results) {
    console.log(`  ✓ ${name} (${(bytes / 1_048_576).toFixed(2)} MB)`);
  }
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
  console.log(`All ${FILES.length} data files present and above size floor.`);
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
