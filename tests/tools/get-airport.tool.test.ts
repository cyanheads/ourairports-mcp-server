/**
 * @fileoverview Tests for ourairports_get_airport — code resolution, inline
 * runways/frequencies, the resolution note for shared codes, displaced
 * thresholds, Markdown escaping and exact coordinates in content[], include
 * trimming, and the unknown_code error contract.
 * @module tests/tools/get-airport.tool.test
 */

import {
  createMockContext as createBaseMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureService } from '../fixtures/load.js';

const svc = await loadFixtureService();
vi.mock('@/services/airport-data/airport-data-service.js', async (orig) => {
  const actual = await orig<typeof import('@/services/airport-data/airport-data-service.js')>();
  return { ...actual, getAirportDataService: () => svc };
});

const { getAirportTool } = await import('@/mcp-server/tools/definitions/get-airport.tool.js');
const createMockContext = () => createBaseMockContext({ errors: getAirportTool.errors });

/** Run the tool through its public contract (output parse + format + enrichment trailer). */
async function call(code: string, include?: ('runways' | 'frequencies')[]) {
  const result = await runToolContract(getAirportTool, { code, ...(include && { include }) });
  expect(result.isError).toBeFalsy();
  const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  const structured = result.structuredContent as Awaited<ReturnType<typeof getAirportTool.handler>>;
  return { text, structured };
}

describe('getAirportTool', () => {
  it('resolves by IATA with inline runways and frequencies', async () => {
    const ctx = createMockContext();
    const input = getAirportTool.input.parse({ code: 'SEA' });
    const result = await getAirportTool.handler(input, ctx);

    expect(result.airport.ident).toBe('KSEA');
    expect(result.airport.iataCode).toBe('SEA');
    expect(result.resolvedVia).toBe('iata_code');
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    expect(result.airport.countryName).toBe('United States');
    expect(result.airport.regionName).toBe('Washington');
  });

  it('reports absent codes as null (00AA has no IATA/ICAO)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: '00AA' }), ctx);
    expect(result.airport.iataCode).toBeNull();
    expect(result.airport.icaoCode).toBeNull();
    expect(result.airport.gpsCode).toBe('00AA');
  });

  it('names the other airport sharing a national code and why this one won (HBE, same-space tie)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'HBE' }), ctx);
    expect(result.resolutionNote).toBe(
      'Resolved via gps_code. "HBE" is also a code of 1 other airport: SAHBE (AR, gps_code and local_code). Among airports carrying it as gps_code, dataset row order selected this one. To fetch that airport, pass its ident.',
    );
  });

  // #2: a globally-unique ident resolves to its own airport even when an earlier
  // CSV row uses the same string as a gps/local code.
  it('resolves a shadowed unique ident to its own airport (5MO → Plattsburg)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: '5MO' }), ctx);
    expect(result.airport.ident).toBe('5MO');
    expect(result.airport.name).toBe('Plattsburg Airpark');
    expect(result.resolvedVia).toBe('ident');
  });

  // #5: `include` selection is echoed via the `included` output field, and
  // format() distinguishes an omitted relation ("not requested") from a
  // genuinely empty one ("None recorded").
  it('include default returns both relations and lists them in `included`', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'KSEA' }), ctx);
    expect(result.included).toEqual(['runways', 'frequencies']);
    expect(result.runways.length).toBe(2);
    expect(result.frequencies.length).toBeGreaterThanOrEqual(3);
    const text = (getAirportTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    expect(text).toContain('**Included:** runways, frequencies');
    expect(text).not.toContain('Not requested');
    expect(text).not.toContain('None recorded');
  });

  it('include ["runways"] omits frequencies and labels the section "not requested", not "None recorded"', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA', include: ['runways'] }),
      ctx,
    );
    expect(result.included).toEqual(['runways']);
    expect(result.runways.length).toBe(2);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    // KSEA HAS frequencies — omitting them must not read as "None recorded".
    expect(text).toMatch(/### Frequencies\n_Not requested/);
    expect(text).not.toContain('### Frequencies (0)');
    expect(text).toContain('16L'); // runways still rendered
  });

  it('include [] omits both relations (neither shown as "None recorded")', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: 'KSEA', include: [] }),
      ctx,
    );
    expect(result.included).toEqual([]);
    expect(result.runways).toEqual([]);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    expect(text).toContain('**Included:** none');
    expect(text).not.toContain('None recorded');
    expect(text.match(/_Not requested/g)?.length).toBe(2);
  });

  it('a requested relation with no records still reads "None recorded" (00AA has no frequencies)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: '00AA', include: ['frequencies'] }),
      ctx,
    );
    expect(result.included).toEqual(['frequencies']);
    expect(result.frequencies).toEqual([]);
    const text = (getAirportTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    expect(text).toMatch(/### Frequencies \(0\)\n_None recorded\._/);
    expect(text).toMatch(/### Runways\n_Not requested/); // runways not requested here
  });

  it('throws unknown_code for an unknown code', () => {
    const ctx = createMockContext();
    expect(() => getAirportTool.handler(getAirportTool.input.parse({ code: 'ZZZZ' }), ctx)).toThrow(
      /No airport found/,
    );
  });

  it('format() renders runways and frequencies', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(getAirportTool.input.parse({ code: 'KSEA' }), ctx);
    const text = (getAirportTool.format?.(result) ?? [])
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('\n');
    expect(text).toContain('Seattle Tacoma International Airport');
    expect(text).toContain('16L');
    expect(text).toContain('119.9 MHz');
  });

  // #7: code is trimmed before lookup; a padded code resolves, and a
  // whitespace-only code fails schema validation rather than becoming unknown_code.
  it('resolves a padded code by trimming ("  SEA  " → KSEA)', async () => {
    const ctx = createMockContext();
    const result = await getAirportTool.handler(
      getAirportTool.input.parse({ code: '  SEA  ' }),
      ctx,
    );
    expect(result.airport.ident).toBe('KSEA');
  });

  it('rejects a whitespace-only code at schema validation, not as unknown_code', () => {
    expect(() => getAirportTool.input.parse({ code: '   ' })).toThrow();
  });
});

describe('getAirportTool content rendering', () => {
  it('renders plain upstream values byte-identically (00AA summary lines)', async () => {
    const { text } = await call('00AA');
    expect(text).toContain(
      [
        '## Aero B Ranch Airport',
        '**Aero B Ranch Airport** (ident 00AA, id 6523)',
        '**Type:** small_airport | **Scheduled service:** no',
        '**Codes:** IATA — · ICAO — · GPS 00AA · Local 00AA',
      ].join('\n'),
    );
    expect(text).toContain('**Place:** Leoti, region Kansas (US-KS), country United States (US)');
    expect(text).toContain('**Resolved via:** ident\n**Resolution:** Resolved via ident.');
  });

  it('renders plain runway and frequency lines byte-identically (KSEA)', async () => {
    const { text } = await call('KSEA');
    expect(text).toContain(
      '- **16L/34R** (id 244323) — length 11901 ft × width 150 ft | surface: CON | lighted: yes | closed: no\n  - headings (true): 16L 180° / 34R 360°',
    );
    expect(text).toContain('- **TWR** (id 67890) — 119.9 MHz — Seattle Tower');
  });

  it('renders coordinates as the exact structuredContent numbers (KSEA)', async () => {
    const { text, structured } = await call('KSEA');
    expect(structured.airport.latitudeDeg).toBe(47.449001);
    expect(structured.airport.longitudeDeg).toBe(-122.308998);
    expect(text).toContain('**Location:** 47.449001, -122.308998 · elevation 433 ft');
  });

  it('escapes Markdown in upstream text while structuredContent keeps the raw value (CA-1094 surface)', async () => {
    const { text, structured } = await call('CA-1094');
    expect(structured.runways[0]?.surface).toBe('GRASS&amp;GRAVEL');
    expect(text).toContain('| surface: GRASS&amp;amp;GRAVEL |');
  });

  it('escapes the heading, name, and frequency lines (GR-0109)', async () => {
    const { text, structured } = await call('GR-0109');
    expect(structured.airport.name).toBe('(*)Kasteli Hellenic Air Force Base');
    expect(text).toContain('## (\\*)Kasteli Hellenic Air Force Base\n**(\\*)Kasteli Hellenic');
    expect(structured.frequencies[0]?.description).toBe('Kasteli *Tower* <b>ops</b> & [mil](x)');
    expect(text).toContain(
      '- **A/G\\_** (id 900001) — 122.1 MHz — Kasteli \\*Tower\\* \\<b>ops\\</b> & [mil\\](x)',
    );
  });

  it('escapes a backtick in the municipality (BR-2199)', async () => {
    const { text, structured } = await call('BR-2199');
    expect(structured.airport.municipality).toBe('Lambari d`Oeste');
    expect(text).toContain('**Place:** Lambari d\\`Oeste, region');
  });
});

describe('getAirportTool displaced thresholds', () => {
  it('exposes both displaced thresholds on the runway and renders them next to their end idents (VIDP 271000)', async () => {
    const { text, structured } = await call('VIDP', ['runways']);
    const runway = structured.runways.find((r) => r.id === 271000);
    expect(runway).toMatchObject({
      lengthFt: 14534,
      leIdent: '11R',
      leDisplacedThresholdFt: 2100,
      heIdent: '29L',
      heDisplacedThresholdFt: 4790,
    });
    expect(text).toContain(
      '  - headings (true): 11R 103° / 29L 283° | displaced threshold: 11R 2100 ft / 29L 4790 ft',
    );
  });

  it('reports a threshold recorded on one end only, null (never 0) on the other (VIDP 236778)', async () => {
    const { text, structured } = await call('VIDP', ['runways']);
    const runway = structured.runways.find((r) => r.id === 236778);
    expect(runway?.leDisplacedThresholdFt).toBeNull();
    expect(runway?.heDisplacedThresholdFt).toBe(499);
    expect(text).toContain('| displaced threshold: 09 — / 27 499 ft');
  });

  it('returns null for empty upstream threshold cells and leaves lengthFt unchanged (KSEA)', async () => {
    const { text, structured } = await call('KSEA', ['runways']);
    for (const runway of structured.runways) {
      expect(runway.leDisplacedThresholdFt).toBeNull();
      expect(runway.heDisplacedThresholdFt).toBeNull();
    }
    expect(structured.runways.map((r) => r.lengthFt)).toEqual([11901, 9426]);
    expect(text).toContain('| displaced threshold: 16L — / 34R —');
  });

  it('describes lengthFt as the full runway surface, not usable distance', () => {
    const runwayShape = getAirportTool.output.shape.runways.element.shape;
    expect(runwayShape.lengthFt.description).toMatch(/full runway surface/);
    expect(runwayShape.lengthFt.description).toMatch(/displaced thresholds/);
  });
});

describe('getAirportTool resolution note for shared codes', () => {
  it.each([
    ['SEA', 'Resolved via iata_code.'],
    ['KSEA', 'Resolved via ident.'],
    ['KJFK', 'Resolved via ident.'],
  ])('keeps the plain note for a code on one airport (%s)', async (code, note) => {
    const { structured } = await call(code);
    expect(structured.resolutionNote).toBe(note);
  });

  it('names the IATA owner an ident shadows (GIG → ranch; SBGL holds IATA GIG)', async () => {
    const { structured } = await call('GIG');
    expect(structured.airport.ident).toBe('GIG');
    expect(structured.resolvedVia).toBe('ident');
    expect(structured.resolutionNote).toBe(
      'Resolved via ident. "GIG" is also a code of 1 other airport: SBGL (BR, iata_code). ident outranks iata_code (resolution priority: ident, icao_code, iata_code, gps_code, local_code). To fetch that airport, pass its ident.',
    );
  });

  it('names the ICAO owner an ident shadows (LGTL → closed LGTL; GR-0109 holds ICAO LGTL)', async () => {
    const { structured } = await call('LGTL');
    expect(structured.resolutionNote).toContain('1 other airport: GR-0109 (GR, icao_code)');
    expect(structured.resolutionNote).toContain('ident outranks icao_code');
  });

  it('says IATA outranks a local code and names the local holder (AKA)', async () => {
    const { structured } = await call('AKA');
    expect(structured.airport.ident).toBe('ZLAK');
    expect(structured.resolutionNote).toBe(
      'Resolved via iata_code. "AKA" is also a code of 1 other airport: ABP (PG, local_code). iata_code outranks local_code (resolution priority: ident, icao_code, iata_code, gps_code, local_code). To fetch that airport, pass its ident.',
    );
  });

  it('says dataset row order decided a same-space tie and names both others (HBI)', async () => {
    const { structured } = await call('HBI');
    expect(structured.airport.ident).toBe('AR-0572');
    expect(structured.resolutionNote).toBe(
      'Resolved via local_code. "HBI" is also a code of 2 other airports: AYHH (PG, local_code), KHBI (US, local_code). Among airports carrying it as local_code, dataset row order selected this one. To fetch one of them, pass its ident.',
    );
  });

  it('lists every space another airport carries the code in (1A8 → 0L5 gps and local)', async () => {
    const { structured } = await call('1A8');
    expect(structured.resolutionNote).toContain(
      '1 other airport: 0L5 (US, gps_code and local_code). ident outranks gps_code and local_code',
    );
  });

  it.each([
    ['5MO', '15MO (US, local_code)'],
    ['ERT', 'AR-0143 (AR, local_code)'],
  ])('names the national-code holder a unique ident shadows (%s)', async (code, holder) => {
    const { structured } = await call(code);
    expect(structured.airport.ident).toBe(code);
    expect(structured.resolutionNote).toContain(`1 other airport: ${holder}`);
  });

  it.each(['HBE', 'GIG', 'LGTL', 'AKA', 'HBI', '1A8', '5MO', 'ERT'])(
    'never suggests the input code or the resolved ident, and never says "first match" (%s)',
    async (code) => {
      const { structured } = await call(code);
      const listed = structured.resolutionNote.split(': ').slice(1).join(': ');
      expect(listed).not.toMatch(new RegExp(`\\b${structured.airport.ident} \\(`));
      expect(listed).not.toMatch(new RegExp(`\\b${code} \\(`));
      expect(structured.resolutionNote).not.toMatch(/first match/);
    },
  );

  it('renders the note in content[] (GIG)', async () => {
    const { text, structured } = await call('GIG');
    expect(text).toContain(`**Resolution:** ${structured.resolutionNote}`);
  });
});
