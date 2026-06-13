/**
 * @fileoverview Shared Zod output schemas and domain→output mappers for the
 * OurAirports tool surface. Centralizes the airport / runway / frequency /
 * navaid output shapes so `get_airport`, the `airport://` resource, and the
 * search/find tools render the same fields the same way.
 *
 * Sparsity is first-class: absent upstream fields map to `null` (codes,
 * elevation) so "this airport has no IATA" is explicit signal, never fabricated.
 * @module src/mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { Airport, Frequency, Navaid, Runway } from '@/services/airport-data/types.js';

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
      .describe('4-letter ICAO code, or null when the airport has none (~85% of fields).'),
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
    lengthFt: z.number().nullable().describe('Runway length in feet, or null when unknown.'),
    widthFt: z.number().nullable().describe('Runway width in feet, or null when unknown.'),
    surface: z
      .string()
      .nullable()
      .describe('Surface material as recorded upstream (free text, e.g. ASP, CON, GRS), or null.'),
    lighted: z.boolean().describe('True when the runway is lighted.'),
    closed: z.boolean().describe('True when the runway is closed.'),
    leIdent: z.string().nullable().describe('Low-end runway designator (e.g. 16L), or null.'),
    leHeadingDegT: z.number().nullable().describe('Low-end true heading in degrees, or null.'),
    heIdent: z.string().nullable().describe('High-end runway designator (e.g. 34R), or null.'),
    heHeadingDegT: z.number().nullable().describe('High-end true heading in degrees, or null.'),
  })
  .describe('A runway with dimensions, surface, lighting, and end designators/headings.');

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
        'Primary tuning frequency in kHz (VOR 114.5 MHz is stored as 114500 kHz), or null.',
      ),
    frequencyMhz: z
      .number()
      .nullable()
      .describe(
        'Same frequency expressed in MHz for VHF navaids (kHz/1000), or null when unknown.',
      ),
    latitudeDeg: z.number().describe('Latitude in decimal degrees (WGS84).'),
    longitudeDeg: z.number().describe('Longitude in decimal degrees (WGS84).'),
    elevationFt: z.number().nullable().describe('Elevation in feet, or null when unknown.'),
    isoCountry: z.string().nullable().describe('ISO 3166-1 alpha-2 country code, or null.'),
    dmeChannel: z.string().nullable().describe('DME channel, or null.'),
    associatedAirport: z
      .string()
      .nullable()
      .describe('Ident of the airport this navaid serves, or null for standalone enroute navaids.'),
  })
  .describe('A navigation aid with tuning frequency (kHz and MHz), type, and position.');

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
    heIdent: r.heIdent ?? null,
    heHeadingDegT: r.heHeadingDegT ?? null,
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

export function toNavaid(n: Navaid): z.infer<typeof NavaidSchema> {
  return {
    id: n.id,
    ident: n.ident,
    name: n.name,
    type: n.type,
    frequencyKhz: n.frequencyKhz ?? null,
    frequencyMhz: n.frequencyKhz !== undefined ? n.frequencyKhz / 1000 : null,
    latitudeDeg: n.latitudeDeg,
    longitudeDeg: n.longitudeDeg,
    elevationFt: n.elevationFt ?? null,
    isoCountry: n.isoCountry ?? null,
    dmeChannel: n.dmeChannel ?? null,
    associatedAirport: n.associatedAirport ?? null,
  };
}

/** Render `value` or a dash when null/undefined — keeps every field present for format-parity. */
const orDash = (v: string | number | null | undefined): string => (v == null ? '—' : String(v));

/**
 * Shared markdown renderer for an airport summary block. Renders EVERY field of
 * AirportSummarySchema (format-parity is lint-enforced — each output field must
 * appear in the rendered text), showing a dash for absent values.
 */
export function renderAirportLines(a: z.infer<typeof AirportSummarySchema>): string[] {
  return [
    `**${a.name}** (ident ${a.ident}, id ${a.id})`,
    `**Type:** ${a.type} | **Scheduled service:** ${a.scheduledService ? 'yes' : 'no'}`,
    `**Codes:** IATA ${orDash(a.iataCode)} · ICAO ${orDash(a.icaoCode)} · GPS ${orDash(a.gpsCode)} · Local ${orDash(a.localCode)}`,
    `**Location:** ${a.latitudeDeg.toFixed(4)}, ${a.longitudeDeg.toFixed(4)} · elevation ${orDash(a.elevationFt)} ft · continent ${orDash(a.continent)}`,
    `**Place:** ${orDash(a.municipality)}, region ${orDash(a.regionName)} (${orDash(a.isoRegion)}), country ${orDash(a.countryName)} (${orDash(a.isoCountry)})`,
  ];
}
