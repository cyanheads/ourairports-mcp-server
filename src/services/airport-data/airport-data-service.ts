/**
 * @fileoverview The airport-data service — the server's source of truth.
 *
 * Loads the six bundled OurAirports CSVs once at `setup()`, parses them by
 * header name (not column position), and builds in-memory indices: id→airport
 * maps, a priority-ordered unified code index, airport-ref join maps for
 * runways/frequencies, an ident-keyed navaid map, a flat coordinate array for
 * haversine scans, country/region maps, and a tokenized text-search index.
 *
 * Every request-time accessor is then an O(1) map lookup or a single O(n) scan
 * over coordinates — no network, no SQLite, no per-request parsing. The corpus
 * is replaced wholesale at image-build time, so there is nothing to sync.
 * @module src/services/airport-data/airport-data-service
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { bool, compact, int, num, parseCsv, reqInt, reqStr, str } from './csv.js';
import { resolveBundledDataDir } from './data-dir.js';
import { bearingDeg, nearest } from './geo.js';
import type {
  Airport,
  AirportWithDistance,
  CodeResolution,
  Country,
  CountrySummary,
  Frequency,
  Navaid,
  NavaidWithDistance,
  Region,
  RegionSummary,
  ResolvedVia,
  Runway,
  SearchFilters,
  SearchResult,
} from './types.js';

const CSV_FILES = {
  airports: 'airports.csv',
  runways: 'runways.csv',
  navaids: 'navaids.csv',
  frequencies: 'airport-frequencies.csv',
  countries: 'countries.csv',
  regions: 'regions.csv',
} as const;

/** Append a value to a map of arrays, creating the array on first insertion. */
function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Code spaces in descending resolution priority — drives codeIndex insertion order. */
const CODE_PRIORITY: readonly { via: ResolvedVia; key: keyof Airport }[] = [
  { via: 'ident', key: 'ident' },
  { via: 'icao_code', key: 'icaoCode' },
  { via: 'iata_code', key: 'iataCode' },
  { via: 'gps_code', key: 'gpsCode' },
  { via: 'local_code', key: 'localCode' },
] as const;

const STOPWORD = new Set(['the', 'of', 'and', 'a', 'an']);

/**
 * Tokenize a string for the text-search index: lowercase, strip diacritics,
 * replace non-alphanumerics with spaces, split, drop short stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORD.has(t));
}

export class AirportDataService {
  private readonly airportsById = new Map<number, Airport>();
  /** Uppercased code string → airport id. Built in priority order, insert-if-absent. */
  private readonly codeIndex = new Map<string, number>();
  /** Which code space each codeIndex entry came from — for the resolution note. */
  private readonly codeVia = new Map<string, ResolvedVia>();
  /** Code strings that map to >1 airport in gps/local space (ambiguity flag). */
  private readonly ambiguousCodes = new Set<string>();
  private readonly runwaysByAirportRef = new Map<number, Runway[]>();
  private readonly frequenciesByAirportRef = new Map<number, Frequency[]>();
  private readonly navaidsByAirportIdent = new Map<string, Navaid[]>();
  private readonly countriesByCode = new Map<string, Country>();
  private readonly regionsByCode = new Map<string, Region>();
  /** alpha-2 country code → airport count (excludes closed). */
  private readonly airportCountByCountry = new Map<string, number>();
  /** ISO 3166-2 region code → airport count (excludes closed). */
  private readonly airportCountByRegion = new Map<string, number>();

  /** Flat [lat, lon, …] for airports, with a parallel id array (hot-loop friendly). */
  private airportCoords = new Float64Array(0);
  private airportCoordIds: number[] = [];
  /** Flat [lat, lon, …] for navaids, with a parallel index into `navaidList`. */
  private navaidCoords = new Float64Array(0);
  private navaidList: Navaid[] = [];

  /** Per-airport token set, parallel to `airportCoordIds` is NOT assumed — keyed by id. */
  private readonly tokensByAirportId = new Map<number, Set<string>>();

  private loaded = false;

  constructor(private readonly dataDir: string) {}

  /** Parse all six CSVs and build every index. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const started = performance.now();

    const read = (file: string) => readFile(join(this.dataDir, file), 'utf-8');
    const [airportsCsv, runwaysCsv, navaidsCsv, freqCsv, countriesCsv, regionsCsv] =
      await Promise.all([
        read(CSV_FILES.airports),
        read(CSV_FILES.runways),
        read(CSV_FILES.navaids),
        read(CSV_FILES.frequencies),
        read(CSV_FILES.countries),
        read(CSV_FILES.regions),
      ]);

    this.loadCountries(countriesCsv);
    this.loadRegions(regionsCsv);
    this.loadAirports(airportsCsv);
    this.loadRunways(runwaysCsv);
    this.loadFrequencies(freqCsv);
    this.loadNavaids(navaidsCsv);

    this.loaded = true;
    logger.info(
      'airport-data indices built',
      requestContextService.createRequestContext({
        operation: 'AirportDataLoad',
        dataDir: this.dataDir,
        airports: this.airportsById.size,
        runways: this.runwaysByAirportRef.size,
        navaids: this.navaidList.length,
        countries: this.countriesByCode.size,
        regions: this.regionsByCode.size,
        codeKeys: this.codeIndex.size,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }

  // ---- CSV → index builders -------------------------------------------------

  private loadCountries(csv: string): void {
    for (const r of parseCsv(csv)) {
      const code = str(r.code);
      if (!code) continue;
      const country: Country = {
        code,
        name: reqStr(r.name, 'countries.name'),
        ...compact({
          continent: str(r.continent),
          wikipediaLink: str(r.wikipedia_link),
          keywords: str(r.keywords),
        }),
      };
      this.countriesByCode.set(code.toUpperCase(), country);
    }
  }

  private loadRegions(csv: string): void {
    for (const r of parseCsv(csv)) {
      const code = str(r.code);
      if (!code) continue;
      const region: Region = {
        code,
        name: reqStr(r.name, 'regions.name'),
        ...compact({
          localCode: str(r.local_code),
          continent: str(r.continent),
          isoCountry: str(r.iso_country),
          wikipediaLink: str(r.wikipedia_link),
        }),
      };
      this.regionsByCode.set(code.toUpperCase(), region);
    }
  }

  private loadAirports(csv: string): void {
    const rows = parseCsv(csv);
    const lats: number[] = [];
    const lons: number[] = [];

    for (const r of rows) {
      const lat = num(r.latitude_deg);
      const lon = num(r.longitude_deg);
      // Coordinates are guaranteed in this dataset; skip the rare malformed row
      // rather than poison the coordinate array with NaN.
      if (lat === undefined || lon === undefined) continue;

      const airport: Airport = {
        id: reqInt(r.id, 'airports.id'),
        ident: reqStr(r.ident, 'airports.ident'),
        type: reqStr(r.type, 'airports.type'),
        name: reqStr(r.name, 'airports.name'),
        latitudeDeg: lat,
        longitudeDeg: lon,
        scheduledService: bool(r.scheduled_service),
        ...compact({
          elevationFt: int(r.elevation_ft),
          continent: str(r.continent),
          isoCountry: str(r.iso_country),
          isoRegion: str(r.iso_region),
          municipality: str(r.municipality),
          icaoCode: str(r.icao_code),
          iataCode: str(r.iata_code),
          gpsCode: str(r.gps_code),
          localCode: str(r.local_code),
          homeLink: str(r.home_link),
          wikipediaLink: str(r.wikipedia_link),
          keywords: str(r.keywords),
        }),
      };

      this.airportsById.set(airport.id, airport);
      lats.push(lat);
      lons.push(lon);
      this.airportCoordIds.push(airport.id);

      this.indexTokens(airport);

      if (airport.type !== 'closed') {
        if (airport.isoCountry) {
          this.airportCountByCountry.set(
            airport.isoCountry.toUpperCase(),
            (this.airportCountByCountry.get(airport.isoCountry.toUpperCase()) ?? 0) + 1,
          );
        }
        if (airport.isoRegion) {
          this.airportCountByRegion.set(
            airport.isoRegion.toUpperCase(),
            (this.airportCountByRegion.get(airport.isoRegion.toUpperCase()) ?? 0) + 1,
          );
        }
      }
    }

    // Code index is built AFTER all airports are loaded, in global priority
    // passes — so a unique ident is never shadowed by an earlier row's national
    // code (#2).
    this.buildCodeIndex();

    // Pack coordinates into a single Float64Array, parallel to airportCoordIds.
    const coords = new Float64Array(lats.length * 2);
    for (let i = 0; i < lats.length; i++) {
      coords[i * 2] = lats[i] as number;
      coords[i * 2 + 1] = lons[i] as number;
    }
    this.airportCoords = coords;
  }

  /**
   * Build the unified code index in GLOBAL priority passes: register every
   * airport's `ident`, then every `icao_code`, then `iata_code`, `gps_code`,
   * and `local_code` — each pass insert-if-absent over airports in CSV row
   * order. Idents are globally unique, so pass 1 is collision-free and a unique
   * ident can never be shadowed by an earlier-row airport's national (gps/local)
   * code (#2). The previous per-airport loop claimed keys in row order, letting
   * a low-priority `local_code` from an early row pre-empt a later row's
   * high-priority `ident`.
   *
   * Ambiguity semantics are unchanged: a code claimed by one airport that also
   * appears as any code of a *different* airport is flagged — the collision is
   * simply caught in a later pass rather than at per-airport insert time.
   */
  private buildCodeIndex(): void {
    for (const { via, key } of CODE_PRIORITY) {
      for (const airport of this.airportsById.values()) {
        const raw = airport[key];
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const upper = raw.toUpperCase();
        const claimedBy = this.codeIndex.get(upper);
        if (claimedBy !== undefined) {
          // A different airport already claimed this string in a higher pass.
          if (claimedBy !== airport.id) this.ambiguousCodes.add(upper);
          continue;
        }
        this.codeIndex.set(upper, airport.id);
        this.codeVia.set(upper, via);
      }
    }
  }

  private indexTokens(airport: Airport): void {
    const tokens = new Set<string>();
    for (const t of tokenize(airport.name)) tokens.add(t);
    if (airport.municipality) for (const t of tokenize(airport.municipality)) tokens.add(t);
    if (airport.keywords) for (const t of tokenize(airport.keywords)) tokens.add(t);
    this.tokensByAirportId.set(airport.id, tokens);
  }

  private loadRunways(csv: string): void {
    for (const r of parseCsv(csv)) {
      const airportRef = int(r.airport_ref);
      if (airportRef === undefined) continue;
      const runway: Runway = {
        id: reqInt(r.id, 'runways.id'),
        airportRef,
        airportIdent: reqStr(r.airport_ident, 'runways.airport_ident'),
        lighted: bool(r.lighted),
        closed: bool(r.closed),
        ...compact({
          lengthFt: int(r.length_ft),
          widthFt: int(r.width_ft),
          surface: str(r.surface),
          leIdent: str(r.le_ident),
          leLatitudeDeg: num(r.le_latitude_deg),
          leLongitudeDeg: num(r.le_longitude_deg),
          leElevationFt: int(r.le_elevation_ft),
          leHeadingDegT: num(r.le_heading_degT),
          leDisplacedThresholdFt: int(r.le_displaced_threshold_ft),
          heIdent: str(r.he_ident),
          heLatitudeDeg: num(r.he_latitude_deg),
          heLongitudeDeg: num(r.he_longitude_deg),
          heElevationFt: int(r.he_elevation_ft),
          heHeadingDegT: num(r.he_heading_degT),
          heDisplacedThresholdFt: int(r.he_displaced_threshold_ft),
        }),
      };
      pushToMap(this.runwaysByAirportRef, airportRef, runway);
    }
  }

  private loadFrequencies(csv: string): void {
    for (const r of parseCsv(csv)) {
      const airportRef = int(r.airport_ref);
      if (airportRef === undefined) continue;
      const freq: Frequency = {
        id: reqInt(r.id, 'airport-frequencies.id'),
        airportRef,
        airportIdent: reqStr(r.airport_ident, 'airport-frequencies.airport_ident'),
        type: reqStr(r.type, 'airport-frequencies.type'),
        ...compact({
          description: str(r.description),
          frequencyMhz: num(r.frequency_mhz),
        }),
      };
      pushToMap(this.frequenciesByAirportRef, airportRef, freq);
    }
  }

  private loadNavaids(csv: string): void {
    const rows = parseCsv(csv);
    const lats: number[] = [];
    const lons: number[] = [];

    for (const r of rows) {
      const lat = num(r.latitude_deg);
      const lon = num(r.longitude_deg);
      if (lat === undefined || lon === undefined) continue;

      const navaid: Navaid = {
        id: reqInt(r.id, 'navaids.id'),
        ident: reqStr(r.ident, 'navaids.ident'),
        name: reqStr(r.name, 'navaids.name'),
        type: reqStr(r.type, 'navaids.type'),
        latitudeDeg: lat,
        longitudeDeg: lon,
        ...compact({
          frequencyKhz: int(r.frequency_khz),
          elevationFt: int(r.elevation_ft),
          isoCountry: str(r.iso_country),
          dmeFrequencyKhz: int(r.dme_frequency_khz),
          dmeChannel: str(r.dme_channel),
          magneticVariationDeg: num(r.magnetic_variation_deg),
          usageType: str(r.usageType),
          power: str(r.power),
          associatedAirport: str(r.associated_airport),
        }),
      };

      // navaidList index == coordinate index (both arrays grow in lockstep).
      this.navaidList.push(navaid);
      lats.push(lat);
      lons.push(lon);

      if (navaid.associatedAirport) {
        pushToMap(this.navaidsByAirportIdent, navaid.associatedAirport.toUpperCase(), navaid);
      }
    }

    const coords = new Float64Array(lats.length * 2);
    for (let i = 0; i < lats.length; i++) {
      coords[i * 2] = lats[i] as number;
      coords[i * 2 + 1] = lons[i] as number;
    }
    this.navaidCoords = coords;
  }

  // ---- Accessors ------------------------------------------------------------

  /**
   * Resolve a code (any of IATA/ICAO/GPS/local/ident, case-insensitive) to its
   * airport. Returns the match plus which code space hit and whether the code
   * string is shared across airports in gps/local space. Returns `undefined`
   * when no code matches (the tool turns that into `unknown_code`).
   */
  resolveByCode(code: string): CodeResolution | undefined {
    const upper = code.trim().toUpperCase();
    if (upper.length === 0) return;
    const id = this.codeIndex.get(upper);
    if (id === undefined) return;
    const airport = this.airportsById.get(id);
    if (!airport) return;
    return {
      airport,
      resolvedVia: this.codeVia.get(upper) ?? 'ident',
      ambiguous: this.ambiguousCodes.has(upper),
    };
  }

  /** Runways for an airport (by its integer id), or `[]` when it has none. */
  runwaysForAirport(id: number): Runway[] {
    return this.runwaysByAirportRef.get(id) ?? [];
  }

  /** Frequencies for an airport (by its integer id), or `[]` when it has none. */
  frequenciesForAirport(id: number): Frequency[] {
    return this.frequenciesByAirportRef.get(id) ?? [];
  }

  /** Look up a country by alpha-2 code (case-insensitive). */
  country(code: string | undefined): Country | undefined {
    if (!code) return;
    return this.countriesByCode.get(code.toUpperCase());
  }

  /** Look up a region by ISO 3166-2 code (case-insensitive). */
  region(code: string | undefined): Region | undefined {
    if (!code) return;
    return this.regionsByCode.get(code.toUpperCase());
  }

  /**
   * Full-text + faceted airport search. Filters the complete corpus (not a
   * page): strict token-AND match on name/municipality/keywords for `query`,
   * exact-match facets for country/region/type, closed excluded unless opted in.
   * Ranks by a light relevance heuristic, then truncates to `limit`.
   */
  search(filters: SearchFilters): SearchResult {
    // A query of only stopwords/punctuation tokenizes to nothing. That is NOT
    // the same as an omitted/blank query (which browses by facets): the caller
    // supplied search intent that matched no searchable term, so return zero
    // with a flag the tool turns into a "no searchable terms" notice (#3).
    const hasQuery = filters.query !== undefined && filters.query.trim().length > 0;
    const queryTokens = hasQuery ? tokenize(filters.query as string) : [];
    if (hasQuery && queryTokens.length === 0) {
      return { airports: [], totalMatched: 0, noSearchableTerms: true };
    }
    const country = filters.country?.toUpperCase();
    const region = filters.region?.toUpperCase();
    const matched: { airport: Airport; score: number }[] = [];

    for (const airport of this.airportsById.values()) {
      if (!filters.includeClosed && airport.type === 'closed') continue;
      if (filters.type && airport.type !== filters.type) continue;
      if (country && airport.isoCountry?.toUpperCase() !== country) continue;
      if (region && airport.isoRegion?.toUpperCase() !== region) continue;

      if (queryTokens.length > 0) {
        const tokens = this.tokensByAirportId.get(airport.id);
        if (!tokens) continue;
        if (!queryTokens.every((t) => hasTokenPrefix(tokens, t))) continue;
        matched.push({ airport, score: scoreAirport(airport, filters.query as string) });
      } else {
        matched.push({ airport, score: scoreAirport(airport, undefined) });
      }
    }

    matched.sort((a, b) => b.score - a.score || a.airport.name.localeCompare(b.airport.name));
    return {
      airports: matched.slice(0, filters.limit).map((m) => m.airport),
      totalMatched: matched.length,
    };
  }

  /**
   * Airports within `radiusKm` of a coordinate, nearest-first by great-circle
   * distance, filtered by type/closed, capped at `limit`. Each carries its
   * distance and bearing from the query point.
   */
  nearbyAirports(
    lat: number,
    lon: number,
    radiusKm: number,
    limit: number,
    type: string | undefined,
    includeClosed: boolean,
  ): AirportWithDistance[] {
    const accept = (i: number): boolean => {
      const id = this.airportCoordIds[i];
      if (id === undefined) return false;
      const airport = this.airportsById.get(id);
      if (!airport) return false;
      if (!includeClosed && airport.type === 'closed') return false;
      if (type && airport.type !== type) return false;
      return true;
    };
    const hits = nearest(this.airportCoords, lat, lon, radiusKm, limit, accept);
    return hits.map((h) => {
      const airport = this.airportsById.get(this.airportCoordIds[h.index] as number) as Airport;
      return {
        airport,
        distanceKm: h.distanceKm,
        bearingDeg: bearingDeg(lat, lon, airport.latitudeDeg, airport.longitudeDeg),
      };
    });
  }

  /**
   * Navaids within `radiusKm` of a coordinate, nearest-first, optionally
   * filtered by navaid type, capped at `limit`.
   */
  nearbyNavaids(
    lat: number,
    lon: number,
    radiusKm: number,
    limit: number,
    type: string | undefined,
  ): NavaidWithDistance[] {
    const accept = (i: number): boolean => {
      if (!type) return true;
      const navaid = this.navaidList[i];
      return navaid?.type === type;
    };
    const hits = nearest(this.navaidCoords, lat, lon, radiusKm, limit, accept);
    return hits.map((h) => {
      const navaid = this.navaidList[h.index] as Navaid;
      return {
        navaid,
        distanceKm: h.distanceKm,
        bearingDeg: bearingDeg(lat, lon, navaid.latitudeDeg, navaid.longitudeDeg),
      };
    });
  }

  /**
   * Navaids associated with an airport ident, optionally filtered by type,
   * capped at `limit`. Returns `[]` when the airport has no associated navaids
   * (the tool distinguishes this from "airport not found").
   */
  navaidsForAirport(ident: string, type: string | undefined, limit: number): Navaid[] {
    const all = this.navaidsByAirportIdent.get(ident.toUpperCase()) ?? [];
    const filtered = type ? all.filter((n) => n.type === type) : all;
    return filtered.slice(0, limit);
  }

  /**
   * Resolve an airport from a code, returning its `ident` (the navaid join key)
   * — used by `find_navaids` airport mode. Throws `notFound` (→ `unknown_code`)
   * when the code matches nothing.
   */
  resolveAirportIdent(code: string): { ident: string; airport: Airport } {
    const resolution = this.resolveByCode(code);
    if (!resolution) {
      throw notFound(
        `No airport found for code "${code}". Try ourairports_search_airports with a partial name or municipality to discover the right code.`,
        { reason: 'unknown_code', code },
      );
    }
    return { ident: resolution.airport.ident, airport: resolution.airport };
  }

  /**
   * List countries present in the dataset (with airport counts), optionally
   * filtered to a continent, optionally with their regions nested.
   */
  listCountries(continent: string | undefined, includeRegions: boolean): CountrySummary[] {
    const cont = continent?.toUpperCase();
    const out: CountrySummary[] = [];

    for (const country of this.countriesByCode.values()) {
      if (cont && country.continent?.toUpperCase() !== cont) continue;
      const summary: CountrySummary = {
        code: country.code,
        name: country.name,
        ...(country.continent && { continent: country.continent }),
        airportCount: this.airportCountByCountry.get(country.code.toUpperCase()) ?? 0,
      };
      if (includeRegions) summary.regions = this.regionsForCountry(country.code);
      out.push(summary);
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private regionsForCountry(countryCode: string): RegionSummary[] {
    const cc = countryCode.toUpperCase();
    const regions: RegionSummary[] = [];
    for (const region of this.regionsByCode.values()) {
      if (region.isoCountry?.toUpperCase() !== cc) continue;
      regions.push({
        code: region.code,
        name: region.name,
        airportCount: this.airportCountByRegion.get(region.code.toUpperCase()) ?? 0,
      });
    }
    regions.sort((a, b) => a.name.localeCompare(b.name));
    return regions;
  }
}

/**
 * Token match allowing forward prefix hits: a query token matches an indexed
 * token it is a prefix of (so "intern" matches "international"). The reverse
 * direction is intentionally absent — a query token must NOT match a shorter
 * indexed token that is merely a prefix of it, or a gibberish query like
 * "xqzzywvu" would match any airport carrying a bare "x" token (#1).
 */
function hasTokenPrefix(haystack: Set<string>, needle: string): boolean {
  if (haystack.has(needle)) return true;
  for (const t of haystack) {
    if (t.startsWith(needle)) return true;
  }
  return false;
}

/**
 * Light relevance score: prefer operational over closed, larger airports over
 * smaller, scheduled-service fields, and exact name/code hits on the query.
 * Transparent ordering criteria — no synthetic composite "confidence".
 */
const TYPE_RANK: Record<string, number> = {
  large_airport: 6,
  medium_airport: 5,
  small_airport: 4,
  seaplane_base: 3,
  heliport: 2,
  balloonport: 1,
  closed: 0,
};

function scoreAirport(airport: Airport, query: string | undefined): number {
  let score = (TYPE_RANK[airport.type] ?? 0) * 10;
  if (airport.scheduledService) score += 5;
  if (query) {
    const q = query.trim().toUpperCase();
    if (airport.iataCode?.toUpperCase() === q || airport.icaoCode?.toUpperCase() === q) score += 50;
    if (airport.name.toUpperCase() === q) score += 30;
    else if (airport.name.toUpperCase().includes(q)) score += 10;
  }
  return score;
}

// --- Init/accessor pattern ---

let _service: AirportDataService | undefined;

/**
 * Construct the service (resolving the data dir from config or the bundled
 * default). Call `load()` on the returned instance during `setup()`.
 */
export function initAirportDataService(_config: AppConfig): AirportDataService {
  const dataDir = getServerConfig().dataDir ?? resolveBundledDataDir();
  _service = new AirportDataService(dataDir);
  return _service;
}

export function getAirportDataService(): AirportDataService {
  if (!_service) {
    throw new Error(
      'AirportDataService not initialized — call initAirportDataService() in setup()',
    );
  }
  return _service;
}
