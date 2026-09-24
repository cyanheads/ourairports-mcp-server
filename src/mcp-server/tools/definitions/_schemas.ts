/**
 * @fileoverview Shared Zod output schemas, domain→output mappers, and
 * content[] renderers for the OurAirports tool surface. Centralizes the
 * airport / runway / frequency / navaid output shapes, the shared-code
 * resolution note, and the Markdown escaping of upstream text so
 * `get_airport`, the `airport://` resource, and the search/find tools render
 * the same fields the same way.
 *
 * Sparsity is first-class: absent upstream fields map to `null` (codes,
 * elevation) so "this airport has no IATA" is explicit signal, never fabricated.
 * @module src/mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import type {
  Airport,
  CodeResolution,
  Frequency,
  Navaid,
  ResolvedVia,
  Runway,
} from '@/services/airport-data/types.js';

/** Nullable code set echoed on every airport record (drives "no IATA" signal). */
export const AirportSummarySchema = z
  .object({
    id: z
      .number()
      .describe('OurAirports internal integer id (the join key for runways/frequencies).'),
    ident: z
      .string()
      .describe(
        'OurAirports universal identifier — globally unique; often equals the ICAO or GPS code.',
      ),
    type: z
      .string()
      .describe(
        'Airport type: large_airport, medium_airport, small_airport, heliport, seaplane_base, balloonport, or closed.',
      ),
    name: z.string().describe('Airport name.'),
    latitudeDeg: z.number().describe('Latitude in decimal degrees (WGS84).'),
    longitudeDeg: z.number().describe('Longitude in decimal degrees (WGS84).'),
    elevationFt: z.number().nullable().describe('Field elevation in feet, or null when unknown.'),
    continent: z
      .string()
      .nullable()
      .describe('Two-letter continent code (AF, AN, AS, EU, NA, OC, SA), or null.'),
    isoCountry: z.string().nullable().describe('ISO 3166-1 alpha-2 country code, or null.'),
    countryName: z
      .string()
      .nullable()
      .describe('Resolved country name, or null when the country code is unknown.'),
    isoRegion: z.string().nullable().describe('ISO 3166-2 region code (e.g. US-WA), or null.'),
    regionName: z
      .string()
      .nullable()
      .describe('Resolved region name, or null when the region code is unknown.'),
    municipality: z.string().nullable().describe('Served municipality, or null.'),
    scheduledService: z.boolean().describe('True when the airport has scheduled airline service.'),
    icaoCode: z
      .string()
      .nullable()
      .describe('4-letter ICAO code, or null when the airport has none (~88% of fields).'),
    iataCode: z
      .string()
      .nullable()
      .describe('3-letter IATA code, or null when the airport has none (~89% of fields).'),
    gpsCode: z.string().nullable().describe('GPS code, or null.'),
    localCode: z.string().nullable().describe('National/local code (e.g. FAA LID), or null.'),
  })
  .describe('An airport summary with its full (sparse) code set and coordinates.');

export const RunwaySchema = z
  .object({
    id: z.number().describe('OurAirports runway id.'),
    lengthFt: z
      .number()
      .nullable()
      .describe(
        'Length of the full runway surface in feet, including displaced thresholds and overrun areas — not the usable takeoff or landing distance. Null when unknown.',
      ),
    widthFt: z.number().nullable().describe('Runway width in feet, or null when unknown.'),
    surface: z
      .string()
      .nullable()
      .describe('Surface material as recorded upstream (free text, e.g. ASP, CON, GRS), or null.'),
    lighted: z.boolean().describe('True when the runway is lighted.'),
    closed: z.boolean().describe('True when the runway is closed.'),
    leIdent: z.string().nullable().describe('Low-end runway designator (e.g. 16L), or null.'),
    leHeadingDegT: z.number().nullable().describe('Low-end true heading in degrees, or null.'),
    leDisplacedThresholdFt: z
      .number()
      .nullable()
      .describe(
        'Length of the displaced threshold at the low end (leIdent) in feet — part of lengthFt. Null when none is recorded.',
      ),
    heIdent: z.string().nullable().describe('High-end runway designator (e.g. 34R), or null.'),
    heHeadingDegT: z.number().nullable().describe('High-end true heading in degrees, or null.'),
    heDisplacedThresholdFt: z
      .number()
      .nullable()
      .describe(
        'Length of the displaced threshold at the high end (heIdent) in feet — part of lengthFt. Null when none is recorded.',
      ),
  })
  .describe(
    'A runway with full-surface dimensions, surface, lighting, and per-end designators, headings, and displaced thresholds.',
  );

export const FrequencySchema = z
  .object({
    id: z.number().describe('OurAirports frequency id.'),
    type: z
      .string()
      .describe('Frequency type/role (e.g. TWR, GND, ATIS, APP) as recorded upstream.'),
    description: z.string().nullable().describe('Human-readable description, or null.'),
    frequencyMhz: z
      .number()
      .nullable()
      .describe('Radio frequency in MHz (e.g. 122.9), or null when unknown.'),
  })
  .describe('An airport radio frequency (tower, ground, ATIS, etc.) in MHz.');

export const NavaidSchema = z
  .object({
    id: z.number().describe('OurAirports navaid id.'),
    ident: z.string().describe('Navaid identifier (e.g. SEA).'),
    name: z.string().describe('Navaid name.'),
    type: z.string().describe('Navaid type: NDB, VOR-DME, VORTAC, TACAN, VOR, DME, or NDB-DME.'),
    frequencyKhz: z
      .number()
      .nullable()
      .describe(
        'Frequency in kHz as stored upstream for every type. NDB and NDB-DME are tuned on this value directly; VOR and VOR-DME carry their VHF frequency and DME, TACAN, and VORTAC their paired VHF frequency (VOR 114.5 MHz is stored as 114500). Null when unknown.',
      ),
    frequencyMhz: z
      .number()
      .nullable()
      .describe(
        'frequencyKhz / 1000 for VOR and VOR-DME (the VHF frequency) and for DME, TACAN, and VORTAC (the paired VHF frequency, which for some TACAN channels lies above 118 MHz). Null for NDB and NDB-DME, which are tuned in kHz, and when the frequency is unknown.',
      ),
    latitudeDeg: z.number().describe('Latitude in decimal degrees (WGS84).'),
    longitudeDeg: z.number().describe('Longitude in decimal degrees (WGS84).'),
    elevationFt: z.number().nullable().describe('Elevation in feet, or null when unknown.'),
    isoCountry: z.string().nullable().describe('ISO 3166-1 alpha-2 country code, or null.'),
    dmeChannel: z.string().nullable().describe('DME channel (e.g. 115X), or null.'),
    dmeFrequencyKhz: z
      .number()
      .nullable()
      .describe(
        'Paired VHF frequency of the DME or TACAN component in kHz (divide by 1000 for MHz), on every type that has one — including NDB-DME, where it differs from frequencyKhz. Null when the navaid has no DME component recorded.',
      ),
    usageType: z
      .string()
      .nullable()
      .describe(
        'Service-volume class as recorded upstream: HI, LO, BOTH, TERMINAL, or RNAV. Null when not recorded.',
      ),
    power: z
      .string()
      .nullable()
      .describe(
        'Transmitter power class as recorded upstream: HIGH, MEDIUM, LOW, or UNKNOWN. Null when not recorded.',
      ),
    magneticVariationDeg: z
      .number()
      .nullable()
      .describe(
        'Actual magnetic variation at the navaid site in degrees, positive east. Null when not recorded.',
      ),
    slavedVariationDeg: z
      .number()
      .nullable()
      .describe(
        'Magnetic variation built into the radials of a VOR, VOR-DME, VORTAC, or TACAN in degrees, positive east — the reference radials are measured from, which can differ from magneticVariationDeg. Null when not recorded.',
      ),
    associatedAirport: z
      .string()
      .nullable()
      .describe('Ident of the airport this navaid serves, or null for standalone enroute navaids.'),
  })
  .describe(
    'A navigation aid with its frequency (kHz, plus MHz where the type has a VHF frequency), type, position, DME pairing, service volume, power, and magnetic variation.',
  );

// ---- domain → output mappers ----------------------------------------------

/** Map a domain Airport to the summary output shape, resolving country/region names. */
export function toAirportSummary(
  a: Airport,
  countryName: string | undefined,
  regionName: string | undefined,
): z.infer<typeof AirportSummarySchema> {
  return {
    id: a.id,
    ident: a.ident,
    type: a.type,
    name: a.name,
    latitudeDeg: a.latitudeDeg,
    longitudeDeg: a.longitudeDeg,
    elevationFt: a.elevationFt ?? null,
    continent: a.continent ?? null,
    isoCountry: a.isoCountry ?? null,
    countryName: countryName ?? null,
    isoRegion: a.isoRegion ?? null,
    regionName: regionName ?? null,
    municipality: a.municipality ?? null,
    scheduledService: a.scheduledService,
    icaoCode: a.icaoCode ?? null,
    iataCode: a.iataCode ?? null,
    gpsCode: a.gpsCode ?? null,
    localCode: a.localCode ?? null,
  };
}

export function toRunway(r: Runway): z.infer<typeof RunwaySchema> {
  return {
    id: r.id,
    lengthFt: r.lengthFt ?? null,
    widthFt: r.widthFt ?? null,
    surface: r.surface ?? null,
    lighted: r.lighted,
    closed: r.closed,
    leIdent: r.leIdent ?? null,
    leHeadingDegT: r.leHeadingDegT ?? null,
    leDisplacedThresholdFt: r.leDisplacedThresholdFt ?? null,
    heIdent: r.heIdent ?? null,
    heHeadingDegT: r.heHeadingDegT ?? null,
    heDisplacedThresholdFt: r.heDisplacedThresholdFt ?? null,
  };
}

export function toFrequency(f: Frequency): z.infer<typeof FrequencySchema> {
  return {
    id: f.id,
    type: f.type,
    description: f.description ?? null,
    frequencyMhz: f.frequencyMhz ?? null,
  };
}

/** Navaid types whose stored kHz value is a VHF frequency (MHz = kHz / 1000). */
const VHF_NAVAID_TYPES: ReadonlySet<string> = new Set(['VOR', 'VOR-DME']);
/** UHF navaid types whose stored kHz value is the paired VHF frequency. */
const PAIRED_VHF_NAVAID_TYPES: ReadonlySet<string> = new Set(['DME', 'TACAN', 'VORTAC']);

export function toNavaid(n: Navaid): z.infer<typeof NavaidSchema> {
  const hasVhf = VHF_NAVAID_TYPES.has(n.type) || PAIRED_VHF_NAVAID_TYPES.has(n.type);
  return {
    id: n.id,
    ident: n.ident,
    name: n.name,
    type: n.type,
    frequencyKhz: n.frequencyKhz ?? null,
    frequencyMhz: hasVhf && n.frequencyKhz !== undefined ? n.frequencyKhz / 1000 : null,
    latitudeDeg: n.latitudeDeg,
    longitudeDeg: n.longitudeDeg,
    elevationFt: n.elevationFt ?? null,
    isoCountry: n.isoCountry ?? null,
    dmeChannel: n.dmeChannel ?? null,
    dmeFrequencyKhz: n.dmeFrequencyKhz ?? null,
    usageType: n.usageType ?? null,
    power: n.power ?? null,
    magneticVariationDeg: n.magneticVariationDeg ?? null,
    slavedVariationDeg: n.slavedVariationDeg ?? null,
    associatedAirport: n.associatedAirport ?? null,
  };
}

// ---- content[] rendering ---------------------------------------------------

const MARKDOWN_METACHAR = /[\\`*~_<\]&#\r\n]/;
/** A letter or digit ending / starting the slice — code-point aware, so astral letters count. */
const WORD_CHAR_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_CHAR_AFTER = /^[\p{L}\p{N}]/u;
/** A CommonMark entity or numeric character reference starting at `lastIndex` (bounded length). */
const ENTITY_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;
/** A block marker that would open a list, quote, heading, task box, or footnote at a line start. */
const LEADING_BLOCK_MARKER =
  /^(?:[-+](?=[ \t]|$)|>|#{1,6}(?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|\[(?:[ xX]\](?=[ \t]|$)|\^[^\]]*\]:))/;

/** True when the `_` at index `i` sits between two letters/digits (intraword). */
const isIntraword = (s: string, i: number): boolean =>
  WORD_CHAR_BEFORE.test(s.slice(Math.max(0, i - 2), i)) &&
  WORD_CHAR_AFTER.test(s.slice(i + 1, i + 3));

/**
 * Escape upstream text for interpolation into content[] Markdown, so it renders
 * as the literal value. `structuredContent` always carries the raw value — call
 * this at the render boundary only.
 *
 * Escapes only what can open or close a construct where the value lands:
 * `\`, backtick, `*`, `~`; `_` unless between two letters/digits; `<` before a
 * letter, `/`, `!`, or `?`, or ending the value (template text follows it);
 * `]` before `(` or `[`; `&` (as `&amp;`) starting an
 * entity reference; the first `#` of a trailing `#` run. CR/LF fold to a space.
 * Everything else passes through, so ordinary names (`AT&T`, `snake_case`,
 * `Sahabat [Sahabat 16] Airport`) stay byte-identical.
 *
 * `position: 'line-start'` is for a value that opens a line or list-item
 * content, where a leading `-`, `+`, `>`, `#`, `1.`, or `[x]` would start a
 * block; it additionally escapes that marker. One pass, linear in the length.
 *
 * Known limit: GFM treats a bare `www.`/`http://` URL as an autolink and ignores
 * escapes inside it, so an escaped character in such a URL shows its backslash.
 */
export function escapeMarkdown(
  value: string,
  position: 'inline' | 'line-start' = 'inline',
): string {
  const inline = escapeInline(value);
  if (position === 'inline' || inline.startsWith('\\')) return inline;
  const marker = LEADING_BLOCK_MARKER.exec(inline)?.[0];
  if (marker === undefined) return inline;
  // An ordered-list marker is neutralized at its delimiter; every other marker at its first character.
  return /^\d/.test(marker)
    ? `${marker.slice(0, -1)}\\${inline.slice(marker.length - 1)}`
    : `\\${inline}`;
}

function escapeInline(value: string): string {
  if (!MARKDOWN_METACHAR.test(value)) return value;
  const s = value.replace(/[\r\n]+/g, ' ');
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const next = s[i + 1];
    switch (c) {
      case '\\':
      case '`':
      case '*':
      case '~':
        out.push('\\', c);
        break;
      case '_':
        out.push(isIntraword(s, i) ? c : '\\_');
        break;
      case '<':
        // At the end of the value the next character is template text (e.g. the
        // `/` between runway ends), so a trailing `<` is escaped too.
        out.push(next === undefined || /[A-Za-z/!?]/.test(next) ? '\\<' : c);
        break;
      case ']':
        out.push(next === '(' || next === '[' ? '\\]' : c);
        break;
      case '&':
        ENTITY_REFERENCE.lastIndex = i;
        out.push(ENTITY_REFERENCE.test(s) ? '&amp;' : c);
        break;
      default:
        out.push(c);
    }
  }
  // A trailing `#` run after a space (or the whole value) closes an ATX
  // heading; escaping its first `#` keeps the run literal. Each `#` pushed one
  // element, so the run is the last `runLength` entries of `out`.
  let runStart = s.length;
  while (runStart > 0 && s[runStart - 1] === '#') runStart--;
  const runLength = s.length - runStart;
  if (runLength > 0 && (runStart === 0 || s[runStart - 1] === ' ' || s[runStart - 1] === '\t')) {
    out[out.length - runLength] = '\\#';
  }
  return out.join('');
}

/** Render a number, or a dash when null — keeps every field present for format-parity. */
export const numOrDash = (v: number | null): string => (v == null ? '—' : String(v));

/** Render upstream text escaped for Markdown, or a dash when null. */
export const textOrDash = (v: string | null): string => (v == null ? '—' : escapeMarkdown(v));

/**
 * Shared markdown renderer for an airport summary block. Renders EVERY field of
 * AirportSummarySchema (format-parity is lint-enforced — each output field must
 * appear in the rendered text), showing a dash for absent values. Coordinates
 * render as the exact `structuredContent` numbers.
 */
export function renderAirportLines(a: z.infer<typeof AirportSummarySchema>): string[] {
  return [
    `**${escapeMarkdown(a.name)}** (ident ${escapeMarkdown(a.ident)}, id ${a.id})`,
    `**Type:** ${escapeMarkdown(a.type)} | **Scheduled service:** ${a.scheduledService ? 'yes' : 'no'}`,
    `**Codes:** IATA ${textOrDash(a.iataCode)} · ICAO ${textOrDash(a.icaoCode)} · GPS ${textOrDash(a.gpsCode)} · Local ${textOrDash(a.localCode)}`,
    `**Location:** ${a.latitudeDeg}, ${a.longitudeDeg} · elevation ${numOrDash(a.elevationFt)} ft · continent ${textOrDash(a.continent)}`,
    `**Place:** ${textOrDash(a.municipality)}, region ${textOrDash(a.regionName)} (${textOrDash(a.isoRegion)}), country ${textOrDash(a.countryName)} (${textOrDash(a.isoCountry)})`,
  ];
}

type RunwayOutput = z.infer<typeof RunwaySchema>;

/** The runway's end designators (`16L/34R`), escaped, or `unnamed`. */
export function renderRunwayName(r: RunwayOutput): string {
  const ends = [r.leIdent, r.heIdent].filter((e): e is string => Boolean(e));
  return ends.length > 0 ? ends.map((e) => escapeMarkdown(e)).join('/') : 'unnamed';
}

/** `(id …) — length … × width … | surface … | lighted … | closed …` for one runway. */
export function renderRunwaySpec(r: RunwayOutput): string {
  return `(id ${r.id}) — length ${numOrDash(r.lengthFt)} ft × width ${numOrDash(r.widthFt)} ft | surface: ${textOrDash(r.surface)} | lighted: ${r.lighted ? 'yes' : 'no'} | closed: ${r.closed ? 'yes' : 'no'}`;
}

/** Per-end headings and displaced thresholds, each next to its end designator. */
export function renderRunwayEnds(r: RunwayOutput): string {
  const threshold = (ft: number | null) => (ft == null ? '—' : `${ft} ft`);
  const le = textOrDash(r.leIdent);
  const he = textOrDash(r.heIdent);
  return `headings (true): ${le} ${numOrDash(r.leHeadingDegT)}° / ${he} ${numOrDash(r.heHeadingDegT)}° | displaced threshold: ${le} ${threshold(r.leDisplacedThresholdFt)} / ${he} ${threshold(r.heDisplacedThresholdFt)}`;
}

type NavaidOutput = z.infer<typeof NavaidSchema>;

/**
 * `116800 kHz (paired VHF 116.8 MHz)` for DME/TACAN/VORTAC, `115300 kHz (115.3 MHz)`
 * for VOR/VOR-DME, `414 kHz` for NDB/NDB-DME (no MHz figure), `—` when unknown.
 */
export function renderNavaidFrequency(n: NavaidOutput): string {
  if (n.frequencyKhz == null) return '—';
  if (n.frequencyMhz == null) return `${n.frequencyKhz} kHz`;
  const label = PAIRED_VHF_NAVAID_TYPES.has(n.type) ? 'paired VHF ' : '';
  return `${n.frequencyKhz} kHz (${label}${n.frequencyMhz} MHz)`;
}

// ---- resolution note -------------------------------------------------------

const PRIORITY: readonly ResolvedVia[] = [
  'ident',
  'icao_code',
  'iata_code',
  'gps_code',
  'local_code',
];

/** `a`, `a and b`, `a, b, and c`. */
const joinWords = (words: readonly string[]): string =>
  words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;

/**
 * The human-readable note on how `code` resolved — shared by
 * ourairports_get_airport, the airport://{code} resource, and
 * ourairports_find_navaids airport mode. A code on one airport reads
 * `Resolved via <space>.`; a shared code also names every other airport
 * carrying it (ident, country, code spaces), says whether resolution priority
 * or dataset row order (a tie within the matched space) picked this one, and
 * points at the other airport's ident — every ident resolves to itself.
 */
export function buildResolutionNote(code: string, resolution: CodeResolution): string {
  const { resolvedVia, sharedWith } = resolution;
  const plain = `Resolved via ${resolvedVia}.`;
  if (sharedWith.length === 0) return plain;

  const count = sharedWith.length;
  const holders = sharedWith
    .map(
      (h) => `${h.airport.ident} (${h.airport.isoCountry ?? 'no country'}, ${joinWords(h.spaces)})`,
    )
    .join(', ');
  const sentences = [
    plain,
    `"${code.trim().toUpperCase()}" is also a code of ${count} other airport${count === 1 ? '' : 's'}: ${holders}.`,
  ];

  // Spaces of holders that lost on priority alone (a holder sharing the matched space lost on row order).
  const outranked = PRIORITY.filter((space) =>
    sharedWith.some((h) => !h.spaces.includes(resolvedVia) && h.spaces.includes(space)),
  );
  if (outranked.length > 0) {
    sentences.push(
      `${resolvedVia} outranks ${joinWords(outranked)} (resolution priority: ${PRIORITY.join(', ')}).`,
    );
  }
  if (sharedWith.some((h) => h.spaces.includes(resolvedVia))) {
    sentences.push(
      `Among airports carrying it as ${resolvedVia}, dataset row order selected this one.`,
    );
  }
  sentences.push(
    count === 1
      ? 'To fetch that airport, pass its ident.'
      : 'To fetch one of them, pass its ident.',
  );
  return sentences.join(' ');
}
