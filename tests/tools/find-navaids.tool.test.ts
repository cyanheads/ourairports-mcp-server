/**
 * @fileoverview Tests for ourairports_find_navaids — the two-mode contract
 * (coordinate vs airport, exactly one), kHz frequency surfacing with MHz only
 * for VHF-bearing types, the service-volume fields, pre-limit totals and
 * truncation disclosure, the found-but-unserved notice, the shared-code
 * resolution note in airport mode, escaped text / exact positions in
 * content[], and the unknown_code error.
 * @module tests/tools/find-navaids.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

// Controllable OURAIRPORTS_DEFAULT_SEARCH_LIMIT for the #4 clamp test.
const cfg = vi.hoisted(() => ({ defaultSearchLimit: 20 }));
vi.mock('@/config/server-config.js', async (orig) => {
  const actual = await orig<typeof import('@/config/server-config.js')>();
  return {
    ...actual,
    getServerConfig: () => ({ dataDir: undefined, defaultSearchLimit: cfg.defaultSearchLimit }),
  };
});

const { findNavaidsTool } = await import('@/mcp-server/tools/definitions/find-navaids.tool.js');

/** Context wired with the tool's error contract so ctx.fail is typed/available. */
const ctxWithContract = () => createMockContext({ errors: findNavaidsTool.errors });

describe('findNavaidsTool', () => {
  it('coordinate mode: nearest-first with distance', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({
        latitude: 47.45,
        longitude: -122.31,
        radius_km: 200,
      }),
      ctx,
    );
    expect(result.mode).toBe('coordinate');
    expect(result.airportIdent).toBeNull();
    expect(result.navaids[0]?.ident).toBe('SEA');
    expect(result.navaids[0]?.distanceKm).not.toBeNull();
  });

  it('airport mode: navaids serving the airport, in kHz and MHz', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: 'KSEA' }),
      ctx,
    );
    expect(result.mode).toBe('airport');
    expect(result.airportIdent).toBe('KSEA');
    expect(result.navaids).toHaveLength(1);
    expect(result.navaids[0]?.frequencyKhz).toBe(116800);
    expect(result.navaids[0]?.frequencyMhz).toBeCloseTo(116.8, 3);
    expect(result.navaids[0]?.distanceKm).toBeNull();
  });

  it('airport mode: empty list + notice when airport has no navaids', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: '00AA' }),
      ctx,
    );
    expect(result.navaids).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/no associated navaids/);
  });

  // #6: the airport-mode miss now throws via ctx.fail('unknown_code', …) at the
  // tool boundary, so the declared recovery hint reaches data.recovery.hint
  // (previously the service threw notFound() and bypassed ctx.recoveryFor).
  it('throws unknown_code with the declared recovery hint for an unknown airport code', () => {
    const ctx = ctxWithContract();
    let thrown: unknown;
    try {
      findNavaidsTool.handler(findNavaidsTool.input.parse({ airport_code: 'ZZZZZZ' }), ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const err = thrown as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    const data = err.data as { reason?: string; code?: string; recovery?: { hint?: string } };
    expect(data.reason).toBe('unknown_code');
    expect(data.code).toBe('ZZZZZZ');
    expect(data.recovery?.hint).toMatch(/ourairports_search_airports|ourairports_get_airport/);
  });

  it('throws mode_conflict when both modes supplied', () => {
    const ctx = ctxWithContract();
    expect(() =>
      findNavaidsTool.handler(
        findNavaidsTool.input.parse({ latitude: 47, longitude: -122, airport_code: 'KSEA' }),
        ctx,
      ),
    ).toThrow();
  });

  it('throws mode_conflict when neither mode supplied', () => {
    const ctx = ctxWithContract();
    expect(() => findNavaidsTool.handler(findNavaidsTool.input.parse({}), ctx)).toThrow();
  });

  it('throws mode_conflict for a lone latitude (partial coordinate)', () => {
    const ctx = ctxWithContract();
    expect(() =>
      findNavaidsTool.handler(findNavaidsTool.input.parse({ latitude: 47 }), ctx),
    ).toThrow();
  });

  // #7: airport_code is trimmed before lookup; a padded code selects airport mode.
  it('resolves a padded airport_code by trimming ("  KSEA  ")', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({ airport_code: '  KSEA  ' }),
      ctx,
    );
    expect(result.mode).toBe('airport');
    expect(result.airportIdent).toBe('KSEA');
  });

  // #7: whitespace-only airport_code is now a schema validation failure — it no
  // longer falls through to mode_conflict.
  it('rejects a whitespace-only airport_code at schema validation, not as mode_conflict', () => {
    expect(() => findNavaidsTool.input.parse({ airport_code: '   ' })).toThrow();
  });

  it('filters by navaid type in coordinate mode', async () => {
    const ctx = ctxWithContract();
    const result = await findNavaidsTool.handler(
      findNavaidsTool.input.parse({
        latitude: 40.633,
        longitude: -73.778,
        radius_km: 100,
        type: 'NDB',
      }),
      ctx,
    );
    expect(result.navaids.every((n) => n.type === 'NDB')).toBe(true);
  });

  // Regression for #4: the config-derived default is clamped to the tool's own
  // max of 50 (the config ceiling is 100), aligning with find_airports.
  it('clamps a configured default above the tool max down to 50', async () => {
    cfg.defaultSearchLimit = 80;
    const spy = vi.spyOn(svc, 'nearbyNavaids');
    await findNavaidsTool.handler(
      findNavaidsTool.input.parse({
        latitude: 47.45,
        longitude: -122.31,
        radius_km: 200,
      }),
      ctxWithContract(),
    );
    expect(spy.mock.calls[0]?.[3]).toBe(50); // 4th positional arg is limit
    spy.mockRestore();
    cfg.defaultSearchLimit = 20;
  });
});

describe('findNavaidsTool ranking and association order (characterization)', () => {
  const run = (input: Record<string, unknown>) =>
    findNavaidsTool.handler(findNavaidsTool.input.parse(input), ctxWithContract());

  it('coordinate mode ranks nearest-first with rounded distance, bearing, and stored kHz', async () => {
    const result = await run({ latitude: 40.6413, longitude: -73.7781, radius_km: 60, limit: 50 });
    expect(
      result.navaids.map((n) => [n.ident, n.type, n.distanceKm, n.bearingDeg, n.frequencyKhz]),
    ).toEqual([
      ['JFK', 'NDB', 0.92, 179.5, 353],
      ['CRI', 'VOR-DME', 10.32, 252, 112300],
      ['OGY', 'NDB', 12.03, 227.4, 414],
      ['LG', 'NDB', 15.14, 302.6, 332],
    ]);
  });

  it('coordinate mode type filter keeps only that type', async () => {
    const result = await run({
      latitude: 40.6413,
      longitude: -73.7781,
      radius_km: 60,
      type: 'VOR-DME',
    });
    expect(result.navaids.map((n) => n.ident)).toEqual(['CRI']);
  });

  it('airport mode returns navaids in association (dataset) order', async () => {
    const result = await run({ airport_code: 'KJFK', limit: 50 });
    expect(result.navaids.map((n) => n.ident)).toEqual(['JFK', 'CRI']);
    expect(result.navaids.every((n) => n.distanceKm === null && n.bearingDeg === null)).toBe(true);
  });

  it('passes an explicit caller limit through to the service unchanged', async () => {
    const spy = vi.spyOn(svc, 'navaidsForAirport');
    await run({ airport_code: 'KJFK', limit: 7 });
    expect(spy.mock.calls[0]?.[2]).toBe(7); // 3rd positional arg is limit
    spy.mockRestore();
  });
});

describe('findNavaidsTool content and shared-code disclosure', () => {
  /** Run through the public contract so content[] includes the enrichment trailer. */
  async function call(input: z.input<typeof findNavaidsTool.input>) {
    const result = await runToolContract(findNavaidsTool, input);
    expect(result.isError).toBeFalsy();
    const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
    const structured = result.structuredContent as Awaited<
      ReturnType<typeof findNavaidsTool.handler>
    > & {
      totalCount: number;
      truncated?: boolean;
      notice?: string;
      resolutionNote?: string;
    };
    return { text, structured };
  }

  it('renders plain navaid lines byte-identically (airport mode, KSEA)', async () => {
    const { text } = await call({ airport_code: 'KSEA' });
    expect(text).toContain(
      [
        '## Navaids — 1 shown',
        '**Mode:** airport | **Airport:** KSEA',
        '',
        '**SEA — SEATTLE** [VORTAC] (id 87123)',
        '**Frequency:** 116800 kHz (paired VHF 116.8 MHz)',
        '**Usage:** BOTH | **Power:** HIGH | **Magnetic variation:** 16.123° actual, 18.5° slaved',
        '**Position:** 47.435372, -122.309608 · elevation 425 ft',
        '**Distance:** — km at —°',
        '**DME channel:** 115X · paired VHF 116800 kHz | **Serves:** KSEA | **Country:** US',
      ].join('\n'),
    );
  });

  it('adds no resolution note for an airport_code on one airport (KSEA)', async () => {
    const { structured } = await call({ airport_code: 'KSEA' });
    expect(Object.keys(structured).sort()).toEqual([
      'airportIdent',
      'mode',
      'navaids',
      'totalCount',
    ]);
  });

  it('renders positions as the exact structuredContent numbers', async () => {
    const { text, structured } = await call({
      latitude: 47.45,
      longitude: -122.31,
      radius_km: 200,
    });
    expect(structured.navaids[0]?.latitudeDeg).toBe(47.435372);
    for (const n of structured.navaids) {
      expect(text).toContain(`**Position:** ${n.latitudeDeg}, ${n.longitudeDeg} ·`);
    }
    expect(text).toContain('**Position:** 47.435372, -122.309608 · elevation 425 ft');
  });

  it('escapes Markdown in the ident while structuredContent keeps the raw value (Wau_NDB_)', async () => {
    const { text, structured } = await call({ latitude: 7.72, longitude: 27.97, radius_km: 10 });
    expect(structured.navaids[0]?.ident).toBe('Wau_NDB_');
    expect(text).toContain('**Wau_NDB\\_ — Wau** [NDB] (id 95519)');
    expect(text).toContain('**Position:** 7.723020076751709, 27.976499557495117 · elevation — ft');
    expect(text).toContain(
      '**DME channel:** — · paired VHF — kHz | **Serves:** HSWW | **Country:** SS',
    );
  });

  it('discloses the shared-code note in airport mode (GIG names SBGL), alongside the unserved notice', async () => {
    const { text, structured } = await call({ airport_code: 'GIG' });
    expect(structured.airportIdent).toBe('GIG');
    expect(structured.navaids).toEqual([]);
    expect(structured.resolutionNote).toBe(
      'Resolved via ident. "GIG" is also a code of 1 other airport: SBGL (BR, iata_code). ident outranks iata_code (resolution priority: ident, icao_code, iata_code, gps_code, local_code). To fetch that airport, pass its ident.',
    );
    expect(structured.notice).toMatch(/was found but has no associated navaids/);
    expect(text).toContain(`**Resolution:** ${structured.resolutionNote}`);
    expect(text).toMatch(/> Airport GIG was found but has no associated navaids/);
    expect(structured.notice).not.toContain('Black Diamond');
    expect(structured.truncated).toBeUndefined();
  });

  it('uses the same note builder as get_airport (HBI tie)', async () => {
    const { structured } = await call({ airport_code: 'hbi' });
    expect(structured.airportIdent).toBe('AR-0572');
    expect(structured.resolutionNote).toContain('dataset row order selected this one');
    expect(structured.resolutionNote).toContain('AYHH (PG, local_code), KHBI (US, local_code)');
  });
});

type NavaidStructured = Awaited<ReturnType<typeof findNavaidsTool.handler>> & {
  totalCount: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  notice?: string;
  resolutionNote?: string;
};

/** Run through the public contract so content[] includes the enrichment trailer. */
async function callNavaids(input: z.input<typeof findNavaidsTool.input>) {
  const result = await runToolContract(findNavaidsTool, input);
  expect(result.isError).toBeFalsy();
  const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  return { text, structured: result.structuredContent as NavaidStructured };
}

const JFK_POINT = { latitude: 40.6413, longitude: -73.7781, radius_km: 60 };

describe('findNavaidsTool pre-limit totals and truncation disclosure (#11)', () => {
  it('coordinate mode: counts every in-radius navaid before the limit and discloses the cap', async () => {
    const { text, structured } = await callNavaids({ ...JFK_POINT, limit: 1 });
    expect(structured.navaids.map((n) => n.ident)).toEqual(['JFK']);
    expect(structured.totalCount).toBe(4);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(1);
    expect(structured.cap).toBe(1);
    expect(structured.notice).toBe(
      'Results are nearest-first, so the omitted navaids lie farther out. Narrow radius_km, add a type filter, or raise `limit` (max 50) to see more.',
    );
    expect(text).toContain('**4 total**');
    expect(text).toContain('**truncated:** true');
    expect(text).toContain('**cap:** 1');
  });

  it('headings present the returned count as shown, not as a total', async () => {
    const { text } = await callNavaids({ ...JFK_POINT, limit: 1 });
    expect(text).toContain('## Navaids — 1 shown');
    expect(text).not.toMatch(/## Navaids \(\d+\)/);
  });

  it('coordinate mode: with type set, totalCount counts only that type', async () => {
    const { structured } = await callNavaids({ ...JFK_POINT, type: 'NDB', limit: 1 });
    expect(structured.totalCount).toBe(3);
    expect(structured.truncated).toBe(true);
    expect(structured.navaids.every((n) => n.type === 'NDB')).toBe(true);
  });

  it('coordinate mode: no truncation fields when the limit equals the match count', async () => {
    const { text, structured } = await callNavaids({ ...JFK_POINT, limit: 4 });
    expect(structured.navaids).toHaveLength(4);
    expect(Object.keys(structured).sort()).toEqual([
      'airportIdent',
      'mode',
      'navaids',
      'totalCount',
    ]);
    expect(structured.totalCount).toBe(4);
    expect(text).not.toContain('truncated');
  });

  it('coordinate mode: zero matches keep the empty notice with no truncation fields', async () => {
    const { structured } = await callNavaids({ latitude: 0, longitude: 0, radius_km: 10 });
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toBe(
      'No navaids within 10 km of 0, 0. Widen radius_km (max 500) and retry.',
    );
    expect(structured.truncated).toBeUndefined();
    expect(structured.shown).toBeUndefined();
  });

  it('airport mode: KJFK limit 1 reports totalCount 2 and truncation', async () => {
    const { text, structured } = await callNavaids({ airport_code: 'KJFK', limit: 1 });
    expect(structured.navaids.map((n) => n.ident)).toEqual(['JFK']);
    expect(structured.totalCount).toBe(2);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(1);
    expect(structured.cap).toBe(1);
    expect(structured.notice).toBe(
      'KJFK has 2 associated navaids; add a type filter or raise `limit` (max 50) to see the rest.',
    );
    expect(structured.resolutionNote).toBeUndefined();
    expect(text).toContain('**2 total**');
  });

  it('airport mode: counts only the requested type', async () => {
    const { structured } = await callNavaids({ airport_code: 'KJFK', type: 'NDB', limit: 1 });
    expect(structured.totalCount).toBe(1);
    expect(structured.truncated).toBeUndefined();
  });

  it('airport mode: no truncation fields when the limit equals the association count', async () => {
    const { structured } = await callNavaids({ airport_code: 'KJFK', limit: 2 });
    expect(structured.totalCount).toBe(2);
    expect(Object.keys(structured).sort()).toEqual([
      'airportIdent',
      'mode',
      'navaids',
      'totalCount',
    ]);
  });

  it('airport mode: a shared code keeps its resolutionNote alongside truncation (LEN)', async () => {
    const { text, structured } = await callNavaids({ airport_code: 'LEN', limit: 1 });
    expect(structured.airportIdent).toBe('LELN');
    expect(structured.totalCount).toBe(2);
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toMatch(/^LELN has 2 associated navaids/);
    expect(structured.resolutionNote).toBe(
      'Resolved via iata_code. "LEN" is also a code of 1 other airport: AR-0062 (AR, local_code). iata_code outranks local_code (resolution priority: ident, icao_code, iata_code, gps_code, local_code). To fetch that airport, pass its ident.',
    );
    expect(text).toContain(`**Resolution:** ${structured.resolutionNote}`);
    expect(text).toContain(`> ${structured.notice}`);
  });

  it('airport mode: a shared code with every navaid shown carries the note and no notice', async () => {
    const { structured } = await callNavaids({ airport_code: 'LEN', limit: 50 });
    expect(structured.totalCount).toBe(2);
    expect(structured.resolutionNote).toMatch(/^Resolved via iata_code\./);
    expect(structured.notice).toBeUndefined();
    expect(structured.truncated).toBeUndefined();
  });

  it('declares the truncation fields on the effective output schema', () => {
    const parsed = findNavaidsTool.output.extend(findNavaidsTool.enrichment!).parse({
      mode: 'airport',
      airportIdent: 'KJFK',
      navaids: [],
      totalCount: 2,
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(parsed).toMatchObject({ totalCount: 2, truncated: true, shown: 1, cap: 1 });
  });
});

describe('findNavaidsTool unserved-airport notice (upstream name dropped)', () => {
  it('names the airport by ident only, in both surfaces', async () => {
    const { text, structured } = await callNavaids({ airport_code: '00AA' });
    expect(structured.notice).toBe(
      'Airport 00AA was found but has no associated navaids in the dataset. Many small fields have none; try coordinate mode around 38.704022, -101.473911 to find nearby enroute navaids.',
    );
    expect(structured.notice).not.toContain('Aero B Ranch');
    expect(text).not.toContain('Aero B Ranch');
    expect(structured.totalCount).toBe(0);
    expect(structured.truncated).toBeUndefined();
  });

  it('keeps the type qualifier when a type filter empties the list', async () => {
    const { structured } = await callNavaids({ airport_code: 'KSEA', type: 'NDB' });
    expect(structured.notice).toMatch(
      /^Airport KSEA was found but has no associated navaids of type NDB in the dataset\./,
    );
  });
});

/** The navaid with `ident` from a coordinate-mode call around its own position. */
async function navaidNear(ident: string, latitude: number, longitude: number) {
  const { text, structured } = await callNavaids({ latitude, longitude, radius_km: 5, limit: 50 });
  const navaid = structured.navaids.find((n) => n.ident === ident);
  expect(navaid).toBeDefined();
  return { text, navaid: navaid as NavaidStructured['navaids'][number] };
}

describe('findNavaidsTool MHz only where the type has a VHF frequency (#14)', () => {
  it('NDB (OGY): kHz kept, MHz null, no MHz figure in the text', async () => {
    const { text, navaid } = await navaidNear('OGY', 40.56809997558594, -73.88300323486328);
    expect(navaid.frequencyKhz).toBe(414);
    expect(navaid.frequencyMhz).toBeNull();
    expect(text).toContain('**Frequency:** 414 kHz\n');
    expect(text).not.toContain('0.414');
  });

  it('NDB-DME (2J): kHz kept, MHz null, no MHz figure in the text', async () => {
    const { text, navaid } = await navaidNear('2J', 49.01750183105469, -118.42400360107422);
    expect(navaid.type).toBe('NDB-DME');
    expect(navaid.frequencyKhz).toBe(250);
    expect(navaid.frequencyMhz).toBeNull();
    expect(text).toContain('**Frequency:** 250 kHz\n');
    expect(text).not.toContain('0.25 MHz');
  });

  it('VOR-DME (CH, serves NZCH): 115300 kHz / 115.3 MHz', async () => {
    const { text, navaid } = await navaidNear('CH', -43.50410079956055, 172.51499938964844);
    expect(navaid.frequencyKhz).toBe(115300);
    expect(navaid.frequencyMhz).toBe(115.3);
    expect(text).toContain('**Frequency:** 115300 kHz (115.3 MHz)');
  });

  it('VORTAC (SEA): 116800 kHz / 116.8 MHz, labeled as the paired VHF frequency', async () => {
    const { text, structured } = await callNavaids({ airport_code: 'KSEA' });
    expect(structured.navaids[0]?.frequencyKhz).toBe(116800);
    expect(structured.navaids[0]?.frequencyMhz).toBe(116.8);
    expect(text).toContain('**Frequency:** 116800 kHz (paired VHF 116.8 MHz)');
  });

  it('TACAN above 118 MHz (LSV, 12X) keeps its paired VHF MHz', async () => {
    const { text, navaid } = await navaidNear('LSV', 36.24470138549805, -115.0250015258789);
    expect(navaid.frequencyKhz).toBe(135500);
    expect(navaid.frequencyMhz).toBe(135.5);
    expect(text).toContain('**Frequency:** 135500 kHz (paired VHF 135.5 MHz)');
  });

  it('DME (HND) keeps its paired VHF MHz populated', async () => {
    const { navaid } = await navaidNear('HND', -9.428, 160.055);
    expect(navaid.frequencyMhz).toBe(109.3);
  });

  it('non-positive placeholders are unknown: both fields null (BIK NDB beside the BIK VOR-DME)', async () => {
    const { text, structured } = await callNavaids({
      latitude: -34.18,
      longitude: 150.1,
      radius_km: 30,
    });
    const byType = Object.fromEntries(structured.navaids.map((n) => [n.type, n]));
    expect(byType.NDB).toMatchObject({ ident: 'BIK', frequencyKhz: null, frequencyMhz: null });
    expect(byType['VOR-DME']).toMatchObject({
      ident: 'BIK',
      frequencyKhz: 116800,
      frequencyMhz: 116.8,
    });
    expect(text).toContain('**Frequency:** —\n');
    expect(text).not.toContain('-1 kHz');
    expect(text).not.toContain('-0.001');
  });

  it('a VOR placeholder (MQD) is nulled too, not surfaced as -0.001 MHz', async () => {
    const { navaid } = await navaidNear('MQD', -33.108299255371, 151.13900756836);
    expect(navaid.frequencyKhz).toBeNull();
    expect(navaid.frequencyMhz).toBeNull();
  });

  it('airport mode applies the same rule (LELN: VOR-DME populated, NDB null)', async () => {
    const { structured } = await callNavaids({ airport_code: 'LELN' });
    const [eon, len] = structured.navaids;
    expect(eon).toMatchObject({ ident: 'EON', frequencyKhz: 112000, frequencyMhz: 112 });
    expect(len).toMatchObject({ ident: 'LEN', frequencyKhz: 330, frequencyMhz: null });
  });
});

describe('findNavaidsTool service-volume metadata (#18)', () => {
  it('exposes usage, power, both variations, and the DME paired frequency (SEA VORTAC)', async () => {
    const { text, structured } = await callNavaids({ airport_code: 'KSEA' });
    expect(structured.navaids[0]).toMatchObject({
      usageType: 'BOTH',
      power: 'HIGH',
      magneticVariationDeg: 16.123,
      slavedVariationDeg: 18.5,
      dmeFrequencyKhz: 116800,
    });
    expect(text).toContain(
      '**Usage:** BOTH | **Power:** HIGH | **Magnetic variation:** 16.123° actual, 18.5° slaved',
    );
    expect(text).toContain(
      '**DME channel:** 115X · paired VHF 116800 kHz | **Serves:** KSEA | **Country:** US',
    );
  });

  it('maps empty cells to null (NDLS VOR: no DME, no slaved variation)', async () => {
    const { text, navaid } = await navaidNear('NDLS', 40.0, -160.0);
    expect(navaid).toMatchObject({
      usageType: 'LO',
      power: 'HIGH',
      magneticVariationDeg: 16,
      slavedVariationDeg: null,
      dmeFrequencyKhz: null,
    });
    expect(text).toContain(
      '**Usage:** LO | **Power:** HIGH | **Magnetic variation:** 16° actual, —° slaved',
    );
    expect(text).toContain('**DME channel:** — · paired VHF — kHz');
  });

  it('empty usage and power cells become null, never ""', async () => {
    const { text, navaid } = await navaidNear('AZW', 36.38100051879883, -80.54019927978516);
    expect(navaid.usageType).toBeNull();
    expect(navaid.power).toBeNull();
    expect(text).toContain('**Usage:** — | **Power:** —');
  });

  it('keeps a stored 0 variation as 0 (VE actual, RDG slaved)', async () => {
    const ve = await navaidNear('VE', 44.8489990234375, 4.95550012588501);
    expect(ve.navaid.magneticVariationDeg).toBe(0);
    expect(ve.text).toContain('**Magnetic variation:** 0° actual');
    const rdg = await navaidNear('RDG', 49.040298461899994, 12.5264997482);
    expect(rdg.navaid.slavedVariationDeg).toBe(0);
    expect(rdg.navaid.magneticVariationDeg).toBe(1.5);
  });

  it('passes TERMINAL and UNKNOWN through unmapped', async () => {
    const cri = await navaidNear('CRI', 40.61249923706055, -73.89440155029297);
    expect(cri.navaid.usageType).toBe('TERMINAL');
    const ant = await navaidNear('ANT', 36.8755989074707, 30.789199829101562);
    expect(ant.navaid.power).toBe('UNKNOWN');
  });

  it('NDB-DME carries its DME paired VHF frequency while frequencyMhz is null', async () => {
    const { navaid } = await navaidNear('2J', 49.01750183105469, -118.42400360107422);
    expect(navaid.dmeFrequencyKhz).toBe(109700);
    expect(navaid.frequencyMhz).toBeNull();
  });

  it('coordinate and airport modes return identical navaid fields', async () => {
    const airport = await callNavaids({ airport_code: 'KJFK' });
    const coord = await navaidNear('CRI', 40.61249923706055, -73.89440155029297);
    const fromAirport = airport.structured.navaids.find((n) => n.ident === 'CRI');
    const strip = ({ distanceKm: _d, bearingDeg: _b, ...rest }: Record<string, unknown>) => rest;
    expect(strip(fromAirport as Record<string, unknown>)).toEqual(
      strip(coord.navaid as Record<string, unknown>),
    );
    expect(Object.keys(fromAirport ?? {}).sort()).toEqual(Object.keys(coord.navaid).sort());
  });

  it('escapes the new text fields in content[] while structuredContent stays raw', () => {
    const [block] = findNavaidsTool.format!({
      mode: 'coordinate',
      airportIdent: null,
      navaids: [
        {
          id: 1,
          ident: 'X',
          name: 'X',
          type: 'VOR',
          frequencyKhz: 114500,
          frequencyMhz: 114.5,
          latitudeDeg: 0,
          longitudeDeg: 0,
          elevationFt: null,
          isoCountry: null,
          dmeChannel: null,
          dmeFrequencyKhz: null,
          associatedAirport: null,
          usageType: 'T*RM',
          power: '<b>HI',
          magneticVariationDeg: -2.5,
          slavedVariationDeg: null,
          distanceKm: 1,
          bearingDeg: 2,
        },
      ],
    });
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toContain(
      '**Usage:** T\\*RM | **Power:** \\<b>HI | **Magnetic variation:** -2.5° actual',
    );
  });
});
