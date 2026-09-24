/**
 * @fileoverview Domain types for the OurAirports data layer — the parsed,
 * normalized shapes of airports, runways, navaids, frequencies, countries, and
 * regions, plus the query result shapes returned by the service accessors.
 *
 * Field presence mirrors the real CSVs: codes and most attributes are sparse
 * (a small US field has no IATA/ICAO), so optional fields are genuinely
 * absent — never fabricated into `''` / `0` / `false` during parsing.
 * @module src/services/airport-data/types
 */

/** OurAirports airport type values (the seven verified live `type` enum values). */
export type AirportType =
  | 'large_airport'
  | 'medium_airport'
  | 'small_airport'
  | 'heliport'
  | 'seaplane_base'
  | 'balloonport'
  | 'closed';

export const AIRPORT_TYPES: readonly AirportType[] = [
  'large_airport',
  'medium_airport',
  'small_airport',
  'heliport',
  'seaplane_base',
  'balloonport',
  'closed',
] as const;

/** OurAirports navaid type values (the seven verified live `type` enum values, incl. compound). */
export type NavaidType = 'NDB' | 'VOR-DME' | 'VORTAC' | 'TACAN' | 'VOR' | 'DME' | 'NDB-DME';

export const NAVAID_TYPES: readonly NavaidType[] = [
  'NDB',
  'VOR-DME',
  'VORTAC',
  'TACAN',
  'VOR',
  'DME',
  'NDB-DME',
] as const;

/** Continent codes used by both countries.csv and regions.csv. */
export type Continent = 'AF' | 'AN' | 'AS' | 'EU' | 'NA' | 'OC' | 'SA';

export const CONTINENTS: readonly Continent[] = ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'] as const;

/**
 * A parsed airport row. `id` is the integer PK; `ident` is the universal
 * id-string (globally unique). The five code fields are sparse — only `ident`
 * is guaranteed present.
 */
export interface Airport {
  continent?: string;
  elevationFt?: number;
  gpsCode?: string;
  homeLink?: string;
  iataCode?: string;
  icaoCode?: string;
  id: number;
  ident: string;
  isoCountry?: string;
  isoRegion?: string;
  keywords?: string;
  latitudeDeg: number;
  localCode?: string;
  longitudeDeg: number;
  municipality?: string;
  name: string;
  scheduledService: boolean;
  type: string;
  wikipediaLink?: string;
}

/** A parsed runway row, joined to its airport by `airportRef` (→ airports.id). */
export interface Runway {
  airportIdent: string;
  airportRef: number;
  closed: boolean;
  heDisplacedThresholdFt?: number;
  heElevationFt?: number;
  heHeadingDegT?: number;
  heIdent?: string;
  heLatitudeDeg?: number;
  heLongitudeDeg?: number;
  id: number;
  leDisplacedThresholdFt?: number;
  leElevationFt?: number;
  leHeadingDegT?: number;
  leIdent?: string;
  leLatitudeDeg?: number;
  leLongitudeDeg?: number;
  lengthFt?: number;
  lighted: boolean;
  surface?: string;
  widthFt?: number;
}

/**
 * A parsed navaid row. Frequencies are stored in kHz for ALL types
 * (VOR 114.5 MHz → 114500 kHz): an NDB/NDB-DME's value is its kHz tuning
 * frequency, every other type's is a VHF or paired-VHF value. Upstream `-1`
 * placeholder frequencies are dropped at parse time (absent = unknown).
 * `associatedAirport` (→ airports.ident) is empty for ~33% of records
 * (standalone enroute navaids).
 */
export interface Navaid {
  associatedAirport?: string;
  dmeChannel?: string;
  /** Paired VHF frequency of the DME/TACAN component, in kHz, on every type that has one. */
  dmeFrequencyKhz?: number;
  elevationFt?: number;
  frequencyKhz?: number;
  id: number;
  ident: string;
  isoCountry?: string;
  latitudeDeg: number;
  longitudeDeg: number;
  /** Actual magnetic variation at the site, degrees, positive east. */
  magneticVariationDeg?: number;
  name: string;
  power?: string;
  /** Variation built into the radials (VOR/VOR-DME/VORTAC/TACAN), degrees, positive east. */
  slavedVariationDeg?: number;
  type: string;
  usageType?: string;
}

/** A parsed airport-frequency row. `frequencyMhz` is in MHz (e.g. 122.9). */
export interface Frequency {
  airportIdent: string;
  airportRef: number;
  description?: string;
  frequencyMhz?: number;
  id: number;
  type: string;
}

/** A parsed country row. `code` IS the ISO 3166-1 alpha-2 (the PK). */
export interface Country {
  code: string;
  continent?: string;
  keywords?: string;
  name: string;
  wikipediaLink?: string;
}

/** A parsed region row. `code` is the ISO 3166-2 form (e.g. `US-WA`). */
export interface Region {
  code: string;
  continent?: string;
  isoCountry?: string;
  localCode?: string;
  name: string;
  wikipediaLink?: string;
}

/** Which identifier space a `code` resolved against, for the `resolutionNote`. */
export type ResolvedVia = 'ident' | 'icao_code' | 'iata_code' | 'gps_code' | 'local_code';

/** Another airport carrying a shared code string, with every space it carries it in. */
export interface CodeHolder {
  airport: Airport;
  /** The code spaces this airport carries the string in, in resolution-priority order. */
  spaces: ResolvedVia[];
}

/** Result of `resolveByCode`: the matched airport plus which space it matched. */
export interface CodeResolution {
  airport: Airport;
  resolvedVia: ResolvedVia;
  /**
   * Every other airport carrying the code string in any space — listed by the
   * highest space each carries it in, then dataset row order. Empty when the
   * code belongs to one airport only.
   */
  sharedWith: CodeHolder[];
}

/** An airport summary with great-circle distance/bearing from a query point. */
export interface AirportWithDistance {
  airport: Airport;
  bearingDeg: number;
  distanceKm: number;
}

/** A navaid with great-circle distance/bearing from a query point (coordinate mode). */
export interface NavaidWithDistance {
  bearingDeg: number;
  distanceKm: number;
  navaid: Navaid;
}

/** Nearest airports within a radius (capped) plus the filtered in-radius total. */
export interface NearbyAirportsResult {
  airports: AirportWithDistance[];
  totalMatched: number;
}

/** Nearest navaids within a radius (capped) plus the filtered in-radius total. */
export interface NearbyNavaidsResult {
  navaids: NavaidWithDistance[];
  totalMatched: number;
}

/** Navaids associated with an airport (capped) plus the type-filtered total. */
export interface AirportNavaidsResult {
  navaids: Navaid[];
  totalMatched: number;
}

/** Filters accepted by the full-text / faceted airport search. */
export interface SearchFilters {
  country?: string;
  includeClosed: boolean;
  limit: number;
  query?: string;
  region?: string;
  type?: string;
}

/** Result of an airport search — the hits plus the pre-limit total. */
export interface SearchResult {
  airports: Airport[];
  /**
   * True when a non-blank `query` tokenized to nothing (only stopwords or
   * punctuation) — distinct from a genuine zero-match. The tool surfaces a
   * "no searchable terms" notice instead of the generic empty-result guidance.
   */
  noSearchableTerms?: boolean;
  totalMatched: number;
}

/**
 * Filters accepted by the runway-attribute search. Airport-level facets
 * (country/region/type/includeClosedAirports) narrow the airport set first;
 * runway-level facets (surface/minLengthFt/minWidthFt/lighted/
 * includeClosedRunways) then filter each surviving airport's runways.
 *
 * `minLengthFt`/`minWidthFt` are exclusion thresholds: a runway with an unknown
 * value for the corresponding field is excluded, never treated as passing.
 * `lighted` is tri-state — omitted means "either", not "unlighted".
 */
export interface RunwaySearchFilters {
  country?: string;
  includeClosedAirports: boolean;
  includeClosedRunways: boolean;
  lighted?: boolean;
  limit: number;
  minLengthFt?: number;
  minWidthFt?: number;
  region?: string;
  surface?: string;
  type?: string;
}

/** A matched runway paired with its airport — one flat join row per runway. */
export interface RunwayMatch {
  airport: Airport;
  runway: Runway;
}

/** Result of a runway search — the flat rows (capped) plus the pre-limit total. */
export interface RunwaySearchResult {
  matches: RunwayMatch[];
  totalMatched: number;
}

/** A country entry with its airport count, and optionally its regions. */
export interface CountrySummary {
  airportCount: number;
  code: string;
  continent?: string;
  name: string;
  regions?: RegionSummary[];
}

/** A region entry with its airport count. */
export interface RegionSummary {
  airportCount: number;
  code: string;
  name: string;
}
